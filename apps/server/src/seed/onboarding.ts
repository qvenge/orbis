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
import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { ensureGlobalThread } from '../chat/threads';
import { entities, userSettings } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { rowFromLegacy } from '../executor/legacy-form';
import { loadRegistry } from '../registry/load';
import { SEED_CATEGORIES } from './categories';
import {
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

export interface SeedResult {
  seeded: boolean; // false — уже было (одноразовость §7)
}

/**
 * Сидирование стартового набора владельца. Вызывается роутером user.seedOnboarding и
 * переиспользуется 1c при первом логине. clock инъектируется для детерминизма тестов;
 * created_at/updated_at сущностей и настроек — clock() (тред получает defaultNow БД).
 */
export async function seedOnboarding(
  tx: Tx,
  ownerId: string,
  clock: () => Date = () => new Date(),
): Promise<SeedResult> {
  const now = clock();

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
    await backfillHorizons(tx, ownerId, now);
    await backfillRoutinesList(tx, ownerId, now);
    // Порядок не случаен, хотя оба и сходятся к одному: досев выше вставляет
    // отсутствующий список УЖЕ с новым телом, и условный UPDATE на него не срабатывает по
    // условию. В обратном порядке UPDATE зря шёл бы по ещё не созданной строке
    await backfillRoutinesListBody(tx, ownerId, now);
    return { seeded: false };
  }

  // 12 категорий §7.1 — сущности с аспектом orbis/category; spend_class у доходных
  // ОТСУТСТВУЕТ (не null — иначе ajv-валидация упала бы при будущих правках, §3.6).
  // Строка пишется в ТРЁХ колонках (§А1-1): новая правда (`props` по id свойства и список
  // `aspects`) и старая карта, которую пока читают доменные модули и web. Через одну
  // проекцию, а не двумя литералами: разъехавшиеся формы одной и той же категории —
  // это молчаливое расхождение, которое нашлось бы уже на чужом красном тесте.
  const reg = await loadRegistry(tx, ownerId);
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
  const smartListRows = SEED_SMART_LISTS.map((s) => smartListRow(ownerId, s, now));

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

/** Строка сущности smart list'а — одна форма для первого сида и для бэкфилла. */
function smartListRow(ownerId: string, list: SeedSmartList, now: Date) {
  return {
    id: seedSmartListId(ownerId, list.slug),
    ownerId,
    title: list.title,
    emoji: list.emoji,
    body: list.body,
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
async function backfillHorizons(tx: Tx, ownerId: string, now: Date): Promise<void> {
  await tx
    .insert(entities)
    .values(SEED_HORIZON_LISTS.map((list) => smartListRow(ownerId, list, now)))
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
async function backfillRoutinesList(tx: Tx, ownerId: string, now: Date): Promise<void> {
  await tx
    .insert(entities)
    .values([smartListRow(ownerId, SEED_ROUTINES_LIST, now)])
    .onConflictDoNothing();

  await pinIfAbsent(tx, ownerId, seedSmartListId(ownerId, SEED_ROUTINES_LIST.slug), now);
}

/**
 * ЗАМОРОЖЕННАЯ ИСТОРИЯ: тело «Рутин» ДО третьего блока «Пачка решений» (D42) — двухблочное,
 * ровно как его получили владельцы V1. Литерал живёт здесь, а не в `smart-lists.ts`, потому
 * что это не сид, а образец для сверки: `smart-lists.ts` отвечает на вопрос «что мы сеем
 * сегодня», а этот файл — «что мы вправе переписать».
 *
 * ПРАВИТЬ ЕГО НЕЛЬЗЯ НИКОГДА, даже вслед за правкой сида: сравнение идёт БАЙТ-В-БАЙТ, и
 * подогнанный под новый сид литерал перестанет совпадать с тем, что лежит у владельца, —
 * бэкфилл молча выключится. Следующий блок в теле «Рутин» потребует не правки этой строки, а
 * ВТОРОЙ такой же константы рядом (по одной на каждую пройденную форму тела).
 *
 * Экспортирован ради теста бэкфилла: сымитировать владельца «до D42» можно только этим
 * телом, а второй его копией в тесте они разъехались бы при первой же опечатке.
 */
export const ROUTINES_LIST_BODY_BEFORE_BATCH = `Рутины — то, что Orbis делает сам по расписанию, и то, что ждёт вашего ответа.

{{query: aspect=orbis/agent-run, outcome=checkpoint, sortBy=started_at:asc, display=list, title=Ждут ответа}}

{{query: aspect=orbis/routine, stage=active, sortBy=updated_at:desc, display=list, title=Активные рутины}}`;

/**
 * Бэкфилл D42 (§7.2, §3.3): у владельца, засиденного ДО «Пачки решений», тело «Рутин»
 * двухблочное, и третьего блока он не увидит никогда — сущность уже есть, а ON CONFLICT DO
 * NOTHING соседнего досева тела не трогает. Значит нужен UPDATE, и это ПЕРВЫЙ UPDATE по
 * таблице `entities` во всём сиде: до сих пор сид только вставлял.
 *
 * УСЛОВИЕ — БАЙТ-В-БАЙТ СОВПАДЕНИЕ СО СТАРЫМ СИДОМ, и это главное здесь. Тело смарт-листа
 * — обычная запись: владелец вправе дописать в неё свой блок, свой текст, свои заметки
 * (§3.3 прямо говорит, что система преднастроенные сущности не «защищает»). Перезапись
 * такого тела уничтожила бы его работу без следа и без возможности восстановления — версий
 * у мимо-executor'ного сида нет. Поэтому правило то же, что у остальных досевов («сид не
 * переписывает чужое», докблок `backfillHorizons`), только выраженное сравнением, а не
 * ON CONFLICT: трогаем ровно ту строку, которую сами и написали, и ни одну другую.
 *
 * `body_doc = NULL` — ленивая переконверсия: структурная правда тела (`readBodyDoc`)
 * описывала бы ДВА блока, и оставленный документ показал бы владельцу старое тело поверх
 * нового markdown'а. NULL означает «ещё не сконвертировано» (docblock колонки), и первый же
 * читатель соберёт документ заново из `body`. `body_before_doc` не трогается: это снимок
 * ДО разовой конверсии, а не «предыдущее тело».
 *
 * ИДЕМПОТЕНТНОСТЬ — построением, без флага и без счётчика: после первого UPDATE тело равно
 * НОВОМУ сиду, условие `body = <старый>` больше не выполняется ни разу.
 *
 * `updated_at` двигается только при фактической правке (UPDATE либо задел строку, либо нет)
 * — иначе web-синк LWW дёргал бы список на каждом старте сессии.
 *
 * ЦЕНА, та же что у горизонтов: владелец, который стёр третий блок руками, получит его
 * назад — но ровно один раз, и только если стёр ТОЧНО до старого сида. Любая другая правка
 * тело сохраняет.
 */
async function backfillRoutinesListBody(tx: Tx, ownerId: string, now: Date): Promise<void> {
  await tx.execute(
    sql`UPDATE entities
        SET body = ${SEED_ROUTINES_LIST.body},
            body_doc = NULL,
            updated_at = ${now.toISOString()}::timestamptz
        WHERE id = ${seedSmartListId(ownerId, SEED_ROUTINES_LIST.slug)}::uuid
          AND owner_id = ${ownerId}
          AND body = ${ROUTINES_LIST_BODY_BEFORE_BATCH}`,
  );
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
