// apps/server/src/seed/onboarding.ts
// Онбординг-сидирование (02 §7): 12 категорий §7.1 + 6 smart lists §7.2 (три исходных, два
// верхних горизонта планирования (E4) и «Рутины» (V1.9)) + настройки §7.3 + глобальный тред
// §7.3. Один раз на пользователя; повтор дублей не создаёт (§7).
//
// ГРАФ МИРА СЮДА БОЛЬШЕ НЕ ПИШЕТСЯ. 12 категорий и 6 смарт-листов первого сева уехали в
// `seed/world.ts` и идут ЧЕРЕЗ ИСПОЛНИТЕЛЯ (обещание PRD «19 сущностей через исполнителя»);
// здесь остались настройки, глобальный тред и АДРЕСНЫЕ досевы (горизонты E4, «Рутины» V1.9,
// тело «Рутин» D42), у каждого из которых свой набор и свой довод — см. их докблоки.
//
// РЕШЕНИЕ 6 ПЛАНА в силе и после переезда: журнала у сева нет (`execute` зовётся без синка).
// Обоснование то же — 15 audit-сообщений при регистрации это шум в ленте чата, а не
// значимые для владельца действия; сид — системная инициализация, не правка.
//
// ИДЕМПОТЕНТНОСТЬ — два слоя:
//   1. Guard по существованию user_settings (SELECT … FOR UPDATE): повторный вызов
//      возвращает { seeded: false } без записей.
//   2. Детерминированные id категорий/списков (uuidv5) + ON CONFLICT DO NOTHING на всех
//      вставках — страховка от гонки двух устройств/вкладок поверх guard'а: конкурентная
//      вставка тем же PK блокируется на неподтверждённой строке и гасится конфликтом
//      (§5.4), дубль невозможен по построению.
import { type BodyDoc, queryRefsFromDoc, readBodyDoc } from '@orbis/shared/doc';
import { maskQuotedValues } from '@orbis/shared/query';
import type { JSONContent } from '@tiptap/core';
import { type SQL, sql } from 'drizzle-orm';
import { ensureGlobalThread } from '../chat/threads';
import type { Db } from '../db/client';
import { entities, userSettings } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { bodyFieldsFromMarkdown } from '../executor/body-fields';
import { effectiveRegistry, parseRegistryOfSnapshot } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import { seedGardener } from './gardener';
import {
  ROUTINES_BATCH_QUERY,
  SEED_HORIZON_LISTS,
  SEED_ROUTINES_LIST,
  type SeedSmartList,
} from './smart-lists';
import { seedOwnerWorld, seedSmartListId } from './world';

// Формулы seed-слагов живут в `seed/world.ts` — там же, где мир, который они адресуют.
// Реэкспорт сохранён: по этим именам их зовут ручка, бэкфиллы и сьюты.
export { seedCategoryId, seedSmartListId } from './world';

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
 * То же свойство В ТЕКСТЕ НЕРАЗОБРАННОГО блока — по имени поля, в позиции поля.
 *
 * Две формы намеренно: `orbis/undecided=` пишет key-форма канона, голое `undecided=` —
 * старая грамматика §6.1, которой написано тело у владельца в проде (D42). Требуется `=`
 * СРАЗУ ЗА ИМЕНЕМ: слово в подписи блока адресом не является. Кавычки снимает
 * `maskQuotedValues` у вызывающего — регулярка их не знает.
 */
const BATCH_IN_TEXT_RE = /(?:^|[^\w/-])(?:orbis\/)?undecided\s*=/;

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
 * Он ТРЁХФАЗНЫЙ, и фазы разные по природе, а не «части одного цикла»:
 *   1. граф мира (12 категорий → 6 смарт-листов) — ОДНОЙ пачкой ЧЕРЕЗ исполнитель
 *      (`seed/world.ts`, рулинг Р-17-1: с «Пересева мира» прямых вставок графа больше нет);
 *   2. настройки и глобальный тред — своей транзакцией (`seedOnboarding`): это не сущности
 *      графа, и у исполнителя их нет;
 *   3. садовник словаря (§А2-7, Р17) — ОТДЕЛЬНОЙ транзакцией через исполнитель, потому что
 *      он несёт доверенность рутины и обязан пройти валидатор реестра (см. `seed/gardener.ts`).
 *
 * ПОЧЕМУ ТРИ ТРАНЗАКЦИИ, А НЕ ОДНА. `seedOnboarding` первым делом берёт `FOR UPDATE` на
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
  // ПОРЯДОК: мир → настройки → садовник; довод по первой стрелке — в `seedOwnerGraph`.
  const result = await seedOwnerGraph(db, ownerId, clock);
  // Садовник — 19-я сущность мира и ЕДИНСТВЕННАЯ, которую сеют всегда: у неё своя проба по
  // PK и своя роль досева для владельцев, засиденных до V1 (см. `seed/gardener.ts`).
  await seedGardener(db, ownerId, clock);
  return result;
}

/**
 * Мир и настройки владельца БЕЗ садовника — 18 сущностей вместо 19.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ВХОД. С переездом графа в `seed/world.ts` «засеять владельца» перестало
 * помещаться в одну транзакцию: `execute` открывает свою (Р-17-1), а `seedOnboarding`
 * работает внутри уже открытой. Прямой вызов `seedOnboarding` теперь даёт настройки и тред
 * БЕЗ графа — форму, которой в бою не бывает, и фикстуре она не нужна. Нужна ровно эта:
 * полный мир владельца минус рутина-садовник, которая в чужом сьюте только шумит
 * (`test/perf.ts`, гейт бюджета, импорт).
 *
 * ПОРЯДОК: мир → настройки, и стрелка существенна. Строка `user_settings` — маркер
 * «онбординг прошёл», по ней стоит guard `seedOnboarding`; появись она раньше графа, упавший
 * сев мира остался бы незамеченным навсегда.
 *
 * СЕВ МИРА ИДЁТ БЕЗУСЛОВНО, БЕЗ GUARD'А ПО СТРОКЕ НАСТРОЕК (рулинг Р-24-6). Прежде вопрос
 * «свежий ли владелец» задавался по `user_settings`, а `db/reset-world.ts` эту строку
 * СОХРАНЯЕТ (в ней гранты-независимые настройки и пины) — и пересев оставлял владельца с
 * маркером и без мира: заход после операции досевал четыре сущности вместо девятнадцати,
 * а три пина в сайдбаре указывали на снесённые id. Правильный вопрос здесь — не «онбординг
 * уже был?», а «эта сущность уже есть?», и на него отвечает сам `seedOwnerWorld` пробой по
 * PK (Р-17-1): повторный заход даёт `{created: 0, skipped: 18}`. Пины при этом сходятся
 * сами — id мира детерминированы (`seedCategoryId`/`seedSmartListId` от owner + слаг).
 *
 * ЦЕНА, НАЗВАННАЯ ВСЛУХ: сущность мира, СНЕСЁННУЮ владельцем физически, следующий заход
 * заведёт заново — сид по-прежнему не отличает «никогда не было» от «удалил осознанно».
 * Выброшено это в пользу пересева: физического удаления сущности в продукте нет вовсе
 * (владелец архивирует), а `reset-world` — штатная операция регламента.
 */
export async function seedOwnerGraph(
  db: Db,
  ownerId: string,
  clock: () => Date = () => new Date(),
): Promise<SeedResult> {
  await seedOwnerWorld(db, ownerId, { clock });
  return withIdentity(db, ownerId, (tx) => seedOnboarding(tx, ownerId, clock));
}

/**
 * ПЕРВАЯ ФАЗА сида: граф онбординга внутри УЖЕ ОТКРЫТОЙ транзакции. clock инъектируется для
 * детерминизма тестов; created_at/updated_at сущностей и настроек — clock() (тред получает
 * defaultNow БД).
 *
 * ЭТО НЕ «ВЕСЬ СИД» и даже не весь ГРАФ. Полный сид владельца — `seedOwner`, мир без
 * садовника — `seedOwnerGraph`; здесь остались только настройки, глобальный тред и адресные
 * досевы. Графа мира здесь нет с «Пересева мира»: его сеет `seed/world.ts` через
 * исполнитель, отдельной транзакцией, и вызывать его отсюда нельзя (Р-17-1). Прямой вызов
 * этой функции законен ровно там, где нужны настройки БЕЗ графа, — а таких мест нет:
 * фикстурам нужен `seedOwnerGraph`.
 */
export async function seedOnboarding(
  tx: Tx,
  ownerId: string,
  clock: () => Date = () => new Date(),
): Promise<SeedResult> {
  const now = clock();
  // Реестр нужен ТОЛЬКО ветви досевов: тела смарт-листов там собирает `smartListRow`
  // (`bodyFieldsFromMarkdown` по снимку). Первому севу он здесь не нужен вовсе — мир
  // владельца сеет `seed/world.ts` через исполнитель, и снимок берёт он сам.
  //
  // Снимается всё же ДО guard'а, а не внутри ветви: `effectiveRegistry` зовётся из этого
  // файла ровно ОДИН раз, и счёт читателей в докблоке `registry/cache.ts` ведётся грепом —
  // второй вызов сделал бы его ложным. Цена — один лишний снимок на первом заходе владельца.
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

  // Графа здесь НЕТ: 12 категорий и 6 смарт-листов первого сева сеет `seedOwnerWorld` через
  // исполнитель, ДО этой транзакции (см. докблок `seedOwner`). Ниже — только настройки и
  // тред, то есть то, чего у исполнителя нет и не будет: это не сущности графа.

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
 * — печатью канона, и совпасть они не могут ни при какой правке литерала.
 *
 * КАК ИМЕННО ПРИЗНАК ПЕРЕЖИВАЕТ СМЕНУ ФОРМЫ — см. `addressesBatch`: у разобранного блока
 * спрашивается адрес свойства в дереве, у неразобранного — имя поля в тексте. Одного дерева
 * НЕ ХВАТАЕТ, и это не запас прочности: у прод-тела, написанного старой грамматикой, дерева
 * нет ни у одного блока, и признак «по дереву» дописал бы пачку второй раз.
 *
 * СПРАШИВАЕТСЯ ДОКУМЕНТ, А НЕ КОЛОНКА `query_refs`. Колонка — денормализация, и у владельца,
 * засиденного до того, как сид начал её писать, она пуста при живом теле; `readBodyDoc`
 * собирает документ из `body`, когда `body_doc` пуст, — то есть отвечает по тому, что у
 * владельца ЕСТЬ, а не по тому, что мы надеялись записать.
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
/**
 * «Пачка уже показана» — ДВУМЯ путями, и второй здесь не запасной, а основной.
 *
 * У РАЗОБРАННОГО блока спрашивается ДЕРЕВО: адрес свойства переживает и переименование
 * подписи, и смену заголовка, которую владелец вправе сделать.
 *
 * У НЕРАЗОБРАННОГО дерева нет вовсе — и ровно так выглядит тело владельца в проде: оно
 * написано старой грамматикой §6.1 (`undecided=true`), которую строгий разбор отвергает
 * (проверено пробой: `query_refs` у такого тела пусты). Признак, спрашивающий только дерево,
 * ответил бы «пачки нет» на теле, где она стоит третьим блоком, и бэкфилл дописал бы её
 * ВТОРОЙ РАЗ — то есть сломался бы ровно на той смене формы, ради которой его и переводили
 * с побайтового сравнения. Поэтому текст неразобранного блока читается по имени поля.
 *
 * ЧЕГО ЭТОТ ПУТЬ НЕ УМЕЕТ, названо вслух: имя в НЕзакавыченном значении (`title=undecided=`
 * без кавычек) от имени поля неотличимо без парсера. Ошибка при этом безопасная — «не
 * дописать» вместо «дописать дважды», и лечится она сохранением тела, а не правкой.
 */
function addressesBatch(doc: BodyDoc): boolean {
  if (queryRefsFromDoc(doc).includes(PROP_UNDECIDED)) return true;
  let found = false;
  const walk = (node: JSONContent | undefined): void => {
    if (node === undefined || found) return;
    const attrs = (node.attrs ?? {}) as Record<string, unknown>;
    if (node.type === 'queryBlock' && attrs.ast == null && typeof attrs.text === 'string') {
      if (BATCH_IN_TEXT_RE.test(maskQuotedValues(attrs.text))) found = true;
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc.doc);
  return found;
}

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
  if (addressesBatch(doc)) return;

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
