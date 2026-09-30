// apps/server/src/executor/journal-read.ts — ЕДИНСТВЕННЫЙ читатель журнала действий (РП-9 плана А).
//
// Почему модуль, а не запросы на местах: хранилище журнала меняется (задача 5: сообщения чата → таблица
// action_journal), а читателей ≈15. Пока каждый читатель ходил в chat_messages своим SQL, смена хранилища была бы
// пятнадцатью правками с пятнадцатью шансами разойтись; здесь она — одна. Записи отмены — НЕ действия (спека §11.2,
// К-22): функции поиска «действия» их не отдают никогда; запись отмены достаётся только `undoRecordOf`.
//
// Реализация — ПРЕЖНЕЕ хранилище (ветвление через абстракцию): одно audit-сообщение чата = одно действие
// (`metadata.actions[0]`, инвариант синка `journal.ts`), отмена — сообщение `{type:'undo', undoes}`. SQL каждой
// функции — запрос прежнего читателя, перенесённый сюда с явным `graph_id` (RLS страхует, но прод-операции идут
// ролью с BYPASSRLS, и граф обязан держать сам запрос) и с явным исключением записей отмены там, где ищется
// «действие»: сегодня его держит и форма (у отмены нет `actions`), но в таблице задачи 5 строка отмены несёт
// операции, и правило обязано жить в API, а не в случайности формы.
import type { AccountId, GraphId } from '@orbis/shared';
import { batchAuditMessageId } from '@orbis/shared';
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { ISql } from 'postgres';
import type { Tx } from '../db/with-identity';
import { parseAccountId, parseGraphId } from '../identity';
import type {
  ActionOperation,
  ActionRecord,
  ActorKind,
  MutationMechanism,
  MutationSource,
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
   * операций. Это прежняя ширина окна конфликтов отката прогона; `entityIds` — только записи графа (uuid).
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

/** Непрозрачный курсор (время, ключ хранилища): у прежнего хранилища ключ — id СООБЩЕНИЯ (задача 5 заменит). */
export interface JournalCursor {
  at: Date;
  key: string;
}

const TOUCHED_KEYS = ['id', 'source_id', 'target_id', 'entity_id'] as const;

/**
 * Записи, затронутые действием: `entity_id` и uuid-значения ключей `TOUCHED_KEYS` в операциях И в inverse.
 * Обе половины — потому что у `entity_create` операция несёт id новой записи, а у relation-операций id связи в
 * payload'е нет вовсе, зато есть концы (`source_id`/`target_id`). Только uuid: у реестровых операций `id` — ключ
 * аспекта или свойства, а не запись графа, и затронутой записью он не является.
 */
export function touchedEntityIds(
  action: Pick<ActionRecord, 'entity_id' | 'operations' | 'inverse'>,
): string[] {
  const out = new Set<string>();
  if (action.entity_id) out.add(action.entity_id);
  for (const op of [...action.operations, ...action.inverse]) {
    for (const k of TOUCHED_KEYS) {
      const v = op.payload[k];
      if (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) out.add(v);
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

// ─────────────────────────── прежнее хранилище: строка и её разбор ───────────────────────────

/** Строка журнала прежнего хранилища: сообщение и граф его треда. */
interface Row {
  id: string;
  thread_id: string;
  content: string;
  created_at: unknown;
  metadata: unknown;
  graph_id: string;
}

/**
 * Форма `metadata` audit-сообщения и сообщения отмены (`journal.ts`, `undo.ts`). Запись действия — `ActionRecord`
 * синка, и ей доверяется её форма, как прежним читателям: поле, которого в записи нет, остаётся отсутствующим (не
 * подменяется), — иначе проверки атрибуции и «ключа нет вовсе» перестали бы что-либо держать.
 */
interface LegacyMetadata {
  actions?: Array<ActionRecord | undefined>;
  cards?: Array<{ tool?: unknown; title?: unknown } | undefined>;
  results?: unknown;
  type?: unknown;
  undoes?: unknown;
}

const SELECT_ROW = sql`SELECT m.id::text AS id, m.thread_id::text AS thread_id, m.content, m.created_at,
         m.metadata, t.graph_id::text AS graph_id
    FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id`;

/** Запись отмены прежнего хранилища — сообщение `{type:'undo', undoes}` (`undo.ts`). */
const IS_UNDO = sql`m.metadata @> '{"type": "undo"}'::jsonb`;

/**
 * Действие — сообщение с непустым `actions` И НЕ запись отмены (К-22). Containment `{"actions": []}` и длина —
 * прежний приём `undo.ts`/`rollback.ts`; третье условие — явное правило API, а не форма хранилища.
 */
const IS_ACTION = sql`(m.metadata @> '{"actions": []}'::jsonb
    AND jsonb_array_length(m.metadata -> 'actions') > 0
    AND NOT (m.metadata @> '{"type": "undo"}'::jsonb))`;

/** Типы записей-пачек (РП-12): повтор пачки распознаётся только по записи такого типа. */
const BATCH_TYPES: ReadonlySet<string> = new Set(['batch', 'action']);

/** Тул карточки по типу действия — у карточек `fast_path`/`routine` (`feedCard`) поля `tool` нет. */
const TOOL_OF_TYPE: Readonly<Record<string, string>> = {
  entity_created: 'entity_create',
  entity_updated: 'entity_update',
  relation_created: 'relation_create',
  relation_deleted: 'relation_delete',
  batch: 'batch_execute',
  action: 'batch_execute',
};

/** timestamptz из сырого SQL: drizzle отключает date-парсеры postgres.js — строка PG (как в wire.ts). */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Владелец графа — актор записи отмены прежнего хранилища (своего актора у неё нет, Д-5; так же — у переноса задачи 5).
 * Личный граф (в v1 других нет: INSERT-политика `person_creates_own_graph`) — `owner_ref` = id аккаунта владельца. Под
 * RLS строку графа видит любой его участник (`member_reads_graph`), под BYPASSRLS — все. Читается ОДИН раз на вызов
 * API и только если в выборке есть запись отмены.
 */
const OWNER_OF_GRAPH = (graph: GraphId): SQL =>
  sql`SELECT owner_ref::text AS owner FROM graphs WHERE id = ${graph}::uuid`;

function ownerFrom(value: unknown, graph: GraphId): AccountId {
  if (typeof value !== 'string') {
    throw new Error(
      `журнал: у графа ${graph} нет владельца-аккаунта (owner_ref) — v1 знает только личные графы`,
    );
  }
  return parseAccountId(value);
}

const isUndoRow = (row: Row): boolean => (row.metadata as LegacyMetadata | null)?.type === 'undo';

const str = (v: unknown): v is string => typeof v === 'string';

/**
 * Сообщение → запись журнала; `undefined` — сообщение записью журнала не является. `actionId` выбирает действие
 * по id (как прежний `findActionMessage`), иначе — `actions[0]` (инвариант синка «одно действие на сообщение»);
 * карточка берётся по тому же индексу. Полей, которых в формате сообщения нет вовсе, — значения по умолчанию (бриф
 * задачи 4): `textSession: false`, `bodyBefore: null`, `pinnedVersionIds: []`, `cardInReply: false`; `mechanism` у
 * записей до появления поля — `'user'`. Поля самой записи действия (актор, источник, необязательные ключи) —
 * как лежат: отсутствующее остаётся отсутствующим. `owner` — владелец графа, нужен только записи отмены.
 */
function entryFromRow(
  row: Row,
  owner: AccountId | undefined,
  actionId?: string,
): JournalEntry | undefined {
  const md = (row.metadata ?? {}) as LegacyMetadata;
  const graphId = parseGraphId(row.graph_id);
  const createdAt = toDate(row.created_at);
  const common = {
    graphId,
    createdAt,
    threadId: row.thread_id,
    textSession: false,
    bodyBefore: null,
    pinnedVersionIds: [],
    cardInReply: false,
  };
  if (md.type === 'undo') {
    if (!str(md.undoes)) return undefined;
    // Запись отмены прежнего хранилища несёт только `undoes`: путь, актор и операции не записывались (Д-5).
    // Умолчания — те же, что у переноса задачи 5 (В-3): источник `ui`, актор — владелец графа. Операции записи
    // отмены (применённый inverse, РП-11) берутся из `actions[0]`, если сообщение их несёт: сегодня так не пишет
    // никто, но так выглядит строка отмены таблицы, и правило К-22 обязано держаться и на ней.
    const applied = Array.isArray(md.actions) ? md.actions[0] : undefined;
    const operations = Array.isArray(applied?.operations) ? applied.operations : [];
    if (owner === undefined) throw new Error('журнал: запись отмены без владельца графа'); // недостижимо
    return {
      ...common,
      id: row.id,
      type: 'undo',
      entityId: null,
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      mechanism: 'user',
      title: row.content,
      cardTool: 'undo',
      entityIds: touchedEntityIds({ entity_id: null, operations, inverse: [] }),
      touchedKeys: touchedKeysOf({ operations, inverse: [] }),
      operations,
      inverse: [],
      undoes: md.undoes,
    };
  }
  const actions = Array.isArray(md.actions) ? md.actions : [];
  const at = actionId === undefined ? 0 : actions.findIndex((a) => a?.id === actionId);
  const a = at < 0 ? undefined : actions[at];
  if (a === undefined || !str(a.id)) return undefined;
  const card = Array.isArray(md.cards) ? md.cards[at] : undefined;
  // Защитно только массивы: без них упал бы любой обход операций, а не одна проверка
  const operations = Array.isArray(a.operations) ? a.operations : [];
  const inverse = Array.isArray(a.inverse) ? a.inverse : [];
  const entityId = a.entity_id ?? null;
  const has = (k: keyof ActionRecord): boolean => Object.hasOwn(a, k);
  return {
    ...common,
    id: a.id,
    type: a.type,
    entityId,
    actorUserId: a.actor_user_id,
    actorKind: a.actor_kind,
    source: a.source,
    mechanism: a.mechanism ?? 'user',
    // Необязательные ключи — по НАЛИЧИЮ ключа, а не по значению: запись `module: null` должна быть видна
    ...(has('actor_grant_id') && { actorGrantId: a.actor_grant_id }),
    ...(has('run_id') && { runId: a.run_id }),
    ...(has('action_id') && { actionId: a.action_id }),
    ...(has('module') && { module: a.module }),
    ...(has('edited_from') && { editedFrom: a.edited_from }),
    title: str(card?.title) ? card.title : row.content,
    cardTool: str(card?.tool) ? card.tool : (TOOL_OF_TYPE[a.type] ?? String(a.type)),
    entityIds: touchedEntityIds({ entity_id: entityId, operations, inverse }),
    touchedKeys: touchedKeysOf({ operations, inverse }),
    operations,
    inverse,
    ...(Object.hasOwn(md, 'results') && { results: md.results as unknown[] }),
    undoes: null,
  };
}

async function rowsOf(tx: Tx, query: SQL): Promise<Row[]> {
  return (await tx.execute(query)) as unknown as Row[];
}

type Cursored = JournalEntry & { cursor: JournalCursor };

/** Строки → записи с курсором; владелец графа читается одним запросом и только при записи отмены в выборке. */
async function mapRows(
  rows: readonly Row[],
  readOwner: () => Promise<unknown>,
  graph: GraphId,
  actionId?: string,
): Promise<Cursored[]> {
  const owner = rows.some(isUndoRow) ? ownerFrom(await readOwner(), graph) : undefined;
  const out: Cursored[] = [];
  for (const row of rows) {
    const e = entryFromRow(row, owner, actionId);
    if (e !== undefined) out.push({ ...e, cursor: { at: e.createdAt, key: row.id } });
  }
  return out;
}

async function withCursors(
  tx: Tx,
  graph: GraphId,
  query: SQL,
  actionId?: string,
): Promise<Cursored[]> {
  const readOwner = async () => (await tx.execute(OWNER_OF_GRAPH(graph)))[0]?.owner;
  return mapRows(await rowsOf(tx, query), readOwner, graph, actionId);
}

/** Записи без курсора — курсор задан прежним хранилищем и наружу из «записи» не отдаётся. */
async function entriesOf(tx: Tx, graph: GraphId, query: SQL): Promise<JournalEntry[]> {
  return (await withCursors(tx, graph, query)).map(({ cursor: _cursor, ...e }) => e);
}

async function firstEntry(
  tx: Tx,
  graph: GraphId,
  query: SQL,
  actionId?: string,
): Promise<JournalEntry | undefined> {
  const found = (await withCursors(tx, graph, query, actionId))[0];
  if (found === undefined) return undefined;
  const { cursor: _cursor, ...e } = found;
  return e;
}

const inGraph = (graph: GraphId): SQL => sql`t.graph_id = ${graph}::uuid`;

// ─────────────────────────────── функции API ───────────────────────────────

/** Действие по id (не запись отмены). Прежняя проба `findActionMessage`: containment по `actions[].id`. */
export async function findAction(
  tx: Tx,
  graph: GraphId,
  actionId: string,
): Promise<JournalEntry | undefined> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  return firstEntry(
    tx,
    graph,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND ${IS_ACTION} AND m.metadata @> ${probe}::jsonb LIMIT 1`,
    actionId,
  );
}

/**
 * Запись пачки по её `batch_id` (повтор пачки: исполнитель, перенос бюджета, план→факт, импорт, «Принять»).
 * Прежний ключ — детерминированный PK сообщения `batchAuditMessageId(graph, batchId)`. Найденная запись обязана
 * быть пачкой (`type ∈ batch|action`, РП-12): иначе клиентский `batch_id`, совпавший с id одиночного действия
 * того же графа, вернул бы «повтор» чужой записи — в таблице задачи 5 это одно пространство ключей.
 */
export async function findBatch(
  tx: Tx,
  graph: GraphId,
  batchId: string,
): Promise<JournalEntry | undefined> {
  const e = await firstEntry(
    tx,
    graph,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND ${IS_ACTION}
          AND m.id = ${batchAuditMessageId(graph, batchId)}::uuid`,
  );
  return e !== undefined && BATCH_TYPES.has(e.type) ? e : undefined;
}

/** Действие отменено ⇔ есть запись отмены с его id (§7.8). */
export async function isUndone(tx: Tx, graph: GraphId, actionId: string): Promise<boolean> {
  const probe = JSON.stringify({ type: 'undo', undoes: actionId });
  const rows = await tx.execute(
    sql`SELECT 1 AS hit FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
        WHERE ${inGraph(graph)} AND m.metadata @> ${probe}::jsonb LIMIT 1`,
  );
  return rows.length > 0;
}

/** Запись отмены действия — единственный путь к записям отмены (К-22). */
export async function undoRecordOf(
  tx: Tx,
  graph: GraphId,
  actionId: string,
): Promise<JournalEntry | undefined> {
  const probe = JSON.stringify({ type: 'undo', undoes: actionId });
  return firstEntry(
    tx,
    graph,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND m.metadata @> ${probe}::jsonb
        ORDER BY m.created_at, m.id LIMIT 1`,
  );
}

/**
 * «Последнее отменяемое» (§7.8): последнее по времени действие, не `system` и не отменённое; записи отмены — не
 * действия (К-22). Системные действия (материализация повторов §5.4, скрытая из ленты) пропускаются: «отмени
 * последнее» — последнее ВИДИМОЕ владельцу, иначе отмена молча архивировала бы инстансы вместо «обед 340» (fix round
 * A3). Точечная отмена системного действия по id остаётся возможной (§2.8, путь A5). IS DISTINCT FROM — NULL-безопасно
 * (урок A1: у строки без source обычное `<>` дало бы NULL и потеряло её). Порядок — `created_at DESC, id DESC`
 * (тай-брейк: precision 3).
 */
export async function findLastUndoable(tx: Tx, graph: GraphId): Promise<JournalEntry | undefined> {
  return firstEntry(
    tx,
    graph,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND ${IS_ACTION}
          AND m.metadata -> 'actions' -> 0 ->> 'source' IS DISTINCT FROM 'system'
          AND NOT EXISTS (
            SELECT 1 FROM chat_messages u JOIN chat_threads ut ON ut.id = u.thread_id
            WHERE ut.graph_id = t.graph_id
              AND u.metadata @> jsonb_build_object('type', 'undo', 'undoes', m.metadata -> 'actions' -> 0 ->> 'id'))
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1`,
  );
}

/**
 * Действия прогона в порядке журнала (`created_at, id`): обратная ссылка `run_id` — containment-проба, как у
 * прежнего `rollback.ts`. Отбор «своё/о прогоне» — политика отката у вызывающего.
 */
export async function runActions(
  tx: Tx,
  graph: GraphId,
  runId: string,
): Promise<Array<JournalEntry & { cursor: JournalCursor }>> {
  const probe = JSON.stringify({ actions: [{ run_id: runId }] });
  return withCursors(
    tx,
    graph,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND ${IS_ACTION} AND m.metadata @> ${probe}::jsonb
        ORDER BY m.created_at ASC, m.id ASC`,
  );
}

/**
 * Действия после курсора (строго: составной ключ `(created_at, id)`, как порядок `runActions`), тронувшие хоть один
 * из КЛЮЧЕЙ `keys` — uuid записей или ключ реестра (`touchedKeys`, рулинг R-11: прежняя ширина окна конфликтов отката);
 * записи отмены — не действия (К-22). Отменённые действия НЕ отсеиваются: решает вызывающий (откат прогона спрашивает
 * `isUndone` только у настоящих кандидатов).
 *
 * Форма для таблицы (задача 5): uuid-ключи — через боковую таблицу записей действий, ключи реестра — просмотром
 * записей графа в окне по времени (окно начинается первым действием прогона — короткое) с тем же `touchedKeysOf`.
 */
export async function actionsTouchingAfter(
  tx: Tx,
  graph: GraphId,
  after: JournalCursor,
  keys: string[],
): Promise<Array<JournalEntry & { cursor: JournalCursor }>> {
  if (keys.length === 0) return [];
  const wanted = new Set(keys);
  const all = await withCursors(
    tx,
    graph,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND ${IS_ACTION}
          AND (m.created_at, m.id) > (${after.at.toISOString()}::timestamptz, ${after.key}::uuid)
        ORDER BY m.created_at ASC, m.id ASC`,
  );
  return all.filter((e) => e.touchedKeys.some((key) => wanted.has(key)));
}

/**
 * Действия, чьи ОПЕРАЦИИ правили саму запись (`payload.id` — проба R-18 поставки), новые первыми, не больше
 * `limit`; записи отмены — не действия (К-22). Связь с записью (`source_id`/`target_id`) правкой записи не
 * считается: связь, легшая после «добавить», ответа R-18 не меняет. Отменённые не отсеиваются — обход R-18
 * проходит отменённые правки насквозь сам.
 */
export async function actionsOnEntity(
  tx: Tx,
  graph: GraphId,
  entityId: string,
  limit: number,
): Promise<JournalEntry[]> {
  const probe = JSON.stringify({ actions: [{ operations: [{ payload: { id: entityId } }] }] });
  return entriesOf(
    tx,
    graph,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND ${IS_ACTION} AND m.metadata @> ${probe}::jsonb
        ORDER BY m.created_at DESC, m.id DESC
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
 * отменённые и записи отмены не попадают («исправил → отменил → исправил» — не два исправления).
 *
 * ПРОБА ИДЁТ ПО ЗНАЧЕНИЮ, а не по наличию ключа: категория — плоское свойство-строка, и
 * `{props: {orbis/finance_category: {}}}` не содержится в ней никогда, а `{props: {}}` затянул бы под пробу любую
 * правку любого свойства. `op:'entity_update'` обязателен: без него под пробу попадал бы каждый batch, в котором
 * финансовая запись СОЗДАВАЛАСЬ с этой категорией (журнал `entity_create` несёт всё состояние). Дизъюнкция
 * ЛИТЕРАЛЬНЫХ containment-предикатов по трём типам записи (`entity_updated`, `batch`, `action` — §Б6-4): индексом
 * (`jsonb_path_ops`) берётся только `metadata @> <константа>`, и подзапрос по массиву проб тихо увёл бы скан в
 * seq scan. Порядок задан явно, чтобы усечение брало СВЕЖИЕ правки.
 */
export async function financialUpdatesSince(
  tx: Tx,
  graph: GraphId,
  since: Date,
  categoryIds: string[],
): Promise<JournalEntry[]> {
  const targets = [...new Set(categoryIds)];
  if (targets.length === 0) return [];
  const probe = (type: string, category: string): string =>
    JSON.stringify({
      actions: [
        {
          type,
          operations: [
            { op: 'entity_update', payload: { props: { 'orbis/finance_category': category } } },
          ],
        },
      ],
    });
  const matches = sql.join(
    targets.flatMap((category) => [
      sql`m.metadata @> ${probe('entity_updated', category)}::jsonb`,
      sql`m.metadata @> ${probe('batch', category)}::jsonb`,
      sql`m.metadata @> ${probe('action', category)}::jsonb`,
    ]),
    sql` OR `,
  );
  return entriesOf(
    tx,
    graph,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND ${IS_ACTION}
          AND m.created_at > ${since.toISOString()}::timestamptz
          AND (${matches})
          AND NOT EXISTS (
            SELECT 1 FROM chat_messages u JOIN chat_threads ut ON ut.id = u.thread_id
            WHERE ut.graph_id = t.graph_id
              AND u.metadata @> jsonb_build_object('type', 'undo', 'undoes', m.metadata -> 'actions' -> 0 ->> 'id'))
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${JOURNAL_SCAN_LIMIT}`,
  );
}

/**
 * Какие из `ids` — исполненные пачки (судьба «принято» у единиц прогона, `listRunUnits`). Прежний ключ — IN-список
 * детерминированных PK (`uuid_eq` leakproof: индекс под RLS берётся); запись обязана быть пачкой (РП-12).
 */
export async function executedIds(tx: Tx, graph: GraphId, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const byKey = new Map(ids.map((id) => [batchAuditMessageId(graph, id), id]));
  const keys = sql.join(
    [...byKey.keys()].map((k) => sql`${k}::uuid`),
    sql`, `,
  );
  for (const e of await withCursors(
    tx,
    graph,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND ${IS_ACTION} AND m.id IN (${keys})`,
  )) {
    const requested = byKey.get(e.cursor.key);
    if (requested !== undefined && BATCH_TYPES.has(e.type)) out.add(requested);
  }
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
 * расширении не говорил.
 *
 * Имя — `ownerExtensionWord`, а не `ownerModuleWord` контракта плана: «module» в именах кода — только имена провода
 * и отказа (РП-10, сторож `scripts/code-boundaries.test.ts` (3)); слово словаря — «расширение».
 */
export async function ownerExtensionWord(
  tx: Tx,
  graph: GraphId,
  module: string,
): Promise<{ enabled: boolean; at: Date } | undefined> {
  const probe = JSON.stringify({
    actions: [{ operations: [{ op: 'module_set', payload: { module } }] }],
  });
  const said = await firstEntry(
    tx,
    graph,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND ${IS_ACTION} AND m.metadata @> ${probe}::jsonb
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
  );
  if (said === undefined) return undefined;
  const enabled = lastExtensionSwitch(said.operations, module) ?? false;
  const undo = await undoRecordOf(tx, graph, said.id);
  if (undo === undefined) return { enabled, at: said.createdAt };
  return { enabled: lastExtensionSwitch(said.inverse, module) ?? !enabled, at: undo.createdAt };
}

/**
 * Журнал треда — действия и записи отмены, новые первыми (`created_at DESC, id DESC`), страница `limit` строго до
 * курсора `before`.
 */
export async function threadActions(
  tx: Tx,
  graph: GraphId,
  threadId: string,
  page: { before?: JournalCursor; limit: number },
): Promise<Array<JournalEntry & { cursor: JournalCursor }>> {
  const before =
    page.before === undefined
      ? sql``
      : sql`AND (m.created_at, m.id) < (${page.before.at.toISOString()}::timestamptz, ${page.before.key}::uuid)`;
  return withCursors(
    tx,
    graph,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND m.thread_id = ${threadId}::uuid
          AND (${IS_ACTION} OR ${IS_UNDO}) ${before}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${page.limit}`,
  );
}

/**
 * Недавние правки владельца в интерфейсе (`ui`, `quick_capture`) с момента `since`, новые первыми, не больше
 * `limit`; записи отмены — не правки (К-22).
 */
export async function recentOwnerEdits(
  tx: Tx,
  graph: GraphId,
  since: Date,
  limit: number,
): Promise<JournalEntry[]> {
  return entriesOf(
    tx,
    graph,
    sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND ${IS_ACTION}
          AND m.metadata -> 'actions' -> 0 ->> 'source' IN ('ui', 'quick_capture')
          AND m.created_at >= ${since.toISOString()}::timestamptz
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${limit}`,
  );
}

/** Записи журнала графа по времени (`created_at, id`), включая записи отмены; страница — строго после курсора. */
function exportQuery(graph: GraphId, page?: { after?: JournalCursor; limit: number }): SQL {
  const after =
    page?.after === undefined
      ? sql``
      : sql`AND (m.created_at, m.id) > (${page.after.at.toISOString()}::timestamptz, ${page.after.key}::uuid)`;
  const limit = page === undefined ? sql`` : sql`LIMIT ${page.limit}`;
  return sql`${SELECT_ROW} WHERE ${inGraph(graph)} AND (${IS_ACTION} OR ${IS_UNDO}) ${after}
    ORDER BY m.created_at ASC, m.id ASC ${limit}`;
}

export async function exportJournal(tx: Tx, graph: GraphId): Promise<JournalEntry[]> {
  return entriesOf(tx, graph, exportQuery(graph));
}

/**
 * `exportJournal` сырым клиентом postgres.js ПОРЦИЯМИ — для прод-операций (`db/migrate-1v.ts` `--report`), которые
 * читают базу ролью с BYPASSRLS в транзакции READ ONLY мимо drizzle и не тянут журнал графа в память целиком. Запрос —
 * ТОТ ЖЕ (`exportQuery`, отрисованный диалектом drizzle), разбор — тот же: смена хранилища проходит здесь одним
 * местом и для них. Курсор (`cursor.key` — ключ хранилища: у прежнего — id сообщения) — адрес строки для отчёта.
 */
export async function exportJournalRaw(
  client: ISql,
  graph: GraphId,
  page: { after?: JournalCursor; limit: number },
): Promise<Cursored[]> {
  const dialect = new PgDialect();
  const run = async (query: SQL): Promise<Record<string, unknown>[]> => {
    const q = dialect.sqlToQuery(query);
    return (await client.unsafe(q.sql, q.params as never[])) as unknown as Record<
      string,
      unknown
    >[];
  };
  const rows = (await run(exportQuery(graph, page))) as unknown as Row[];
  return mapRows(rows, async () => (await run(OWNER_OF_GRAPH(graph)))[0]?.owner, graph);
}

/**
 * Запись журнала → прежняя форма `ActionRecord` — для кода, чей контракт — запись действия (политика отката в
 * `tools/dispatch.ts`, ответ «отмени последнее»). Запись отмены действием не является (К-22) — её сюда не передают.
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
