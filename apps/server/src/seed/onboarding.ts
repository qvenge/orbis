// apps/server/src/seed/onboarding.ts
// Онбординг-сидирование (02 §7): 12 категорий §7.1 + 6 smart lists §7.2 (три исходных, два
// верхних горизонта планирования (E4) и «Рутины» (V1.9)) + настройки §7.3 + глобальный тред
// §7.3. Один раз на пользователя; повтор дублей не создаёт (§7).
//
// РЕШЕНИЕ 6 ПЛАНА: сид пишет НАПРЯМУЮ в tx под withIdentity, МИМО executor и журнала
// действий (§7.8). Обоснование: 15 audit-сообщений при регистрации — это шум в ленте
// чата, а не значимые для пользователя действия; сид — системная инициализация, не
// пользовательская правка. Данные при этом обязаны быть валидны по схемам реестра
// (тест сверяет каждую категорию с categoryAspectSchema).
//
// ИДЕМПОТЕНТНОСТЬ — два слоя:
//   1. Guard по существованию user_settings (SELECT … FOR UPDATE): повторный вызов
//      возвращает { seeded: false } без записей.
//   2. Детерминированные id категорий/списков (uuidv5) + ON CONFLICT DO NOTHING на всех
//      вставках — страховка от гонки двух устройств/вкладок поверх guard'а: конкурентная
//      вставка тем же PK блокируется на неподтверждённой строке и гасится конфликтом
//      (§5.4), дубль невозможен по построению.
import { ORBIS_NAMESPACE } from '@orbis/shared';
import { queryRefsFromDoc, readBodyDoc } from '@orbis/shared/doc';
import { type SQL, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { ensureGlobalThread } from '../chat/threads';
import type { Db } from '../db/client';
import { entities, userSettings } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { bodyFieldsFromMarkdown } from '../executor/body-fields';
import { rowFromLegacy } from '../executor/legacy-form';
import { effectiveRegistry, parseRegistryOfSnapshot } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import { SEED_CATEGORIES } from './categories';
import { seedGardener } from './gardener';
import {
  ROUTINES_BATCH_QUERY,
  SEED_HORIZON_LISTS,
  SEED_ROUTINES_LIST,
  SEED_SMART_LISTS,
  type SeedSmartList,
} from './smart-lists';

// Формулы seed-слагов — серверная деталь (НЕ в shared): id порождается от owner_id
// (workspace-scoped при введении workspace'ов, D11) и стабильного слага. uuid-библиотека
// принимает (name, namespace) — обратный порядок к нотации PRD uuidv5(NS, name).
export function seedCategoryId(ownerId: string, slug: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:seed-category:${slug}`, ORBIS_NAMESPACE);
}

export function seedSmartListId(ownerId: string, slug: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:seed-smartlist:${slug}`, ORBIS_NAMESPACE);
}

// Первый устанавливаемый view (01-arch §4.4, 03-budget §1): вкладка Budget в web
// включается по наличию этого id в installedViews. Серверная деталь — не в shared.
export const BUDGET_VIEW_ID = 'orbis-budget';

// Единственный горизонт, попадающий в сайдбар (E4): «Жизнь» ищется в Browser по тегу
// smart-list. Закрепление не бесплатно — у каждой pinned-сущности web держит entity.get +
// entity.count, и count пересчитывается на КАЖДОЙ инвалидации графа; «Год» этого стоит
// (цели — то, ради чего фаза существует), периодическая ревизия «Жизни» — нет.
const PINNED_HORIZON_SLUG = 'horizon-year';

/** Свойство, которым адресуется «пачка решений» (D42) — признак бэкфилла тела «Рутин». */
const PROP_UNDECIDED = 'orbis/undecided';

/**
 * `ARRAY[$1, $2]::text[]` — каждый элемент параметром: массив JS шаблон `sql` drizzle
 * разворачивает в кортеж `($1,…,$N)`, а `record` к `text[]` не приводится.
 */
function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

export interface SeedResult {
  seeded: boolean; // false — уже было (одноразовость §7)
}

/**
 * ПОЛНЫЙ сид владельца — единственная точка входа боевой ручки `user.seedOnboarding`.
 *
 * Он двухфазный, и фазы РАЗНЫЕ по природе, а не просто «две части одного цикла»:
 *   1. граф онбординга (12 категорий → 6 смарт-листов → настройки → глобальный тред) —
 *      ОДНОЙ транзакцией, прямыми вставками мимо исполнителя (решение 6, см. шапку файла);
 *   2. садовник словаря (§А2-7, Р17) — ОТДЕЛЬНОЙ транзакцией ЧЕРЕЗ исполнителя, потому что
 *      он несёт доверенность рутины и обязан пройти валидатор реестра (см. `seed/gardener.ts`).
 *
 * ПОЧЕМУ ДВЕ ТРАНЗАКЦИИ, А НЕ ОДНА. `seedOnboarding` первым делом берёт `FOR UPDATE` на
 * строке настроек, а `execute` открывает СВОЮ транзакцию на другом соединении: вложив второе
 * в первое, мы получили бы дедлок на первом же заходе владельца. Разрыв атомарности при этом
 * ничего не ломает — вторая фаза идемпотентна пробой по PK и досевается следующим заходом
 * (докблок `seedGardener`).
 *
 * ПОРЯДОК ФАЗ ЗНАЧИМ: садовник — рутина, и в смарт-листе «Рутины» он должен появиться уже
 * при первом открытии сайдбара; список сеется первой фазой, поэтому садовник идёт после неё.
 *
 * `SeedResult` отвечает про ПЕРВУЮ фазу («онбординг проходил?») и намеренно не превращается
 * в счётчик: `seeded: false` с досеянным садовником — это законный и ожидаемый исход
 * повторного захода, а не расхождение.
 */
export async function seedOwner(
  db: Db,
  ownerId: string,
  clock: () => Date = () => new Date(),
): Promise<SeedResult> {
  const result = await withIdentity(db, ownerId, (tx) => seedOnboarding(tx, ownerId, clock));
  await seedGardener(db, ownerId, clock);
  return result;
}

/**
 * ПЕРВАЯ ФАЗА сида: граф онбординга внутри УЖЕ ОТКРЫТОЙ транзакции. clock инъектируется для
 * детерминизма тестов; created_at/updated_at сущностей и настроек — clock() (тред получает
 * defaultNow БД).
 *
 * ЭТО НЕ «ВЕСЬ СИД» — с Задачи 17 полный сид владельца зовётся `seedOwner` (см. её докблок),
 * и боевая ручка идёт только через неё. Прямой вызов остаётся законным ровно для фикстур,
 * которым нужен граф без садовника (`test/perf.ts` и сьюты, где рутина только мешала бы), —
 * но «засидил владельца» он больше не означает.
 */
export async function seedOnboarding(
  tx: Tx,
  ownerId: string,
  clock: () => Date = () => new Date(),
): Promise<SeedResult> {
  const now = clock();
  // Реестр снимается ДО guard'а: он нужен обеим ветвям — и первому севу (проекция категорий,
  // тела смарт-листов), и бэкфиллам, которые из guard'а и выходят. Единственный адрес вызова
  // `effectiveRegistry` в этом файле сохраняется — счёт читателей в докблоке `registry/cache.ts`
  // ведётся грепом, и второй вызов сделал бы его ложным.
  const reg = await effectiveRegistry(tx, ownerId);

  // Слой 1: guard. FOR UPDATE блокирует существующую строку настроек (защита от гонки с
  // updateSettings); если строки нет — идём сидировать, конкуренцию закрывает слой 2.
  const guard = await tx.execute(
    sql`SELECT 1 FROM user_settings WHERE owner_id = ${ownerId} FOR UPDATE`,
  );
  if (guard.length > 0) {
    // Бэкфилл A9 (§4.4): пользователь, засиденный ДО слайса 2, мог не иметь orbis-budget.
    // Идемпотентно дописываем под уже взятой FOR UPDATE-блокировкой — array_append только
    // при отсутствии (NOT … = ANY): повтор не дублирует, кастомные значения не теряются,
    // прочие поля настроек не трогаются (updated_at сдвигается лишь при фактической правке,
    // чтобы web-синк LWW увидел новый view).
    await tx.execute(
      sql`UPDATE user_settings
          SET "installedViews" = array_append("installedViews", ${BUDGET_VIEW_ID}),
              updated_at = ${now.toISOString()}::timestamptz
          WHERE owner_id = ${ownerId}
            AND NOT (${BUDGET_VIEW_ID} = ANY("installedViews"))`,
    );
    await backfillHorizons(tx, ownerId, reg, now);
    await backfillRoutinesList(tx, ownerId, reg, now);
    // Порядок не случаен, хотя оба и сходятся к одному: досев выше вставляет
    // отсутствующий список УЖЕ с новым телом, и условный UPDATE на него не срабатывает по
    // условию. В обратном порядке UPDATE зря шёл бы по ещё не созданной строке
    await backfillRoutinesListBody(tx, ownerId, reg, now);
    return { seeded: false };
  }

  // 12 категорий §7.1 — сущности с аспектом orbis/category; spend_class у доходных
  // ОТСУТСТВУЕТ (не null — иначе ajv-валидация упала бы при будущих правках, §3.6).
  // Строка пишется в ТРЁХ колонках (§А1-1): новая правда (`props` по id свойства и список
  // `aspects`) и старая карта, которую пока читают доменные модули и web. Через одну
  // проекцию, а не двумя литералами: разъехавшиеся формы одной и той же категории —
  // это молчаливое расхождение, которое нашлось бы уже на чужом красном тесте.
  const categoryRows = SEED_CATEGORIES.map((c) => ({
    id: seedCategoryId(ownerId, c.slug),
    ownerId,
    title: c.title,
    tags: ['category'],
    ...rowFromLegacy(reg, {
      'orbis/category': {
        icon: c.icon,
        color: c.color,
        aliases: [...c.aliases],
        ...(c.spendClass ? { spend_class: c.spendClass } : {}),
      },
    }),
    createdAt: now,
    updatedAt: now,
  }));

  // 6 smart lists §7.2 — сущности с тегом smart-list и body-query-блоками (§3.3): три
  // исходных, два верхних горизонта планирования, «Год» и «Жизнь» (E4), и «Рутины» (V1.9).
  const smartListRows = SEED_SMART_LISTS.map((s) => smartListRow(ownerId, s, reg, now));

  // Одна вставка на все 18 сущностей: детерминированный порядок id снимает риск взаимной
  // блокировки конкурентных сидов (обе транзакции блокируются на первой общей строке).
  await tx
    .insert(entities)
    .values([...categoryRows, ...smartListRows])
    .onConflictDoNothing();

  // Настройки §7.3 — дефолты; pinnedEntities в порядке daily/upcoming/allTasks/«Год»/
  // «Рутины» (§7.2, §4.4). Из двух горизонтов закреплён ТОЛЬКО «Год»: закреплённая сущность
  // стоит entity.count на каждую инвалидацию графа (web, lib/invalidate.ts), а «Жизнь»
  // открывают раз в год — её находит Browser по тегу smart-list. «Рутины» закрепляются:
  // их бейдж — счётчик вопросов, на которые владелец ещё не ответил (§3.2).
  await tx
    .insert(userSettings)
    .values({
      ownerId,
      plan: 'dev',
      timezone: 'Europe/Moscow',
      defaultCurrency: 'RUB',
      weekStartDay: 'monday',
      installedViews: [BUDGET_VIEW_ID], // §4.4: Budget — стартовый установленный view
      pinnedEntities: [
        { id: seedSmartListId(ownerId, 'daily-planning'), order: 0 },
        { id: seedSmartListId(ownerId, 'upcoming'), order: 1 },
        { id: seedSmartListId(ownerId, 'all-tasks'), order: 2 },
        { id: seedSmartListId(ownerId, PINNED_HORIZON_SLUG), order: 3 },
        { id: seedSmartListId(ownerId, SEED_ROUTINES_LIST.slug), order: 4 },
      ],
      updatedAt: now,
    })
    .onConflictDoNothing();

  // Глобальный тред §7.3 — детерминированный id, ensure идемпотентен (§4.5)
  await ensureGlobalThread(tx, ownerId);

  return { seeded: true };
}

/**
 * Строка сущности smart list'а — одна форма для первого сида и для бэкфилла.
 *
 * ЧЕТЫРЕ КОЛОНКИ ТЕЛА, А НЕ ОДНА, и считает их тот же `bodyFieldsFromMarkdown`, что и
 * исполнитель. До этой задачи сид писал только `body`, и цена была не косметической:
 * `query_refs` смарт-листов оставались пустыми навсегда (чтение документ собирает, но в БД
 * не пишет), а именно по этой колонке ищет держателей свойства `collectPropertyHolders` —
 * то есть слияние и проба §А10-3 не видели бы ШЕСТЬ главных держателей владельца.
 * Заодно отпадает и ленивая конверсия: `body_doc` у сидированной строки есть с первой
 * секунды, и предикат бэкфилла может спрашивать документ, а не сравнивать байты.
 *
 * `body` берётся ИЗ КОНВЕРТЕРА, а не из константы: расхождение между литералом сида и его
 * каноном ловит `seed-canon.test.ts`, но если оно всё же появится, в базу обязан лечь канон
 * — иначе первое сохранение из редактора сдвинуло бы тело, и «сид не переписывает чужое»
 * сработало бы против самого сида.
 */
function smartListRow(ownerId: string, list: SeedSmartList, reg: RegistrySnapshot, now: Date) {
  const fields = bodyFieldsFromMarkdown(list.body, reg);
  return {
    id: seedSmartListId(ownerId, list.slug),
    ownerId,
    title: list.title,
    emoji: list.emoji,
    body: fields.body,
    bodyDoc: fields.bodyDoc,
    bodyRefs: fields.bodyRefs,
    queryRefs: fields.queryRefs,
    tags: ['smart-list'],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Бэкфилл E4 (§7.2): пользователь, засиденный ДО слайса 3, не имеет горизонтов «Год» и
 * «Жизнь». Guard-ветка выходит из сида ДО всех вставок, поэтому «просто повторить
 * сидирование» их не досеет — нужен явный бэкфилл, как у orbis-budget (A9).
 *
 * ПОЧЕМУ СВОЙ НАБОР, А НЕ ОБЩИЙ SEED_SMART_LISTS. Бэкфилл досевает ровно то, что добавила
 * ЭТА миграция, а не «всё, чего не хватает»: общий проход воскрешал бы Daily Planning или
 * All Tasks, удалённые пользователем осознанно, — сид не отличает «никогда не было» от
 * «удалено». Цена — следующему сидированному списку понадобится такой же адресный бэкфилл
 * (третья копия механизма); это осознанный размен на неприкосновенность чужих удалений.
 *
 * Идемпотентность: id горизонтов детерминированы (uuidv5 от слага), ON CONFLICT DO NOTHING
 * гасит повтор и НЕ перетирает тело, если пользователь правил список; закрепление «Года»
 * дописывается только при отсутствии его id в pinnedEntities — правила вставки пина и его
 * цена описаны у pinIfAbsent. Повторные запуски не плодят ни сущностей, ни строк сайдбара, а
 * кастомные закрепления и прочие поля настроек остаются нетронутыми.
 *
 * Цена решения — ДВЕ формы отката, которые сид не переживает: удалённый пользователем
 * горизонт следующий вызов сидирования воскресит, а откреплённый «Год» вернёт в сайдбар
 * (containment не отличает «никогда не закрепляли» от «открепили»). Ровно то же поведение,
 * что у бэкфилла orbis-budget. Сидирование зовётся раз за сессию (OnboardingGate);
 * «удалить/открепить навсегда» здесь не выражается, а UI открепления сегодня и нет (02 §3.2).
 */
async function backfillHorizons(
  tx: Tx,
  ownerId: string,
  reg: RegistrySnapshot,
  now: Date,
): Promise<void> {
  await tx
    .insert(entities)
    .values(SEED_HORIZON_LISTS.map((list) => smartListRow(ownerId, list, reg, now)))
    .onConflictDoNothing();

  await pinIfAbsent(tx, ownerId, seedSmartListId(ownerId, PINNED_HORIZON_SLUG), now);
}

/**
 * Бэкфилл V1 (§7.2): владелец, засиденный ДО «Рутин», не имеет шестого списка. Механика —
 * ровно та же, что у горизонтов (адресный набор, детерминированный id, ON CONFLICT DO
 * NOTHING, пин в конец), и та же цена: удалённый владельцем список следующее сидирование
 * воскресит, открепление — вернёт в сайдбар.
 *
 * ПОЧЕМУ ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ ПУНКТ В backfillHorizons. Разное «что досеваем» — разные
 * функции: горизонты приехали в слайсе 3, «Рутины» в V1, и общий проход по SEED_SMART_LISTS
 * воскрешал бы Daily Planning или All Tasks, удалённые владельцем осознанно (сид не
 * отличает «никогда не было» от «удалено»). Общего у двух досевов ровно одно — вставка пина,
 * и она вынесена в pinIfAbsent, чтобы третья копия jsonb-SQL не разъехалась с первыми двумя.
 */
async function backfillRoutinesList(
  tx: Tx,
  ownerId: string,
  reg: RegistrySnapshot,
  now: Date,
): Promise<void> {
  await tx
    .insert(entities)
    .values([smartListRow(ownerId, SEED_ROUTINES_LIST, reg, now)])
    .onConflictDoNothing();

  await pinIfAbsent(tx, ownerId, seedSmartListId(ownerId, SEED_ROUTINES_LIST.slug), now);
}

/**
 * Бэкфилл D42 (§7.2, §3.3): у владельца, засиденного ДО «Пачки решений», тело «Рутин»
 * двухблочное, и третьего блока он не увидит никогда — сущность уже есть, а ON CONFLICT DO
 * NOTHING соседнего досева тела не трогает. Значит нужен UPDATE, и это единственный UPDATE
 * по таблице `entities` во всём сиде.
 *
 * ПРИЗНАК — «БЛОКА ПАЧКИ В ТЕЛЕ НЕТ», а не побайтовое равенство со старым сидом (§А12-3), и
 * замена признака — не упрощение. Байтовое сравнение требовало ЗАМОРОЖЕННОЙ КОПИИ каждой
 * пройденной формы тела рядом с сидом («править нельзя никогда, даже вслед за правкой
 * сида»), и первая же смена формы запроса — вот эта, перевод сидов в key-форму, — сделала бы
 * такую копию неотличимой от опечатки: тело владельца написано старой грамматикой, новый сид
 * — печатью канона, и совпасть они не могут ни при какой правке литерала. Признак «блок уже
 * есть» переживает смену формы, потому что спрашивает не текст, а АДРЕС свойства в дереве.
 *
 * СПРАШИВАЕТСЯ ДОКУМЕНТ, А НЕ КОЛОНКА `query_refs`. Колонка — денормализация, и у владельца,
 * засиденного до того, как сид начал её писать, она пуста при живом теле; `readBodyDoc`
 * собирает документ из `body`, когда `body_doc` пуст, и привязывает блоки реестром — то есть
 * отвечает на вопрос по тому, что у владельца ЕСТЬ, а не по тому, что мы надеялись записать.
 *
 * ТЕЛО ДОПИСЫВАЕТСЯ, А НЕ ПЕРЕЗАПИСЫВАЕТСЯ. Тело смарт-листа — обычная запись: владелец
 * вправе дописать в неё свой блок, свой текст, свои заметки (§3.3 прямо говорит, что систему
 * преднастроенные сущности не «защищают»). Перезапись уничтожила бы его работу без следа и
 * без возможности восстановления — версий у мимо-executor'ного сида нет.
 *
 * ИДЕМПОТЕНТНОСТЬ — построением, без флага и без счётчика: после дописывания блок в теле
 * есть, и условие больше не выполняется ни разу. `updated_at` двигается только при
 * фактической правке — иначе web-синк LWW дёргал бы список на каждом старте сессии.
 *
 * ЦЕНА, та же что у горизонтов: владелец, который стёр третий блок руками, получит его
 * назад — но ровно один раз и в конец тела, а не на прежнее место.
 */
async function backfillRoutinesListBody(
  tx: Tx,
  ownerId: string,
  reg: RegistrySnapshot,
  now: Date,
): Promise<void> {
  const id = seedSmartListId(ownerId, SEED_ROUTINES_LIST.slug);
  const rows = (await tx.execute(sql`
    SELECT body, body_doc FROM entities
     WHERE id = ${id}::uuid AND owner_id = ${ownerId} FOR UPDATE`)) as unknown as Array<{
    body: string | null;
    body_doc: unknown;
  }>;
  const row = rows[0];
  if (row === undefined) return;

  const body = String(row.body ?? '');
  const doc = readBodyDoc(row.body_doc ?? null, body, parseRegistryOfSnapshot(reg));
  // Адрес свойства «отложено» в ЛЮБОМ блоке тела — и есть «пачка уже показана». Спрашивается
  // именно адрес: заголовок блока владелец вправе переписать, а свойство — нет.
  if (queryRefsFromDoc(doc).includes(PROP_UNDECIDED)) return;

  const next = bodyFieldsFromMarkdown(`${body}\n\n{{query:${ROUTINES_BATCH_QUERY}}}`, reg);
  await tx.execute(sql`
    UPDATE entities
       SET body = ${next.body},
           body_doc = ${JSON.stringify(next.bodyDoc)}::jsonb,
           body_refs = ${textArray(next.bodyRefs)},
           query_refs = ${textArray(next.queryRefs)},
           updated_at = ${now.toISOString()}::timestamptz
     WHERE id = ${id}::uuid AND owner_id = ${ownerId}`);
}

/**
 * Закрепление сущности в сайдбаре, если её там ещё нет. Отсутствие проверяется
 * jsonb-containment по ОДНОМУ ключу `id` — порядковый номер значения при этом не важен, и
 * пин, который владелец успел перетащить, повтором не задваивается. `order` нового пина —
 * max(order)+1, а НЕ длина массива: после открепления в номерах остаются дыры ([0, 7] —
 * длина 2), и по длине новый пин встал бы в СЕРЕДИНУ сайдбара. updated_at сдвигается только
 * при фактической вставке — иначе web-синк LWW дёргался бы на каждом старте сессии.
 */
async function pinIfAbsent(tx: Tx, ownerId: string, pinId: string, now: Date): Promise<void> {
  await tx.execute(
    sql`UPDATE user_settings
        SET "pinnedEntities" = "pinnedEntities" || jsonb_build_array(
              jsonb_build_object('id', ${pinId}::text, 'order',
                COALESCE(
                  (SELECT max((p->>'order')::int) FROM jsonb_array_elements("pinnedEntities") p),
                  -1
                ) + 1)
            ),
            updated_at = ${now.toISOString()}::timestamptz
        WHERE owner_id = ${ownerId}
          AND NOT ("pinnedEntities" @> jsonb_build_array(jsonb_build_object('id', ${pinId}::text)))`,
  );
}
