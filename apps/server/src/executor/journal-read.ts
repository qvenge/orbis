// apps/server/src/executor/journal-read.ts — ЕДИНСТВЕННЫЙ читатель журнала действий (РП-9 плана А).
//
// Почему модуль, а не запросы на местах: читателей журнала ≈15, и пока каждый ходил в хранилище своим SQL, смена
// хранилища (задача 5: сообщения чата → таблица `action_journal`) была бы пятнадцатью правками с пятнадцатью шансами
// разойтись; здесь она — одна. Записи отмены — НЕ действия (спека §11.2, К-22): функции поиска «действия» их не
// отдают никогда; запись отмены достаётся только `undoRecordOf`, `undoRecordById` (раскрутка цепочки тела §8.6),
// журналом треда и экспортом.
//
// Хранилище — таблица `action_journal` (миграция 0025): строка — действие целиком или запись отмены (`type = 'undo'`,
// `undoes`), ключ `(graph_id, id)`. Пробы «по затронутой записи» — боковая `action_journal_entities` (РП-8: под RLS
// `uuid[] @>` не leakproof, равенство uuid — leakproof, btree берётся). Каждый запрос несёт явный `graph_id`: RLS
// страхует, но прод-операции идут ролью с BYPASSRLS, и граф обязан держать сам запрос. «Действие» — `type <> 'undo'`
// явно в каждой пробе: строка отмены несёт операции (применённый inverse), и без исключения всплыла бы действием.
import type { AccountId, GraphId } from '@orbis/shared';
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { ISql } from 'postgres';
import { PROCESSING_TTL_MS } from '../chat/messages';
import type { Tx } from '../db/with-identity';
import { parseAccountId, parseGraphId } from '../identity';
import type {
  ActionOperation,
  ActionRecord,
  ActorKind,
  MutationMechanism,
  MutationSource,
  UndoPath,
} from './types';

export interface JournalEntry {
  id: string;
  graphId: GraphId;
  createdAt: Date;
  type: ActionRecord['type'] | 'undo';
  entityId: string | null;
  actorUserId: AccountId;
  actorKind: ActorKind;
  source: MutationSource;
  mechanism: MutationMechanism;
  actorGrantId?: string;
  runId?: string;
  actionId?: string;
  module?: string;
  editedFrom?: string;
  threadId: string | null;
  title: string;
  cardTool: string;
  entityIds: string[];
  /**
   * Затронутые КЛЮЧИ обоих видов (рулинг R-11): uuid записей и ключи реестра (`user/*`, подписки, встроенные
   * `orbis/*`) — любые строковые значения `id`/`source_id`/`target_id`/`entity_id` в операциях и inverse, в порядке
   * операций. Это прежняя ширина окна конфликтов отката прогона; `entityIds` — только записи графа (uuid). Не
   * колонка: вычисляется из операций при чтении.
   */
  touchedKeys: string[];
  operations: ActionOperation[];
  inverse: ActionOperation[];
  results?: unknown[];
  textSession: boolean;
  bodyBefore: Record<string, string | null> | null;
  undoes: string | null;
  pinnedVersionIds: string[];
  cardInReply: boolean;
}

/** Непрозрачный курсор (время, ключ хранилища): ключ — id строки журнала (id действия или записи отмены). */
export interface JournalCursor {
  at: Date;
  key: string;
}

const TOUCHED_KEYS = ['id', 'source_id', 'target_id', 'entity_id'] as const;

/**
 * Каноничный uuid. Строже прежнего `[0-9a-f-]{36}` отбора: колонка `entity_ids` и ключи таблицы — тип uuid, и строка
 * из 36 знаков не той формы уронила бы запись журнала, а не «не записью графа».
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** id снаружи (аргумент CLI, клиент) — не uuid: такой строки в журнале нет и быть не может, отвечаем «нет». */
const isUuid = (v: string): boolean => UUID_RE.test(v);

/**
 * Записи, затронутые действием: `entity_id` и uuid-значения ключей `TOUCHED_KEYS` в операциях И в inverse.
 * Обе половины — потому что у `entity_create` операция несёт id новой записи, а у relation-операций id связи в
 * payload'е нет вовсе, зато есть концы (`source_id`/`target_id`). Только uuid: у реестровых операций `id` — ключ
 * аспекта или свойства, а не запись графа, и затронутой записью он не является. Колонка `entity_ids` и строки
 * боковой таблицы пишутся ЭТОЙ функцией (синк) и её SQL-двойником в переносе (`journal/transfer.ts`).
 */
export function touchedEntityIds(
  action: Pick<ActionRecord, 'entity_id' | 'operations' | 'inverse'>,
): string[] {
  const out = new Set<string>();
  if (action.entity_id) out.add(action.entity_id);
  for (const op of [...action.operations, ...action.inverse]) {
    for (const k of TOUCHED_KEYS) {
      const v = op.payload[k];
      if (typeof v === 'string' && UUID_RE.test(v)) out.add(v);
    }
  }
  return [...out];
}

/**
 * Затронутые ключи обоих видов (R-11) — ровно прежний отбор отката прогона (`rollback.ts` `operationIds` до задачи 4):
 * любая строка под `TOUCHED_KEYS` в операциях, затем в inverse, без повторов. Не только uuid: подписка, аспект или
 * переопределение встроенного свойства адресуются ключом реестра, и правка владельца по нему — такой же конфликт
 * отката, как правка записи.
 */
export function touchedKeysOf(action: Pick<ActionRecord, 'operations' | 'inverse'>): string[] {
  const out = new Set<string>();
  for (const op of [...action.operations, ...action.inverse]) {
    for (const k of TOUCHED_KEYS) {
      const v = op.payload[k];
      if (typeof v === 'string') out.add(v);
    }
  }
  return [...out];
}

/**
 * Осознанный потолок выборки скана перекатегоризаций (K18 / урок C6; потребитель — эскалация `ai/escalation.ts`).
 * Скан отвечает на вопрос «есть ли ЕЩЁ хоть одно такое же исправление», а не считает их все, поэтому усечение
 * сверху может только НЕ предложить правило и никогда не предложит лишнего; наружу счётчик не уходит. 200
 * подходящих записей журнала за 30 дней — заведомо выше живого потока ручных рекатегоризаций.
 */
export const JOURNAL_SCAN_LIMIT = 200;

// ─────────────────────────── строка таблицы и её разбор ───────────────────────────

/** Строка `action_journal` сырым SQL (имена колонок). Массивы — `to_jsonb`: одинаково разбираются обоими драйверами. */
interface Row {
  graph_id: string;
  id: string;
  created_at: unknown;
  type: string;
  entity_id: string | null;
  actor_user_id: string;
  actor_kind: string;
  source: string;
  mechanism: string;
  actor_grant_id: string | null;
  run_id: string | null;
  action_id: string | null;
  module: string | null;
  edited_from: string | null;
  thread_id: string | null;
  title: string;
  card_tool: string;
  entity_ids: unknown;
  operations: unknown;
  inverse: unknown;
  results: unknown;
  text_session: boolean;
  body_before: unknown;
  undoes: string | null;
  pinned_version_ids: unknown;
  card_in_reply: boolean;
}

/**
 * Список колонок строки под алиасом `j`. uuid — текстом, массивы uuid — jsonb: у drizzle `tx.execute` и у сырого
 * postgres.js (`exportJournalRaw`) разбор типов разный (drizzle гасит date-парсеры, массивы uuid без парсера), а
 * текст и jsonb разбираются одинаково.
 */
const COLUMNS = sql`j.graph_id::text AS graph_id, j.id::text AS id, j.created_at, j.type,
       j.entity_id::text AS entity_id, j.actor_user_id::text AS actor_user_id, j.actor_kind, j.source, j.mechanism,
       j.actor_grant_id::text AS actor_grant_id, j.run_id::text AS run_id, j.action_id, j.module,
       j.edited_from::text AS edited_from, j.thread_id::text AS thread_id, j.title, j.card_tool,
       to_jsonb(j.entity_ids) AS entity_ids, j.operations, j.inverse, j.results, j.text_session, j.body_before,
       j.undoes::text AS undoes, to_jsonb(j.pinned_version_ids) AS pinned_version_ids, j.card_in_reply`;

const SELECT_ROW = sql`SELECT ${COLUMNS} FROM action_journal j`;

/** Типы записей-пачек (РП-12): повтор пачки распознаётся только по записи такого типа. */
const IS_BATCH = sql`j.type IN ('batch', 'action')`;

/** timestamptz из сырого SQL: drizzle отключает date-парсеры postgres.js — строка PG (как в wire.ts). */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') return JSON.parse(value) as T[];
  return [];
}

function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * Строка → запись журнала. Необязательные поля действия (`actorGrantId`, `runId`, `actionId`, `module`,
 * `editedFrom`, `results`) — по наличию значения: NULL колонки = ключа нет (прежний `ActionRecord` писал их по
 * наличию, и проверки атрибуции «ключа нет вовсе» опираются на это). Строка БД — граница внешнего мира: граф и
 * актор получают бренды парсером, а не приведением.
 */
function entryFromRow(row: Row): JournalEntry {
  const operations = jsonArray<ActionOperation>(row.operations);
  const inverse = jsonArray<ActionOperation>(row.inverse);
  const results = jsonValue(row.results);
  const bodyBefore = jsonValue(row.body_before);
  return {
    id: row.id,
    graphId: parseGraphId(row.graph_id),
    createdAt: toDate(row.created_at),
    type: row.type as JournalEntry['type'],
    entityId: row.entity_id,
    actorUserId: parseAccountId(row.actor_user_id),
    actorKind: row.actor_kind as ActorKind,
    source: row.source as MutationSource,
    mechanism: row.mechanism as MutationMechanism,
    ...(row.actor_grant_id !== null && { actorGrantId: row.actor_grant_id }),
    ...(row.run_id !== null && { runId: row.run_id }),
    ...(row.action_id !== null && { actionId: row.action_id }),
    ...(row.module !== null && { module: row.module }),
    ...(row.edited_from !== null && { editedFrom: row.edited_from }),
    threadId: row.thread_id,
    title: row.title,
    cardTool: row.card_tool,
    entityIds: jsonArray<string>(row.entity_ids),
    touchedKeys: touchedKeysOf({ operations, inverse }),
    operations,
    inverse,
    ...(results !== null && results !== undefined && { results: results as unknown[] }),
    textSession: row.text_session,
    bodyBefore: (bodyBefore ?? null) as Record<string, string | null> | null,
    undoes: row.undoes,
    pinnedVersionIds: jsonArray<string>(row.pinned_version_ids),
    cardInReply: row.card_in_reply,
  };
}

type Cursored = JournalEntry & { cursor: JournalCursor };

const withCursor = (e: JournalEntry): Cursored => ({
  ...e,
  cursor: { at: e.createdAt, key: e.id },
});

async function entriesOf(tx: Tx, query: SQL): Promise<JournalEntry[]> {
  return ((await tx.execute(query)) as unknown as Row[]).map(entryFromRow);
}

async function firstEntry(tx: Tx, query: SQL): Promise<JournalEntry | undefined> {
  return (await entriesOf(tx, query))[0];
}

const inGraph = (graph: GraphId): SQL => sql`j.graph_id = ${graph}::uuid`;

/** Действие — не запись отмены (К-22). Явно в каждой пробе «действия». */
const IS_ACTION = sql`j.type <> 'undo'`;

/**
 * Время ПОСЛЕДНЕГО ИЗМЕНЕНИЯ записи журнала (§8.5): у сеанса правки текста, пока колонка действия тела его записи
 * указывает на него, — время изменения тела (сеанс продолжается без новых строк журнала); у остальных — время записи.
 * «Отмени последнее» и контекст модели упорядочивают по нему: «последнее, что я сделал» — это сеанс, в котором человек
 * только что печатал, а не галочка, поставленная посреди набора. Сеанс, чью колонку сменила следующая запись, — по
 * времени начала (конец неизвестен, цена §16). Нужна связка `SESSION_ENTITY`.
 *
 * Цена: порядок по выражению не берётся индексом `(graph_id, created_at)` — выборка «последнего» просматривает
 * действия графа целиком (записи сеансов сжимают журнал правок текста в разы, и ради порядка индекс не заводится —
 * миграций сверх трёх в плане нет).
 */
const LAST_CHANGE = sql`CASE WHEN j.text_session AND e.body_action_id = j.id THEN e.body_changed_at ELSE j.created_at END`;

/** Запись графа строки журнала — источник времени последнего изменения сеанса (`LAST_CHANGE`). */
const SESSION_ENTITY = sql`LEFT JOIN entities e ON e.graph_id = j.graph_id AND e.id = j.entity_id`;

/** Строго после курсора в порядке журнала `(created_at, id)`. */
const afterCursor = (c: JournalCursor): SQL =>
  sql`(j.created_at, j.id) > (${c.at.toISOString()}::timestamptz, ${c.key}::uuid)`;

function uuidArray(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

// ─────────────────────────────── функции API ───────────────────────────────

/** Действие по id (не запись отмены). Ключ строки — `(graph_id, id)`. */
export async function findAction(
  tx: Tx,
  graph: GraphId,
  actionId: string,
): Promise<JournalEntry | undefined> {
  if (!isUuid(actionId)) return undefined;
  return firstEntry(
    tx,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND j.id = ${actionId}::uuid AND ${IS_ACTION}`,
  );
}

/**
 * Запись пачки по её `batch_id` (повтор пачки: исполнитель, перенос бюджета, план→факт, импорт, «Принять»). Ключ
 * строки пачки — сам batch_id. Найденная запись обязана быть пачкой (`type ∈ batch|action`, РП-12): в таблице id
 * одиночного действия и batch_id пачки — одно пространство ключей, и клиентский `batch_id`, совпавший с id
 * одиночного действия, иначе вернул бы «повтор» чужой записи.
 */
export async function findBatch(
  tx: Tx,
  graph: GraphId,
  batchId: string,
): Promise<JournalEntry | undefined> {
  if (!isUuid(batchId)) return undefined;
  return firstEntry(
    tx,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND j.id = ${batchId}::uuid AND ${IS_BATCH}`,
  );
}

/** Действие отменено ⇔ есть запись отмены с его id (§7.8); уникальный индекс `(graph_id, undoes)`. */
export async function isUndone(tx: Tx, graph: GraphId, actionId: string): Promise<boolean> {
  if (!isUuid(actionId)) return false;
  const rows = await tx.execute(
    sql`SELECT 1 AS hit FROM action_journal j WHERE ${inGraph(graph)} AND j.undoes = ${actionId}::uuid LIMIT 1`,
  );
  return rows.length > 0;
}

/** Запись отмены действия — единственный путь к записям отмены по действию (К-22). */
export async function undoRecordOf(
  tx: Tx,
  graph: GraphId,
  actionId: string,
): Promise<JournalEntry | undefined> {
  if (!isUuid(actionId)) return undefined;
  return firstEntry(
    tx,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND j.undoes = ${actionId}::uuid LIMIT 1`,
  );
}

/**
 * Запись отмены ПО ЕЁ СОБСТВЕННОМУ id (не по отменённому действию, как `undoRecordOf`): раскрутка цепочки «действие
 * тела до» (§8.6, `executor/body-chain.ts`) встречает id записи отмены в колонке действия тела записи графа и должна
 * узнать, что это отмена и что она отменила. Не запись отмены (действие, чужой граф, нет строки) — `undefined`.
 */
export async function undoRecordById(
  tx: Tx,
  graph: GraphId,
  undoRecordId: string,
): Promise<JournalEntry | undefined> {
  if (!isUuid(undoRecordId)) return undefined;
  return firstEntry(
    tx,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND j.id = ${undoRecordId}::uuid AND j.type = 'undo'`,
  );
}

/**
 * ЖИВОЕ действие по id — действие (не запись отмены) и не отменённое — одним запросом; иначе `undefined`. Ровно у такого
 * действия в колонке «действие тела» раскрутка цепочки (`executor/body-chain.ts`, `effectiveBodyAction`) вернула бы
 * саму колонку, и ответ «действующее действие текущего тела» (§8.2, К-37) обходится без неё.
 */
export async function liveActionOf(
  tx: Tx,
  graph: GraphId,
  actionId: string,
): Promise<JournalEntry | undefined> {
  if (!isUuid(actionId)) return undefined;
  return firstEntry(
    tx,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND j.id = ${actionId}::uuid AND ${IS_ACTION}
          AND NOT EXISTS (SELECT 1 FROM action_journal u WHERE u.graph_id = j.graph_id AND u.undoes = j.id)`,
  );
}

/**
 * Колонки тела записи и ЖИВОЕ действие её колонки «действие тела» (`liveActionOf`) — одним запросом: чтение записи
 * (горячий путь экрана) не платит за раскрутку. `live: null` — живого нет (колонка пуста, запись отмены, отменённое,
 * перенесённое): раскрутку делает вызывающий. Записи не видно — `undefined`.
 */
export async function bodyColumnProbe(
  tx: Tx,
  graph: GraphId,
  entityId: string,
): Promise<
  | { id: string; bodyActionId: string | null; bodyChangedAt: Date; live: JournalEntry | null }
  | undefined
> {
  if (!isUuid(entityId)) return undefined;
  const rows = (await tx.execute(sql`
    SELECT e.id::text AS e_id, e.body_action_id::text AS e_body_action_id, e.body_changed_at AS e_body_changed_at,
           ${COLUMNS}
      FROM entities e
      LEFT JOIN LATERAL (
        SELECT * FROM action_journal a
         WHERE a.graph_id = e.graph_id AND a.id = e.body_action_id AND a.type <> 'undo'
           AND NOT EXISTS (SELECT 1 FROM action_journal u WHERE u.graph_id = a.graph_id AND u.undoes = a.id)
      ) j ON true
     WHERE e.graph_id = ${graph}::uuid AND e.id = ${entityId}::uuid`)) as unknown as Array<
    // Колонки журнала пусты, когда живого действия нет (LEFT JOIN)
    Omit<Row, 'id'> & {
      id: string | null;
      e_id: string;
      e_body_action_id: string | null;
      e_body_changed_at: unknown;
    }
  >;
  const row = rows[0];
  if (row === undefined) return undefined;
  const { id, ...rest } = row;
  return {
    id: row.e_id,
    bodyActionId: row.e_body_action_id,
    bodyChangedAt: toDate(row.e_body_changed_at),
    live: id === null ? null : entryFromRow({ ...rest, id }),
  };
}

/**
 * «Последнее отменяемое» (§7.8): последнее по времени действие, не `system` и не отменённое; записи отмены — не
 * действия (К-22). Системные действия (материализация повторов §5.4, скрытая из ленты) пропускаются: «отмени
 * последнее» — последнее ВИДИМОЕ владельцу, иначе отмена молча архивировала бы инстансы вместо «обед 340» (fix round
 * A3). Точечная отмена системного действия по id остаётся возможной (§2.8, путь A5). Порядок — по времени последнего
 * изменения (`LAST_CHANGE`, сеанс правки текста §8.5), затем `id DESC` (тай-брейк: precision 3).
 */
export async function findLastUndoable(tx: Tx, graph: GraphId): Promise<JournalEntry | undefined> {
  return firstEntry(
    tx,
    sql`${SELECT_ROW} ${SESSION_ENTITY}
        WHERE ${inGraph(graph)} AND ${IS_ACTION} AND j.source <> 'system'
          AND NOT EXISTS (SELECT 1 FROM action_journal u WHERE u.graph_id = j.graph_id AND u.undoes = j.id)
        ORDER BY ${LAST_CHANGE} DESC, j.id DESC
        LIMIT 1`,
  );
}

/**
 * Действия прогона в порядке журнала (`created_at, id`) — индекс `action_journal_run`. Отбор «своё/о прогоне» —
 * политика отката у вызывающего.
 */
export async function runActions(
  tx: Tx,
  graph: GraphId,
  runId: string,
): Promise<Array<JournalEntry & { cursor: JournalCursor }>> {
  if (!isUuid(runId)) return [];
  return (
    await entriesOf(
      tx,
      sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND j.run_id = ${runId}::uuid AND ${IS_ACTION}
          ORDER BY j.created_at ASC, j.id ASC`,
    )
  ).map(withCursor);
}

/**
 * Действия после курсора (строго: составной ключ `(created_at, id)`, как порядок `runActions`), тронувшие хоть один
 * из КЛЮЧЕЙ `keys` — uuid записей или ключ реестра (`touchedKeys`, рулинг R-11: прежняя ширина окна конфликтов отката);
 * записи отмены — не действия (К-22). Отменённые действия НЕ отсеиваются: решает вызывающий (откат прогона спрашивает
 * `isUndone` только у настоящих кандидатов).
 *
 * Две формы пробы. Только uuid записей — боковая таблица (btree `(graph_id, entity_id, created_at)` под RLS, РП-8).
 * Есть ключ реестра — в боковой таблице его нет (она про записи графа), и окно просматривается целиком по индексу
 * `(graph_id, created_at)`: окно открывается первым действием прогона и короткое. Итоговый отбор в обоих случаях —
 * по `touchedKeys`, тем же правилом, что было у отката до таблицы.
 */
export async function actionsTouchingAfter(
  tx: Tx,
  graph: GraphId,
  after: JournalCursor,
  keys: string[],
): Promise<Array<JournalEntry & { cursor: JournalCursor }>> {
  if (keys.length === 0) return [];
  const wanted = new Set(keys);
  const entityKeys = keys.filter(isUuid);
  const query =
    entityKeys.length === keys.length
      ? sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND ${IS_ACTION} AND ${afterCursor(after)}
              AND EXISTS (SELECT 1 FROM action_journal_entities e
                           WHERE e.graph_id = j.graph_id AND e.action_id = j.id
                             AND e.entity_id = ANY(${uuidArray(entityKeys)}))
            ORDER BY j.created_at ASC, j.id ASC`
      : sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND ${IS_ACTION} AND ${afterCursor(after)}
            ORDER BY j.created_at ASC, j.id ASC`;
  return (await entriesOf(tx, query))
    .filter((e) => e.touchedKeys.some((key) => wanted.has(key)))
    .map(withCursor);
}

/**
 * Действия, чьи ОПЕРАЦИИ правили саму запись (`payload.id` — проба R-18 поставки), новые первыми, не больше
 * `limit`; записи отмены — не действия (К-22). Кандидаты — по боковой таблице (все действия, тронувшие запись);
 * дофильтр — по операциям: связь с записью (`source_id`/`target_id`) правкой записи не считается, и связь, легшая
 * после «добавить», ответа R-18 не меняет. Отменённые не отсеиваются — обход R-18 проходит отменённые правки сам.
 */
export async function actionsOnEntity(
  tx: Tx,
  graph: GraphId,
  entityId: string,
  limit: number,
): Promise<JournalEntry[]> {
  if (!isUuid(entityId)) return [];
  const probe = JSON.stringify([{ payload: { id: entityId } }]);
  return entriesOf(
    tx,
    sql`${SELECT_ROW}
          JOIN action_journal_entities e ON e.graph_id = j.graph_id AND e.action_id = j.id
        WHERE e.graph_id = ${graph}::uuid AND e.entity_id = ${entityId}::uuid AND ${IS_ACTION}
          AND j.operations @> ${probe}::jsonb
        ORDER BY e.created_at DESC, j.id DESC
        LIMIT ${limit}`,
  );
}

/** Последнее действие, чьи операции правили запись (см. `actionsOnEntity`); без записей отмены. */
export async function lastActionTouching(
  tx: Tx,
  graph: GraphId,
  entityId: string,
): Promise<JournalEntry | undefined> {
  return (await actionsOnEntity(tx, graph, entityId, 1))[0];
}

/**
 * Правки, ПЕРЕНОСИВШИЕ что-то в одну из категорий, после `since`, новые первыми, не больше `JOURNAL_SCAN_LIMIT`;
 * отменённые и записи отмены не попадают («исправил → отменил → исправил» — не два исправления; отмена, вернувшая
 * запись в категорию, — не исправление, К-22).
 *
 * Типы — ЯВНЫЙ перечень `entity_updated`, `batch`, `action` (§Б6-4): он же исключает записи отмены (у них тип
 * `undo`, а операции — inverse, т. е. тоже `entity_update` с категорией) и берёт индекс `(graph_id, type,
 * created_at)`. ПРОБА ИДЁТ ПО ЗНАЧЕНИЮ, а не по наличию ключа: категория — плоское свойство-строка, и
 * `{props: {orbis/finance_category: {}}}` не содержится в ней никогда, а `{props: {}}` затянул бы под пробу любую
 * правку любого свойства. `op:'entity_update'` обязателен: без него под пробу попадал бы каждый batch, в котором
 * финансовая запись СОЗДАВАЛАСЬ с этой категорией (журнал `entity_create` несёт всё состояние).
 */
export async function financialUpdatesSince(
  tx: Tx,
  graph: GraphId,
  since: Date,
  categoryIds: string[],
): Promise<JournalEntry[]> {
  const targets = [...new Set(categoryIds)];
  if (targets.length === 0) return [];
  const matches = sql.join(
    targets.map(
      (category) =>
        sql`j.operations @> ${JSON.stringify([
          { op: 'entity_update', payload: { props: { 'orbis/finance_category': category } } },
        ])}::jsonb`,
    ),
    sql` OR `,
  );
  return entriesOf(
    tx,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)}
          AND j.type IN ('entity_updated', 'batch', 'action')
          AND j.created_at > ${since.toISOString()}::timestamptz
          AND (${matches})
          AND NOT EXISTS (SELECT 1 FROM action_journal u WHERE u.graph_id = j.graph_id AND u.undoes = j.id)
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT ${JOURNAL_SCAN_LIMIT}`,
  );
}

/** Какие из `ids` — исполненные пачки (судьба «принято» у единиц прогона, `listRunUnits`); запись — пачка (РП-12). */
export async function executedIds(tx: Tx, graph: GraphId, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const keys = ids.filter(isUuid);
  if (keys.length === 0) return out;
  const rows = (await tx.execute(
    sql`SELECT j.id::text AS id FROM action_journal j
         WHERE ${inGraph(graph)} AND j.id = ANY(${uuidArray(keys)}) AND ${IS_BATCH}`,
  )) as unknown as Array<{ id: string }>;
  const found = new Set(rows.map((r) => r.id));
  for (const id of ids) if (found.has(id.toLowerCase())) out.add(id);
  return out;
}

/** Последнее `module_set` по расширению в операциях (порядок исполнения); `undefined` — операции нет. */
function lastExtensionSwitch(ops: readonly ActionOperation[], module: string): boolean | undefined {
  let enabled: boolean | undefined;
  for (const op of ops) {
    if (op.op === 'module_set' && op.payload.module === module) {
      enabled = op.payload.enabled === true;
    }
  }
  return enabled;
}

/**
 * Последнее слово владельца о расширении: действие с операцией `module_set` по нему (одиночное или внутри пачки
 * `app.setDisabled` — проба по ОПЕРАЦИИ, а не по типу, финал 1б, М-9, М-10). Отмена — тоже слово: если последнее
 * такое действие отменено, слово — его inverse (прежнее состояние) во время отмены. `undefined` — владелец о
 * расширении не говорил. Типы — одиночное переключение и пачки (индекс `(graph_id, type, created_at)`).
 *
 * Имя — `ownerExtensionWord`, а не `ownerModuleWord` контракта плана: «module» в именах кода — только имена провода
 * и отказа (РП-10, сторож `scripts/code-boundaries.test.ts` (3)); слово словаря — «расширение».
 */
export async function ownerExtensionWord(
  tx: Tx,
  graph: GraphId,
  module: string,
): Promise<{ enabled: boolean; at: Date } | undefined> {
  const probe = JSON.stringify([{ op: 'module_set', payload: { module } }]);
  const said = await firstEntry(
    tx,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND j.type IN ('module_set', 'batch', 'action')
          AND j.operations @> ${probe}::jsonb
        ORDER BY j.created_at DESC, j.id DESC LIMIT 1`,
  );
  if (said === undefined) return undefined;
  const enabled = lastExtensionSwitch(said.operations, module) ?? false;
  const undo = await undoRecordOf(tx, graph, said.id);
  if (undo === undefined) return { enabled, at: said.createdAt };
  return { enabled: lastExtensionSwitch(said.inverse, module) ?? !enabled, at: undo.createdAt };
}

/** Строго до курсора журнала в порядке `(created_at DESC, id DESC)`. */
function beforeCursor(before: JournalCursor | undefined): SQL {
  if (before === undefined) return sql``;
  return sql`AND (j.created_at, j.id) < (${before.at.toISOString()}::timestamptz, ${before.key}::uuid)`;
}

/**
 * Журнал треда — действия и записи отмены, новые первыми (`created_at DESC, id DESC`, индекс
 * `action_journal_thread_time`), страница `limit` строго до курсора `before`.
 */
export async function threadActions(
  tx: Tx,
  graph: GraphId,
  threadId: string,
  page: { before?: JournalCursor; limit: number },
): Promise<Array<JournalEntry & { cursor: JournalCursor }>> {
  return (
    await entriesOf(
      tx,
      sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND j.thread_id = ${threadId}::uuid ${beforeCursor(page.before)}
          ORDER BY j.created_at DESC, j.id DESC
          LIMIT ${page.limit}`,
    )
  ).map(withCursor);
}

/**
 * id строки журнала В ВЫДАЧЕ ТРЕДА (рулинг R-12) — производный и детерминированный от ключа записи `(graph_id, id)`:
 * md5 строки `orbis-journal-item:<граф>:<id>`, приведённый к uuid.
 *
 * Почему не сам id записи: выдача треда — один поток из двух таблиц, и id его элементов обязаны быть уникальны. У
 * одобренной единицы ключ записи пачки — `pendingId` (`approvePending` исполняет пачку с `batchId = pendingId`), а
 * `pendingId` — это и PK сообщения-карточки запроса в том же треде: с id записи оба элемента пришли бы с одним id
 * (React-ключ, дедуп клиента по id, склейка у агента), а курсор `(время, id)` на их стыке при равном времени терял бы
 * один из них. Хранимые ключи и идемпотентность пачки (РП-12) при этом не меняются — меняется только провод; id
 * действия элемент несёт в сводке (`metadata.journal.actionId`), а карточки ленты — в `undoActionId`.
 *
 * Почему в SQL, а не в TS: порядок выдачи и курсор страницы обязаны идти по ТОМУ ЖЕ ключу, что id на проводе (клиент
 * строит курсор из `createdAt|id` последнего элемента), — значит, выборка журнала сортирует и режет по нему, и
 * вычисляется он одним местом. `md5` — ядро PG, без расширений.
 */
const THREAD_ITEM_ID = sql`md5('orbis-journal-item:' || j.graph_id::text || ':' || j.id::text)::uuid`;

/** Строго до курсора выдачи треда по `(created_at, id элемента на проводе)`; без id — строго раньше по времени. */
function beforeItemCursor(before: { at: Date; key?: string } | undefined): SQL {
  if (before === undefined) return sql``;
  const at = sql`${before.at.toISOString()}::timestamptz`;
  if (before.key === undefined) return sql`AND j.created_at < ${at}`;
  // Разложено на `created_at <= …` (диапазон индекса треда) и тай-брейк по производному id — выражению, а не колонке
  return sql`AND j.created_at <= ${at} AND (j.created_at < ${at} OR ${THREAD_ITEM_ID} < ${before.key}::uuid)`;
}

/** Срок маркера «думает» интервалом SQL (рулинг R-13): граница «ход ещё идёт» для действий разговора. */
const PROCESSING_TTL = sql`(${PROCESSING_TTL_MS}::int * interval '1 millisecond')`;

/**
 * Действие разговора с карточкой в ответе (`card_in_reply`), чей ход ОБОРВАЛСЯ (рулинг R-13): старше срока маркера
 * «думает», и ни один ответ ассистента этого треда в пределах того же срока не несёт его карточку (`undoActionId`).
 * Смерть процесса между действием и ответом (перезапуск при деплое, OOM) не проходит через путь сбоя (К-44), и без
 * этого у действия не было бы карточки нигде (§11.3: на действие — ровно одна). Моложе срока — ход, возможно, ещё
 * идёт: строка появилась бы и пропала с ответом (мигание). Ответ ищется только в окне `[время действия, + срок)` по
 * индексу `(thread_id, created_at)` — не сканом всех ответов треда; ответ позже срока (ход дольше, чем живёт маркер,
 * — его к тому моменту сочли мёртвым) оставит обе карточки — принятая цена рулинга.
 */
const ORPHAN_REPLY_CARD = sql`(j.created_at < now() - ${PROCESSING_TTL}
  AND NOT EXISTS (
    SELECT 1 FROM chat_messages r
     WHERE r.thread_id = j.thread_id AND r.role = 'assistant'
       AND r.created_at >= j.created_at AND r.created_at < j.created_at + ${PROCESSING_TTL}
       AND r.metadata -> 'cards' @> jsonb_build_array(jsonb_build_object('undoActionId', j.id::text))))`;

/**
 * Карточки журнала в выдаче треда (`journal/thread-page.ts`, спека §11.3): действия треда, которые тред показывает, —
 * без записей отмены (своей строки у отмены нет, К-45: «отменено» — признак строки отменённого, `undone`), без
 * `system` (материализация и прод-операции; новых таких строк в тредах нет — синк треда им не даёт, фильтр держит
 * прежние) и без действий, чью карточку несёт ответ ассистента (`card_in_reply`, К-36: на действие — одна карточка),
 * кроме оборванных (`ORPHAN_REPLY_CARD`, R-13): у них карточки в ответе нет, и строка — единственный носитель.
 * Каждая запись — со своим id элемента треда (`itemId`, см. `THREAD_ITEM_ID`); порядок и курсор — `(created_at DESC,
 * itemId DESC)` по uuid-выражению, как у сообщений треда по их PK (uuid). Курсор без id (легаси-форма клиента
 * `<iso>`) — строго раньше по времени.
 */
export async function threadFeed(
  tx: Tx,
  graph: GraphId,
  threadId: string,
  page: { before?: { at: Date; key?: string }; limit: number },
): Promise<Array<JournalEntry & { itemId: string; undone: boolean }>> {
  const rows = (await tx.execute(
    sql`SELECT ${COLUMNS}, ${THREAD_ITEM_ID}::text AS item_id,
               EXISTS (SELECT 1 FROM action_journal u WHERE u.graph_id = j.graph_id AND u.undoes = j.id) AS undone
          FROM action_journal j
         WHERE ${inGraph(graph)} AND j.thread_id = ${threadId}::uuid
           AND ${IS_ACTION} AND j.source <> 'system' AND (NOT j.card_in_reply OR ${ORPHAN_REPLY_CARD})
           ${beforeItemCursor(page.before)}
         ORDER BY j.created_at DESC, ${THREAD_ITEM_ID} DESC
         LIMIT ${page.limit}`,
  )) as unknown as Array<Row & { item_id: string; undone: boolean }>;
  return rows.map((row) => ({ ...entryFromRow(row), itemId: row.item_id, undone: row.undone }));
}

/**
 * Отметки отмены для действий `actionIds`: id действия → когда и каким путём отменено (запись отмены, К-45). Одна
 * выборка по уникальному индексу `(graph_id, undoes)`. Читатели — карточки ответов ассистента в выдаче треда (у них
 * нет своей строки журнала, R-14) и блок «Недавние правки владельца» контекста модели (у отмены правки владельца нет
 * треда). id не uuid (форма из будущего или мусор в сохранённой карточке) — не действие, пропускается.
 */
export async function undoMarks(
  tx: Tx,
  graph: GraphId,
  actionIds: readonly string[],
): Promise<Map<string, { at: Date; path: UndoPath }>> {
  const ids = [...new Set(actionIds.filter(isUuid))];
  if (ids.length === 0) return new Map();
  const rows = (await tx.execute(
    sql`SELECT j.undoes::text AS undoes, j.created_at, j.source FROM action_journal j
         WHERE ${inGraph(graph)} AND j.undoes = ANY(${uuidArray(ids)})`,
  )) as unknown as Array<{ undoes: string; created_at: unknown; source: string }>;
  return new Map(
    rows.map((r) => [r.undoes, { at: toDate(r.created_at), path: r.source as UndoPath }]),
  );
}

/**
 * Запас окна `recentOwnerEdits` назад по времени ЗАПИСИ — ради сеансов правки текста, начатых до окна и продолженных в
 * нём. Сеанс живёт, только пока паузы набора короче 10 минут (§8.5); сеанс, начатый раньше границы окна больше чем на
 * 6 часов и всё ещё продолжаемый в окне, — это шесть часов набора без единой 10-минутной паузы. Такой в блок не
 * попадёт — граница названа, а не спрятана: блок правок — подсказка модели, не журнал. Больший запас стоил бы
 * соразмерно большего диапазона на каждом ходе чата, а точное «продолжен в окне» без запаса требует индекса по времени
 * изменения тела, которого нет (миграция).
 */
export const OWNER_EDITS_SESSION_MARGIN_MS = 6 * 60 * 60 * 1000;

/**
 * Недавние правки владельца в интерфейсе (`ui`, `quick_capture`), изменённые последний раз не раньше `since`, новые
 * первыми, не больше `limit`; записи отмены — не правки (К-22). «Изменённые последний раз» — `LAST_CHANGE`: сеанс
 * правки текста, начатый до окна, но продолженный в нём, — свежая правка (§8.5).
 *
 * Горячий путь — каждый ход чата (`llm/context.ts`). Поэтому окно — ДИАПАЗОН по времени записи (`j.created_at`, индекс
 * `action_journal_graph_time`) с запасом `OWNER_EDITS_SESSION_MARGIN_MS`, а время последнего изменения (выражение над
 * присоединённой записью, индексом не берётся) — фильтр и порядок уже внутри диапазона: журнал графа целиком не
 * просматривается. Раз `LAST_CHANGE ≥ created_at`, запас ничего лишнего в ответ не пускает — только даёт увидеть сеанс.
 */
export async function recentOwnerEdits(
  tx: Tx,
  graph: GraphId,
  since: Date,
  limit: number,
): Promise<JournalEntry[]> {
  const from = new Date(since.getTime() - OWNER_EDITS_SESSION_MARGIN_MS);
  return entriesOf(
    tx,
    sql`${SELECT_ROW} ${SESSION_ENTITY}
        WHERE ${inGraph(graph)} AND ${IS_ACTION}
          AND j.source IN ('ui', 'quick_capture')
          AND j.created_at >= ${from.toISOString()}::timestamptz
          AND ${LAST_CHANGE} >= ${since.toISOString()}::timestamptz
        ORDER BY ${LAST_CHANGE} DESC, j.id DESC
        LIMIT ${limit}`,
  );
}

/** Записи журнала графа по времени (`created_at, id`), включая записи отмены; страница — строго после курсора. */
function exportQuery(graph: GraphId, page?: { after?: JournalCursor; limit: number }): SQL {
  const after = page?.after === undefined ? sql`` : sql`AND ${afterCursor(page.after)}`;
  const limit = page === undefined ? sql`` : sql`LIMIT ${page.limit}`;
  return sql`${SELECT_ROW} WHERE ${inGraph(graph)} ${after}
    ORDER BY j.created_at ASC, j.id ASC ${limit}`;
}

export async function exportJournal(tx: Tx, graph: GraphId): Promise<JournalEntry[]> {
  return entriesOf(tx, exportQuery(graph));
}

/**
 * `exportJournal` сырым клиентом postgres.js ПОРЦИЯМИ — для прод-операций (`db/migrate-1v.ts` `--report`), которые
 * читают базу ролью с BYPASSRLS в транзакции READ ONLY мимо drizzle и не тянут журнал графа в память целиком. Запрос —
 * ТОТ ЖЕ (`exportQuery`, отрисованный диалектом drizzle), разбор — тот же: хранилище читается здесь одним местом и для
 * них. Курсор (`cursor.key` — id строки журнала) — адрес строки для отчёта.
 */
export async function exportJournalRaw(
  client: ISql,
  graph: GraphId,
  page: { after?: JournalCursor; limit: number },
): Promise<Cursored[]> {
  const q = new PgDialect().sqlToQuery(exportQuery(graph, page));
  const rows = (await client.unsafe(q.sql, q.params as never[])) as unknown as Row[];
  return rows.map(entryFromRow).map(withCursor);
}

/**
 * Запись журнала → прежняя форма `ActionRecord` — для кода, чей контракт — запись действия (политика отката в
 * `tools/dispatch.ts`, ответ «отмени последнее», повтор пачки синка). Запись отмены действием не является (К-22) —
 * её сюда не передают.
 */
export function actionRecordOf(entry: JournalEntry): ActionRecord {
  if (entry.type === 'undo') {
    throw new Error(`actionRecordOf: запись отмены ${entry.id} — не действие (К-22)`);
  }
  return {
    id: entry.id,
    type: entry.type,
    entity_id: entry.entityId,
    actor_user_id: entry.actorUserId,
    actor_kind: entry.actorKind,
    source: entry.source,
    mechanism: entry.mechanism,
    ...(entry.actorGrantId !== undefined && { actor_grant_id: entry.actorGrantId }),
    ...(entry.runId !== undefined && { run_id: entry.runId }),
    ...(entry.actionId !== undefined && { action_id: entry.actionId }),
    ...(entry.module !== undefined && { module: entry.module }),
    ...(entry.editedFrom !== undefined && { edited_from: entry.editedFrom }),
    operations: entry.operations,
    inverse: entry.inverse,
  };
}
