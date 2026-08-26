// apps/server/src/agent-loop/rollback.ts
// Откат прогона (С12, инвариант 7): «отменить в Orbis всё, что сделал этот прогон».
// Нового механизма отмены здесь НЕТ — работу делает существующий Undo §7.8
// (executor/undo.ts) по действиям прогона в обратном порядке; собственных INSERT/UPDATE
// в графе этот файл не выполняет, только SELECT по журналу.
//
// Зачем поверх Undo нужна ПРЕДПРОВЕРКА. Undo — осознанный LWW-откат: он восстанавливает
// зафиксированное в журнале прежнее состояние ПОВЕРХ текущего, не спрашивая, менялось ли
// оно с тех пор (обоснование — докблок `InternalUndoMode` в executor/types.ts: body-патчи
// идут без expectedUpdatedAt, аспект-ключи восстанавливаются целиком). Для ОДНОГО «отмени
// последнее» это правильно — человек отменяет то, что только что видел. Для отката целого
// прогона — нет: между концом прогона и нажатием кнопки владелец мог ответить на чекпойнт
// или переставить статус руками, и серия LWW-отмен стёрла бы его решение молча. Ровно это
// запрещает инвариант 7 («откат не затирает чужие изменения — при расхождении показывает
// конфликт»), поэтому расхождение ищется ДО первой отмены и отдаётся списком.
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
import type { AgentRunAspect } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ActionOperation, ActionRecord } from '../executor/types';
import { isUndone, undoAction } from '../executor/undo';
import { closeOpenOfRun } from '../routines/lifecycle';
import type { RollbackConflict, WireRollbackResult } from '../wire';

/** Боевой синк — один инстанс на модуль (состояния не хранит), как в dispatch.ts. */
const sink = makeChatJournalSink();

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

/** Запись журнала: сам action + отметка времени и id сообщения (ключ порядка). */
interface JournalEntry {
  messageId: string;
  at: Date;
  action: ActionRecord;
}

/**
 * timestamptz из raw-SQL: drizzle отключает date-парсеры postgres.js, поэтому tx.execute
 * отдаёт строку PG (то же приведение, что в wire.ts).
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Строка журнала → запись. Инвариант §7.8 «один action на audit-сообщение» (journal.ts
 * проверяет его на записи) — читаем `actions[0]`, как undo.ts.
 */
function toEntry(row: Record<string, unknown>): JournalEntry | undefined {
  const metadata = row.metadata as { actions?: ActionRecord[] };
  const action = metadata.actions?.[0];
  if (action === undefined) return undefined; // недостижимо: отбор требует непустой actions
  return { messageId: String(row.id), at: toDate(row.created_at), action };
}

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
 * пропускает (undo.ts findLastUndoable), и без него брошенный прогон не откатился бы
 * целиком — тикет остался бы с чужим `waiting_for` о разборе остатков.
 */
function isRunAction(action: ActionRecord, runId: string): boolean {
  return action.run_id === runId && action.source !== 'ui';
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
  own(action: ActionRecord, runId: string): boolean;
  about(action: ActionRecord, runId: string): boolean;
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
  own: (action, runId) => action.run_id === runId && action.source === 'routine',
  about: (action, runId) => action.run_id === runId,
  archive: true,
  closeOpen: true,
  note: ROUTINE_ROLLBACK_NOTE,
};

/** Что известно о сущности прогона: чей он, убран ли уже в архив и сам аспект. `null` — прогона нет. */
interface RunFacts {
  routineId: string | undefined;
  archived: boolean;
  run: AgentRunAspect;
}

/**
 * Сущность прогона под identity — БЕЗ фильтра `NOT archived` (в отличие от `runById`):
 * повторный откат обязан узнать уже архивированный прогон, чтобы не архивировать его второй
 * раз и вести себя как первый успешный (см. докблок rollbackRun).
 */
async function runFacts(tx: Tx, runId: string): Promise<RunFacts | null> {
  const rows = await tx.execute(
    sql`SELECT archived, aspects_legacy -> 'orbis/agent-run' AS run
        FROM entities
        WHERE id = ${runId}::uuid AND aspects_legacy ? 'orbis/agent-run'`,
  );
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (row === undefined) return null;
  // Аспект валидирован ajv на записи (стадия 2 executor'а) — приведение честно, как в queries.ts
  const run = row.run as AgentRunAspect;
  return { routineId: run.routine_id, archived: row.archived === true, run };
}

/**
 * Действия прогона в порядке журнала (шаг 1). Обратная ссылка `run_id` — containment-проба
 * `metadata @> {"actions":[{"run_id": …}]}`: единственная форма, которую берёт GIN
 * `jsonb_path_ops` (0001_rls_and_indexes.sql:123, проверено EXPLAIN — Bitmap Index Scan по
 * chat_messages_metadata_gin). `metadata ? 'actions'` этим индексом НЕ покрыт.
 *
 * Тай-брейк по `id` обязателен: колонка created_at — precision 3, и два действия одной
 * миллисекунды без второго ключа встали бы в порядке, который выбрал план. Идиома та же,
 * что в undo.ts (`ORDER BY created_at DESC, id DESC`). Полной строгости это не даёт — id
 * batch-действия детерминирован (uuidv5 от batch_id), а не возрастает во времени, — но два
 * глагола ОДНОГО прогона в одну миллисекунду означали бы, что агент выпустил их
 * параллельно, а этого не допускает CAS-счётчик шагов (verbs.ts runStep).
 */
async function runActions(tx: Tx, runId: string, policy: RollbackPolicy): Promise<JournalEntry[]> {
  const probe = JSON.stringify({ actions: [{ run_id: runId }] });
  const rows = await tx.execute(
    sql`SELECT id, created_at, metadata FROM chat_messages
        WHERE metadata @> ${probe}::jsonb
        ORDER BY created_at ASC, id ASC`,
  );
  const entries: JournalEntry[] = [];
  for (const row of rows as unknown as Array<Record<string, unknown>>) {
    const entry = toEntry(row);
    if (entry !== undefined && policy.own(entry.action, runId)) entries.push(entry);
  }
  return entries;
}

/** uuid-подобные значения payload'а операции: что именно тронуло действие. */
const TOUCHED_KEYS = ['id', 'source_id', 'target_id', 'entity_id'] as const;

/**
 * Сущности, затронутые действиями (шаг 2). Берём id из ОБЕИХ половин записи — операций и
 * inverse: у entity_create операция несёт id новой сущности, а inverse — её же под
 * архивацию, но у relation-операций id связи в payload'е нет вовсе, зато есть концы
 * (`source_id`/`target_id`). Отсюда широкий набор ключей: конфликт по связи — тоже
 * конфликт, и лучше показать лишнюю строку, чем молча затереть правку соседа.
 */
function touchedEntities(entries: readonly JournalEntry[]): Set<string> {
  const touched = new Set<string>();
  for (const entry of entries) {
    for (const op of [...entry.action.operations, ...entry.action.inverse]) {
      for (const id of operationIds(op)) touched.add(id);
    }
  }
  return touched;
}

function operationIds(op: ActionOperation): string[] {
  const ids: string[] = [];
  for (const key of TOUCHED_KEYS) {
    const value = op.payload[key];
    if (typeof value === 'string') ids.push(value);
  }
  return ids;
}

/**
 * Чужие неотменённые действия по тем же сущностям в ОКНЕ ПРОГОНА (шаг 3) — от ПЕРВОГО
 * его живого действия и до конца журнала.
 *
 * Окно от первого, а не от последнего, и это не придирка. Прогон — не мгновение: между
 * `claim` и `finish` проходят часы, и владелец в это время правит тот же тикет руками
 * (приоритет, срок, заметку). Такая правка ЛЕЖИТ МЕЖДУ действиями прогона, а inverse
 * `entity_update` несёт прежнее значение ВСЕГО аспект-ключа (executor.ts, prior.aspects) —
 * то есть отмена `claim` вернула бы `orbis/task` целиком к состоянию ДО захвата и стёрла
 * бы правку владельца заодно со статусом. Окно «после последнего действия» её просто не
 * видит: она раньше `finish`. Инвариант 7 требует показать её конфликтом, а не затереть,
 * поэтому смотрим весь отрезок жизни прогона, а не его хвост.
 *
 * Отбор — по составному курсору `(created_at, id) > (…)`, тем же ключом, что и порядок
 * шага 1: `created_at > t0` пропустил бы действие той же миллисекунды, а при precision 3
 * это не гипотетический случай. Само первое действие прогона в окно не входит (строгое
 * `>`), а остальные его действия отсеиваются ТЕМ ЖЕ предикатом, что отбирал их на шаге 1
 * (`policy.own`), — они и есть то, что мы собрались отменять. Предикат, а не голое
 * сравнение run_id: у гранта ответ владельца на чекпойнт тоже несёт run_id, и по голому
 * сравнению он молча выпал бы из конфликтов, то есть был бы снят откатом (инвариант 7).
 * У рутины действия «о прогоне» (`policy.about`) выпадают из конфликтов НАРОЧНО: сущность
 * прогона не входит в touched (работа рутины её трогать не может — invariants.ts), а
 * бухгалтерия и ответ владельца сами по себе не правят того, что откатывается.
 * Уже отменённые чужие — не конфликт: их эффекта в графе больше нет.
 *
 * Containment `{"actions": []}` + непустая длина — тот же приём, что в undo.ts
 * findLastUndoable: он отсекает undo-сообщения и обычную переписку (у них нет `actions`).
 * Индексом он, в отличие от пробы шага 1, НЕ берётся (пустой контейнер не даёт ключей
 * jsonb_path_ops) — сужает здесь курсор по created_at (EXPLAIN: Index Scan по
 * chat_messages_thread_created), а containment остаётся фильтром.
 *
 * Пара {сущность, действие} дедуплицируется: id обычно встречается и в операции, и в
 * inverse одного action'а, и без дедупликации экран показывал бы один конфликт дважды.
 */
async function foreignChangesAfter(
  tx: Tx,
  args: {
    runId: string;
    after: JournalEntry;
    touched: ReadonlySet<string>;
    policy: RollbackPolicy;
  },
): Promise<RollbackConflict[]> {
  const rows = await tx.execute(
    sql`SELECT id, created_at, metadata FROM chat_messages
        WHERE metadata @> '{"actions": []}'::jsonb
          AND jsonb_array_length(metadata->'actions') > 0
          AND (created_at, id) > (${args.after.at.toISOString()}::timestamptz, ${args.after.messageId}::uuid)
        ORDER BY created_at ASC, id ASC`,
  );
  const conflicts: RollbackConflict[] = [];
  for (const row of rows as unknown as Array<Record<string, unknown>>) {
    const entry = toEntry(row);
    if (entry === undefined) continue;
    const action = entry.action;
    // Своё — то, что откатываем; «о прогоне» (у рутины — бухгалтерия и решения владельца)
    // — не конфликт по политике: см. RollbackPolicy
    if (args.policy.own(action, args.runId) || args.policy.about(action, args.runId)) continue;
    // Пересечение с `touched` считается ДО `isUndone`, и порядок здесь принципиален:
    // проба «отменено?» — отдельный запрос НА КАЖДОЕ действие, а в окне долгого прогона
    // у активного владельца лежат сотни чужих записей, к откату отношения не имеющих.
    // Дешёвый фильтр в памяти сначала — и запрос уходит только за настоящими кандидатами.
    // Set заодно даёт дедупликацию {действие, сущность}: id встречается и в операции, и
    // в inverse одного action'а.
    const hits = new Set<string>();
    for (const op of [...action.operations, ...action.inverse]) {
      for (const entityId of operationIds(op)) {
        if (args.touched.has(entityId)) hits.add(entityId);
      }
    }
    if (hits.size === 0) continue;
    if (await isUndone(tx, action.id)) continue;
    for (const entityId of hits) {
      conflicts.push({
        entityId,
        actionId: action.id,
        at: entry.at.toISOString(),
        source: action.source,
      });
    }
  }
  return conflicts;
}

/**
 * Откат прогона. Шаги 1–3 (чтение журнала и предпроверка) идут ОДНОЙ транзакцией под
 * `withIdentity`: RLS на chat_messages скоупит журнал владельцем (§4.10), и без identity
 * выборка вернула бы пусто. Транзакция закрывается ДО серии отмен намеренно — undoAction
 * принимает `Db` и открывает собственную транзакцию, а вложенности здесь быть не должно.
 *
 * Отсюда честное TOCTOU-окно: между коммитом предпроверки и первым undo проходит время,
 * и чужая правка, легшая ИМЕННО в этот зазор, конфликтом не станет — её затрёт LWW-откат
 * (undo не сверяет состояние, см. шапку файла). Это свойство ДИЗАЙНА, а не недосмотр:
 * закрыть окно можно было бы только замком на все затронутые сущности через обе фазы, а
 * механика Undo, на которой стоит откат (решение плана — «механику самого Undo не
 * трогаем»), транзакцию наружу не отдаёт. Цена промаха — одна потерянная правка, сделанная
 * в те доли секунды, пока человек уже нажал «Откатить»; цена закрытия — переписанный Undo.
 *
 * Прогон, которого нет (или чужой — под RLS это неразличимо), даёт `ok` с пустым undone,
 * а не NOT_FOUND: «откатывать нечего» — это исход, а не отказ, и повторное нажатие кнопки
 * после успешного отката обязано вести себя так же.
 */
export async function rollbackRun(
  db: Db,
  args: { actorUserId: string; runId: string },
): Promise<WireRollbackResult> {
  const { actorUserId, runId } = args;

  const plan = await withIdentity(db, actorUserId, async (tx) => {
    // Чей прогон — решает политику (шапка файла). Прогона нет (или он чужой под RLS) —
    // грантовая политика по журналу даст пусто, как и раньше
    const facts = await runFacts(tx, runId);
    const policy = facts?.routineId !== undefined ? ROUTINE_POLICY : GRANT_POLICY;
    const all = await runActions(tx, runId, policy);
    // Уже отменённые (вручную «отмени последнее» или прошлым откатом) выбывают: повторная
    // отмена вернула бы VALIDATION и уронила бы весь откат в partial на ровном месте
    const live: JournalEntry[] = [];
    for (const entry of all) {
      if (!(await isUndone(tx, entry.action.id))) live.push(entry);
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
    const conflicts = await foreignChangesAfter(tx, {
      runId,
      after: first,
      touched: touchedEntities(live),
      policy,
    });
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
    const result = await undoAction(db, { actorUserId, actionId: entry.action.id });
    if (!result.ok) {
      return {
        ok: false,
        reason: 'partial',
        undone,
        failed: {
          actionId: entry.action.id,
          error: { code: result.error.code, message: result.error.message },
        },
      };
    }
    undone.push(entry.action.id);
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
        ownerId: actorUserId,
        routineId: plan.closeOpen.routineId,
        runId,
        run: plan.closeOpen.run,
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
        actorUserId,
        actorKind: 'owner',
        source: 'system',
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
