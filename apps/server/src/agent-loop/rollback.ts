// apps/server/src/agent-loop/rollback.ts
// Откат прогона (С12, инвариант 7): «отменить в Orbis всё, что сделал этот прогон».
// Нового механизма отмены здесь НЕТ — работу делает существующий Undo §7.8
// (executor/undo.ts) по действиям прогона в обратном порядке; собственных INSERT/UPDATE
// в графе этот файл не выполняет, только SELECT по журналу.
//
// Зачем поверх Undo нужна ПРЕДПРОВЕРКА. Undo свойств — осознанный LWW-откат: он восстанавливает
// зафиксированное в журнале прежнее состояние ПОВЕРХ текущего, не спрашивая, менялось ли
// оно с тех пор (обоснование — докблок `InternalUndoMode` в executor/types.ts: свойства
// восстанавливаются мимо гейта прав). Для ОДНОГО «отмени последнее» это правильно — человек
// отменяет то, что только что видел. Для отката целого прогона — нет: между концом прогона и
// нажатием кнопки владелец мог ответить на чекпойнт или переставить статус руками, и серия
// LWW-отмен стёрла бы его решение молча. Ровно это запрещает инвариант 7 («откат не затирает
// чужие изменения — при расхождении показывает конфликт»), поэтому расхождение ищется ДО
// первой отмены и отдаётся списком. Текст записей сверяет ещё и правило отмены текста (§8.6,
// `executor/body-chain.ts`) — в каждой отмене серии; предпроверка проходит ту же цепочку тела
// заранее (`seriesChainBreaks`), чтобы серия не начиналась там, где правило её остановит.
//
// Почему серия НЕ атомарна. Undo одного действия — одна транзакция (undoAction открывает
// свою), и склеить их в одну нечем: internal-режим executor'а принимает `Db`, а не `Tx`.
// Общий откат — обещание уровня UX, а не инвариант БД: если серия встанет на середине,
// вызывающий получает `partial` со списком уже отменённого и адресом отказа, а граф
// остаётся в понятном промежуточном состоянии (часть действий отменена, остальные — нет),
// которое чинится повторным вызовом. Прятать это за «атомарно» было бы враньём.
//
// Два вида прогонов — две политики отката (V1, приёмка 11). Прогон ВНЕШНЕГО исполнителя
// (грант) откатывается целиком: его создание, шаги, итог, подметание — всё это работа
// круга ADE, и инверсия создания архивирует сам прогон. Прогон РУТИНЫ устроен иначе: его
// сущность и связь с рутиной, шаги, закрытие и пометки судьбы предложения — БУХГАЛТЕРИЯ
// (источник `system`, рулинг Р-7), а работа в графе — только модельные мутации режима `act`
// и принятое владельцем предложение (источник `routine`). Инвертировать бухгалтерию нельзя:
// откат возвращал бы прогон в `running` (архивным), подметание закрывало бы его `failed`, и
// планировщик заводил бы попытку 2 — рутина предлагала бы вчерашний план заново через
// полчаса после отката. Поэтому для рутинного прогона откат инвертирует ТОЛЬКО работу,
// конфликты ищет только по её сущностям, а прогон помечает архивом ЯВНОЙ операцией: тот же
// признак, по которому экран прогона (RunFeed) читает откаченный прогон ADE.
import type { GraphId, UndoTextChangedDetails } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import { seriesChainBreaks } from '../executor/body-chain';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import {
  actionsTouchingAfter,
  historicalRollbackDeltaIds,
  isUndone,
  type JournalCursor,
  type JournalEntry,
  rollbackConflictKeys,
  rollbackRuleAddresses,
  rollbackTouchedKeys,
  runActions,
} from '../executor/journal-read';
import type { ExecutorDeps } from '../executor/types';
import { undoAction } from '../executor/undo';
import type { Identity } from '../identity';
import { closeOpenOfRun } from '../routines/lifecycle';
import type { RollbackConflict, WireRollbackResult } from '../wire';
import type { RunProps } from './queries';

/** Боевой синк — один инстанс на модуль (состояния не хранит), как в dispatch.ts. */
const sink = makeJournalSink();

/**
 * Постоянный текст успешного отката (С12). Именно постоянный, а не собранный по факту:
 * граница «Orbis откатили, git не трогали» — свойство механизма, а не этого прогона, и
 * человек должен читать её одинаково после каждого отката.
 */
export const ROLLBACK_NOTE =
  'Откачены изменения в Orbis (статусы тикета, прогон). ' +
  "Ветку и коммиты в репозитории откат не трогает — откатывайте их git'ом.";

/**
 * Тот же постоянный текст для прогона РУТИНЫ (V1, приёмка 11). Про репозиторий здесь ни
 * слова — у внутреннего исполнителя его нет; зато названо то, что отличает этот откат от
 * грантового: сам прогон не «раскручен», а убран в архив как след отката.
 */
export const ROUTINE_ROLLBACK_NOTE =
  'Откачены изменения прогона рутины в Orbis (правки и принятое предложение); ' +
  'сам прогон убран в архив.';

/** Действие прогона из журнала с курсором — ключом порядка журнала (`journal-read`). */
type RunEntry = JournalEntry & { cursor: JournalCursor };

/**
 * Что считается действием ПРОГОНА — и что нарочно не считается.
 *
 * `source: 'ui'` отсеивается, и это не мелочь: ответ владельца на чекпойнт тоже несёт
 * `run_id` (он про этот прогон и стоит рядом с вопросом на экране), но это ЕГО решение,
 * а не работа исполнителя. Считать его действием прогона значило бы молча снимать его
 * откатом — ровно то, что запрещает инвариант 7. Он остаётся чужим изменением и виден
 * конфликтом (шаг 3).
 *
 * Работа исполнителя — `source: 'mcp'`, обслуживание круга (подметание С6) — `'system'`.
 * Последнее откатывается вместе с прогоном намеренно: «отмени последнее» подметание
 * пропускает (journal-read findLastUndoable), и без него брошенный прогон не откатился бы
 * целиком — тикет остался бы с чужим `waiting_for` о разборе остатков.
 */
function isRunAction(action: JournalEntry, runId: string): boolean {
  return action.runId === runId && action.source !== 'ui';
}

/**
 * Политика отката — чем прогон ГРАНТА отличается от прогона РУТИНЫ (шапка файла).
 *
 * `own` — действие прогона, которое откат ИНВЕРТИРУЕТ и по сущностям которого ищет
 * конфликты. `about` — действие О прогоне, которое ни инвертируется, ни конфликтом не
 * считается: у рутины это вся бухгалтерия (`system` + `run_id`: создание, шаги, закрытие,
 * пометки судьбы предложения, дозапись расхода) и решения владельца по прогону (`ui` +
 * `run_id`: ответ на вопрос). У гранта такого класса нет: там ответ владельца — чужое
 * изменение (инвариант 7), а бухгалтерия — часть работы круга.
 *
 * `archive` — помечать ли прогон архивом явной операцией. У гранта архивирует инверсия
 * его создания (создание — `own`); у рутины создание — бухгалтерия, и след отката
 * приходится ставить отдельно, иначе экран показывал бы «готово» над откаченным планом.
 *
 * `closeOpen` — гасить ли открытое у прогона. Гасится не пара, а ВСЁ наследство (D42
 * ОЧ.8, routines/lifecycle.ts closeOpenOfRun): непринятое предложение → `stale`,
 * неотвеченный терминальный вопрос → `stale`, вся ПАЧКА единиц прогона — отложенные
 * действия и вопросы — своими судьбами со СВОИМИ текстами отката («устарело: прогон
 * откачен»), и следом снимается флажок `undecided`. У рутины — да: откаченный прогон не
 * вправе держать на владельце ни кнопок «Принять/Отклонить», ни «ждёт ответа» — архивный
 * прогон для decideProposal/answerCheckpoint «не найден», и карточка с живыми кнопками
 * вела бы в NOT_FOUND, а обзор рутины считал бы их ожиданием. Тем же доводом гасится и
 * пачка: карточки отложенных действий пережили бы откат и предлагали бы «Принять» работу
 * прогона, которого больше нет. У гранта открытое у прогона — статус ТИКЕТА, и его
 * возвращает инверсия бухгалтерии.
 */
interface RollbackPolicy {
  own(action: JournalEntry, runId: string): boolean;
  about(action: JournalEntry, runId: string): boolean;
  archive: boolean;
  closeOpen: boolean;
  note: string;
}

const GRANT_POLICY: RollbackPolicy = {
  own: isRunAction,
  about: () => false,
  archive: false,
  closeOpen: false,
  note: ROLLBACK_NOTE,
};

/**
 * Работа рутинного прогона — РОВНО источник `routine`: модельные мутации режима `act`
 * (dispatch с `ctx.source === 'routine'`) и принятое предложение (approvePending исполняет
 * pending с сохранённым `source: 'routine'`). Всё остальное с этим `run_id` — о прогоне.
 */
const ROUTINE_POLICY: RollbackPolicy = {
  own: (action, runId) => action.runId === runId && action.source === 'routine',
  about: (action, runId) => action.runId === runId,
  archive: true,
  closeOpen: true,
  note: ROUTINE_ROLLBACK_NOTE,
};

/** Что известно о сущности прогона: чей он, убран ли уже в архив и его свойства. `null` — прогона нет. */
interface RunFacts {
  routineId: string | undefined;
  archived: boolean;
  props: RunProps;
}

/**
 * Сущность прогона под identity — БЕЗ фильтра `NOT archived` (в отличие от `runById`):
 * повторный откат обязан узнать уже архивированный прогон, чтобы не архивировать его второй
 * раз и вести себя как первый успешный (см. докблок rollbackRun).
 *
 * Тождество прогона и его рутина читаются по НОВОЙ правде (§А1-1): «несёт ли сущность
 * аспект» — принадлежность в `aspects[]`, «чья это рутина» — свойство `orbis/run_routine`.
 * Форма предиката — `= ANY(e.aspects)`, а НЕ `= ANY((SELECT …))`: подзапросная форма
 * падает «malformed array literal», и это не стилистика, а проверенная ловушка.
 *
 * Наследство прогона (`props`) читается из НОВОЙ правды целиком: его потребитель —
 * `closeOpenOfRun` (routines/lifecycle.ts) — с Задачи 10b принимает свойства по id, и
 * встречного перевода в аспект-объект больше нигде нет.
 */
async function runFacts(tx: Tx, runId: string): Promise<RunFacts | null> {
  const rows = await tx.execute(
    sql`SELECT e.archived, e.props ->> 'orbis/run_routine' AS routine_id, e.props
        FROM entities e
        WHERE e.id = ${runId}::uuid AND 'orbis/agent-run' = ANY(e.aspects)`,
  );
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (row === undefined) return null;
  // Свойства валидированы ajv на записи (стадия 2 executor'а) — приведение честно, как в queries.ts
  const routineId = row.routine_id;
  return {
    routineId: typeof routineId === 'string' ? routineId : undefined,
    archived: row.archived === true,
    props: row.props as RunProps,
  };
}

/**
 * Действия прогона в порядке журнала (шаг 1): `journal-read.runActions` (обратная ссылка `run_id`, порядок
 * `created_at, id`), из них — своё по политике.
 *
 * Тай-брейк по ключу хранилища обязателен: колонка created_at — precision 3, и два действия одной
 * миллисекунды без второго ключа встали бы в порядке, который выбрал план. Полной строгости это не даёт —
 * id batch-действия детерминирован (uuidv5 от batch_id), а не возрастает во времени, — но два глагола ОДНОГО
 * прогона в одну миллисекунду означали бы, что агент выпустил их параллельно, а этого не допускает
 * CAS-счётчик шагов (verbs.ts runStep).
 */
async function ownRunActions(
  tx: Tx,
  graph: GraphId,
  runId: string,
  policy: RollbackPolicy,
): Promise<RunEntry[]> {
  return (await runActions(tx, graph, runId)).filter((entry) => policy.own(entry, runId));
}

/**
 * Что затронули действия (шаг 2) — `touchedKeys` записей журнала: ключи из ОБЕИХ половин записи, операций и
 * inverse (у entity_create операция несёт id новой сущности, а inverse — её же под архивацию, у relation-операций
 * id связи в payload'е нет вовсе, зато есть концы `source_id`/`target_id`). Ключи обоих видов — uuid записей и ключи
 * реестра (подписка, аспект, встроенное свойство — рулинг R-11): рутина в `act` вправе править реестр, и правка
 * владельца той же подписки после неё — такой же конфликт, как правка записи. Отсюда широкий набор ключей: лучше
 * показать лишнюю строку, чем молча затереть правку соседа.
 */
function touchedKeys(entries: readonly RunEntry[]): Set<string> {
  const touched = new Set<string>();
  for (const entry of entries) for (const key of rollbackTouchedKeys(entry)) touched.add(key);
  return touched;
}

/**
 * Чужие неотменённые действия по тем же сущностям в ОКНЕ ПРОГОНА (шаг 3) — от ПЕРВОГО
 * его живого действия и до конца журнала.
 *
 * Окно от первого, а не от последнего, и это не придирка. Прогон — не мгновение: между
 * `claim` и `finish` проходят часы, и владелец в это время правит тот же тикет руками
 * (статус, срок, заметку). Такая правка ЛЕЖИТ МЕЖДУ действиями прогона, а Undo состояния
 * не сверяет (LWW, см. шапку файла): правка ТОГО ЖЕ свойства, которое трогал прогон, была
 * бы затёрта молча. Окно «после последнего действия» её просто не видит: она раньше
 * `finish`. Инвариант 7 требует показать её конфликтом, а не затереть, поэтому смотрим
 * весь отрезок жизни прогона, а не его хвост.
 *
 * Пересечение считается ПО СУЩНОСТИ, а не по свойству, и это осознанная перестраховка. С
 * §А7-4 inverse несёт прежние значения ровно тронутых свойств, поэтому правка СОСЕДНЕГО
 * свойства того же тикета откатом уже не пострадала бы — и всё равно показывается
 * конфликтом. Лишняя строка на экране дешевле пропущенной: считать по свойствам значило бы
 * повторить здесь всю логику дельты и разойтись с ней при первой же правке.
 *
 * Отбор — по составному курсору журнала (`JournalCursor`) строго после первого действия, тем
 * же ключом, что и порядок шага 1: `created_at > t0` пропустил бы действие той же миллисекунды,
 * а при precision 3 это не гипотетический случай. Само первое действие прогона в окно не входит (строгое
 * `>`), а остальные его действия отсеиваются ТЕМ ЖЕ предикатом, что отбирал их на шаге 1
 * (`policy.own`), — они и есть то, что мы собрались отменять. Предикат, а не голое
 * сравнение run_id: у гранта ответ владельца на чекпойнт тоже несёт run_id, и по голому
 * сравнению он молча выпал бы из конфликтов, то есть был бы снят откатом (инвариант 7).
 * У рутины действия «о прогоне» (`policy.about`) выпадают из конфликтов НАРОЧНО: сущность
 * прогона не входит в touched (работа рутины её трогать не может — invariants.ts), а
 * бухгалтерия и ответ владельца сами по себе не правят того, что откатывается.
 * Уже отменённые чужие — не конфликт: их эффекта в графе больше нет.
 *
 * Записи отмены — не действия (К-22): `actionsTouchingAfter` их не отдаёт, иначе отмена владельцем
 * действия прогона всплыла бы здесь «чужой правкой».
 *
 * Пара {сущность, действие} дедуплицируется: id обычно встречается и в операции, и в
 * inverse одного action'а, и без дедупликации экран показывал бы один конфликт дважды.
 */
async function foreignChangesAfter(
  tx: Tx,
  args: {
    graph: GraphId;
    runId: string;
    after: RunEntry;
    touched: ReadonlySet<string>;
    historicalDeltaIds: readonly string[];
    ruleAddresses: ReturnType<typeof rollbackRuleAddresses>;
    policy: RollbackPolicy;
  },
): Promise<RollbackConflict[]> {
  const candidates = await actionsTouchingAfter(
    tx,
    args.graph,
    args.after.cursor,
    [...args.touched],
    'rollback',
  );
  const conflicts: RollbackConflict[] = [];
  for (const action of candidates) {
    // Своё — то, что откатываем; «о прогоне» (у рутины — бухгалтерия и решения владельца)
    // — не конфликт по политике: см. RollbackPolicy
    if (args.policy.own(action, args.runId) || args.policy.about(action, args.runId)) continue;
    // Пересечение с `touched` считается ДО `isUndone`, и порядок здесь принципиален:
    // проба «отменено?» — отдельный запрос НА КАЖДОЕ действие, а в окне долгого прогона
    // у активного владельца лежат сотни чужих записей, к откату отношения не имеющих.
    // Дешёвый фильтр (API отдаёт только тронувших `touched`) сначала — и запрос уходит только
    // за настоящими кандидатами. `touchedKeys` записи уже без повторов: ключ встречается и в
    // операции, и в inverse одного действия, а конфликт {действие, ключ} — один.
    const hits = rollbackConflictKeys(
      action.touchedKeys.filter((key) => args.touched.has(key)),
      args.historicalDeltaIds,
      args.ruleAddresses,
    );
    if (hits.length === 0) continue;
    if (await isUndone(tx, args.graph, action.id)) continue;
    // Поле провода называется `entityId`, но несёт ключ любого вида (как до перевода на API журнала)
    for (const entityId of hits) {
      conflicts.push({
        entityId,
        actionId: action.id,
        at: action.createdAt.toISOString(),
        source: action.source,
      });
    }
  }
  return conflicts;
}

/** Источник конфликта без действия в журнале (`RollbackConflict.actionId: null`): текст сменили вне приложения. */
const OUTSIDE_SOURCE = 'outside';

/**
 * Цепочка тела серии (шаг 3б, §8.6 «Откат прогона», К-43): для каждой записи, чьё тело меняли живые действия прогона,
 * последнее из них обязано быть действующим действием текущего тела, а каждое более раннее — действующим после отмены
 * следующего, с раскруткой через ЛЮБЫЕ записи отмены (в том числе отмены владельцем отдельных действий прогона). Сама
 * проверка — `seriesChainBreaks` (`executor/body-chain.ts`, рядом с правилом, которое применит каждая отмена серии);
 * здесь — только форма конфликта: той же гранулярности {запись, действие}, что у `foreignChangesAfter`.
 *
 * Сверх окна чужих действий она видит то, чего в журнале нет или что политика конфликтом не считает: текст, сменённый
 * писателем без журнала (ops-скрипт, сев — колонка «действие тела» пуста), и текст от действия «о прогоне» (ответ
 * владельца на чекпойнт, бухгалтерия рутины). Правка владельца в окне даёт ту же пару, что и окно, — одна строка.
 */
async function bodyChainConflicts(
  tx: Tx,
  graph: GraphId,
  live: readonly RunEntry[],
): Promise<RollbackConflict[]> {
  return (await seriesChainBreaks(tx, graph, live)).map((b) => ({
    entityId: b.entityId,
    actionId: b.holder?.id ?? null,
    at: b.at.toISOString(),
    source: b.holder?.source ?? OUTSIDE_SOURCE,
  }));
}

/** Конфликты без повторов пары {запись, действие}: окно и цепочка тела называют правку владельца одинаково. */
function distinctConflicts(conflicts: readonly RollbackConflict[]): RollbackConflict[] {
  const seen = new Set<string>();
  return conflicts.filter((c) => {
    const key = `${c.entityId}\u0000${c.actionId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Сообщение остановки серии отказом правила отмены текста (§8.6): откат прогона — кнопка владельца без продолжения
 * «Всё равно отменить» (К-31), поэтому текст отказа исполнителя (он зовёт к продолжению) сюда не годится. Записи —
 * заголовками: по ним владелец найдёт, где текст изменён после прогона.
 */
function textChangedMessage(details: UndoTextChangedDetails): string {
  const titles = details.entries.map((e) => `«${e.title}»`).join(', ');
  return `Текст изменён после прогона: ${titles} — откат остановлен, текст не тронут`;
}

/**
 * Откат прогона. Шаги 1–3 (чтение журнала и предпроверка) идут ОДНОЙ транзакцией под
 * `withIdentity`: граф журнала задаёт API явным `graph_id` идентичности (`executor/journal-read.ts`), а RLS
 * страхует его (§4.10). Транзакция закрывается ДО серии отмен намеренно — undoAction
 * принимает `Db` и открывает собственную транзакцию, а вложенности здесь быть не должно.
 *
 * Отсюда честное TOCTOU-окно: между коммитом предпроверки и первым undo проходит время,
 * и чужая правка СВОЙСТВ, легшая ИМЕННО в этот зазор, конфликтом не станет — её затрёт
 * LWW-откат (см. шапку файла). Это свойство ДИЗАЙНА, а не недосмотр: закрыть окно можно
 * было бы только замком на все затронутые сущности через обе фазы, а механика Undo, на
 * которой стоит откат, транзакцию наружу не отдаёт. Цена промаха — одна потерянная правка,
 * сделанная в те доли секунды, пока человек уже нажал «Откатить»; цена закрытия —
 * переписанный Undo. ТЕКСТ в этом окне не теряется: правило отмены текста (§8.6) стоит в
 * каждой транзакции серии, и правка текста в зазоре останавливает серию отказом — исход
 * `partial` с причиной `text_changed` и списком уже откаченного (лучше молчаливого затирания).
 *
 * Прогон, которого нет (или чужой — под RLS это неразличимо), даёт `ok` с пустым undone,
 * а не NOT_FOUND: «откатывать нечего» — это исход, а не отказ, и повторное нажатие кнопки
 * после успешного отката обязано вести себя так же.
 *
 * `deps.beforeStages` — шов транзакций отмены серии (тот же, что у `undoAction`; executor зовёт его в начале каждой
 * из них). Боевой вызывающий (`agentRun.rollback`) его не передаёт; через него видна гонка «правка между предпроверкой и
 * серией» — ровно то окно, которое закрывает правило §8.6 в транзакции отмены.
 */
export async function rollbackRun(
  db: Db,
  args: { identity: Identity; runId: string },
  deps: Pick<ExecutorDeps, 'beforeStages'> = {},
): Promise<WireRollbackResult> {
  const { identity, runId } = args;

  const plan = await withIdentity(db, identity, async (tx) => {
    // Чей прогон — решает политику (шапка файла). Прогона нет (или он чужой под RLS) —
    // грантовая политика по журналу даст пусто, как и раньше
    const facts = await runFacts(tx, runId);
    const policy = facts?.routineId !== undefined ? ROUTINE_POLICY : GRANT_POLICY;
    const all = await ownRunActions(tx, identity.graph, runId, policy);
    // Уже отменённые (вручную «отмени последнее» или прошлым откатом) выбывают: повторная
    // отмена вернула бы VALIDATION и уронила бы весь откат в partial на ровном месте
    const live: RunEntry[] = [];
    for (const entry of all) {
      if (!(await isUndone(tx, identity.graph, entry.id))) live.push(entry);
    }
    // Архивировать — только рутинный прогон, который есть и ещё не в архиве: повторный
    // откат обязан вести себя как первый успешный, а не писать второй маркер
    const archive = policy.archive && facts !== null && !facts.archived;
    // Гасить открытое — у рутинного прогона ВСЕГДА, в том числе уже архивного: повтор
    // отката обязан долечить прогон, которому первый откат (до хвоста) оставил pending
    const closeOpen = policy.closeOpen && facts !== null ? facts : null;
    // Окно предпроверки открывается ПЕРВЫМ живым действием прогона, а не последним:
    // чужая правка между `claim` и `finish` — самый обычный случай, и она обязана стать
    // конфликтом (см. докблок foreignChangesAfter)
    const first = live[0];
    if (first === undefined) {
      return { live, conflicts: [] as RollbackConflict[], archive, closeOpen, note: policy.note };
    }
    const foreign = await foreignChangesAfter(tx, {
      graph: identity.graph,
      runId,
      after: first,
      touched: touchedKeys(live),
      historicalDeltaIds: historicalRollbackDeltaIds(live),
      ruleAddresses: rollbackRuleAddresses(live),
      policy,
    });
    // Цепочка тела — до первой отмены (§8.6, D37 п. 6): расхождение — список, серия не начинается
    const chain = await bodyChainConflicts(tx, identity.graph, live);
    const conflicts = distinctConflicts([...foreign, ...chain]);
    return { live, conflicts, archive, closeOpen, note: policy.note };
  });

  if (plan.conflicts.length > 0) {
    return { ok: false, reason: 'conflict', conflicts: plan.conflicts };
  }

  // Шаг 4: серия отмен в ОБРАТНОМ порядке журнала — иначе inverse раннего действия лёг бы
  // поверх позднего и восстановил состояние, которого не было (§7.8 «inverse в обратном
  // порядке исполнения»). Копия перед reverse: он мутирует массив на месте, а `plan`
  // здесь — прочитанный план, а не рабочий буфер.
  const undone: string[] = [];
  for (const entry of [...plan.live].reverse()) {
    // Путь — `ui`: откат прогона — кнопка владельца на экране прогона (К-45), отмены пишутся от его имени. Продолжения
    // «Всё равно отменить» у серии нет (К-31) — место `none`
    const result = await undoAction(
      db,
      { identity, actionId: entry.id, path: 'ui', continuation: { kind: 'none' } },
      deps,
    );
    if (!result.ok) {
      if (result.error.code === 'UNDO_TEXT_CHANGED') {
        // Правка текста легла между предпроверкой и этой отменой — правило §8.6 остановило серию: `partial` с причиной
        const details = result.error.details as UndoTextChangedDetails;
        return {
          ok: false,
          reason: 'partial',
          undone,
          failed: {
            actionId: entry.id,
            error: { code: result.error.code, message: textChangedMessage(details) },
            reason: 'text_changed',
            entries: details.entries,
          },
        };
      }
      return {
        ok: false,
        reason: 'partial',
        undone,
        failed: {
          actionId: entry.id,
          error: { code: result.error.code, message: result.error.message },
        },
      };
    }
    undone.push(entry.id);
  }
  // Шаг 5 (только рутина): гашение открытого и след отката. Оба идут ПОСЛЕ серии отмен и
  // только при её полном успехе: partial оставляет прогон живым, чтобы повторное нажатие
  // доделало откат.
  //
  // Сначала гашение (непринятое предложение и неотвеченный вопрос → `stale`), потом архив:
  // обратный порядок давал бы окно «архивный, но с живыми кнопками» — то самое, ради
  // которого гашение здесь и стоит. Бухгалтерия гашения — `ai`/`system` (как у
  // supersedeOpen): запись О прогоне, не работа; «отмени последнее» её не берёт.
  if (plan.closeOpen !== null && plan.closeOpen.routineId !== undefined) {
    await closeOpenOfRun(
      { db, clock: () => new Date() },
      {
        identity,
        routineId: plan.closeOpen.routineId,
        runId,
        props: plan.closeOpen.props,
        reason: 'stale',
        questionNote: 'Вопрос прогона снят: прогон откачен',
      },
    );
  }
  // Архив — явной операцией. Атрибуция — владелец (это его жест) источником `system` с
  // `run_id`: это запись О прогоне, а не работа в графе — «отмени последнее» её не берёт,
  // а следующий откат того же прогона видит её как «о прогоне», не как конфликт.
  if (plan.archive) {
    const r = await execute(
      db,
      {
        identity,
        actorKind: 'owner',
        source: 'system',
        // Механизм — глагол исполнителя (§А4-4): это запись О прогоне, не правка графа
        mechanism: 'verb',
        runId,
        operations: [{ tool: 'entity_update', input: { id: runId, archived: true } }],
      },
      { sink },
    );
    if (!r.ok) {
      // Работа уже откачена — это исход, а не сбой; без маркера экран покажет прежний
      // бейдж и живую кнопку, и повторное нажатие поставит маркер (откатывать уже нечего)
      console.error(`[rollback] прогон ${runId} не помечен архивом:`, r.error);
    }
  }
  return { ok: true, undone, note: plan.note };
}
