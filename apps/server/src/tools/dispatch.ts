// apps/server/src/tools/dispatch.ts
// Диспатч тулов LLM/MCP (§9.2) поверх executor'а — контракт для Task 9 (ai.sendMessage)
// и Task 10 (MCP-адаптер). Семантика: (1) резолв тула по реестру (неизвестный →
// error/VALIDATION); (2) чтения — без политики, под withIdentity; (3) мутации — через
// execute с боевым JournalSink (audit в ctx.threadId, без него — в глобальный тред);
// (4) thread_post — отдельная ветка мимо executor (см. runThreadPost).
//
// ВАЖНО (фазировка): уровни политики §7.10 подключает следующая задача (Task 5,
// classifyToolCall) — точка врезки одна, runMutation; до неё все мутации исполняются
// немедленно (уровень execute), pending/forbidden-ветвление появится там же.
import { entityGetInput, entityQueryInput, newId, parseQuery, type QueryAst } from '@orbis/shared';
import type { z } from 'zod';
import { appendMessage } from '../chat/messages';
import { ensureEntityThread } from '../chat/threads';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import { readEntity } from '../entity-read';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ActorKind, WireEntity } from '../executor/types';
import {
  type CompileContext,
  compileCount,
  compileQuery,
  compileSum,
  QueryCompileError,
} from '../query/compile';
import { queryContext } from '../query/context';
import { toWireEntityFromSql } from '../wire';
import {
  type AspectToolRow,
  buildToolDefs,
  type Card,
  loadAspectToolRows,
  type OrbisToolDef,
  threadPostInput,
  userQueryInput,
} from './registry';

// Боевой синк — один инстанс на модуль (состояния не хранит), как в роутерах 1a.
const sink = makeChatJournalSink();

export interface ToolCallCtx {
  db: Db;
  actorUserId: string;
  actorKind: ActorKind; // 'owner' | 'ai' | 'agent'; в ExecuteRequest идёт как есть
  source: 'chat' | 'mcp';
  threadId?: string; // тред диалога — туда лягут audit-сообщения
  explicitCommand: boolean; // вход политики §7.10; в 1b всегда false
  clock?: () => Date;
}

export type ToolDispatchResult =
  | { status: 'ok'; result: unknown; card?: Card }
  | { status: 'pending_confirmation'; pendingId: string; card: Card } // §7.10 explicit-confirmation (Task 6)
  | { status: 'error'; error: { code: string; message: string; details?: unknown } };

export async function dispatchTool(
  ctx: ToolCallCtx,
  name: string,
  input: unknown,
): Promise<ToolDispatchResult> {
  try {
    // Резолв тула и чтения — один withIdentity-tx (RLS); мутации исполняются после:
    // execute открывает собственный tx, вложить его в текущий нельзя.
    const pre = await withIdentity(ctx.db, ctx.actorUserId, async (tx): Promise<Resolution> => {
      const rows = await loadAspectToolRows(tx);
      const def = buildToolDefs(rows).find((d) => d.name === name);
      if (!def) return { kind: 'unknown' };
      if (def.kind === 'read')
        return { kind: 'done', out: await runRead(tx, ctx, def.name, input) };
      return { kind: 'mutate', def, keyFieldsByAspect: keyFieldsByAspect(rows) };
    });
    if (pre.kind === 'unknown') {
      return errorResult('VALIDATION', `неизвестный тул «${name}»`, { tool: name });
    }
    if (pre.kind === 'done') return pre.out;
    // await обязателен: return без await вывел бы reject за пределы try/catch ниже
    if (pre.def.name === 'thread_post') return await runThreadPost(ctx, input);
    return await runMutation(ctx, pre.def, input, pre.keyFieldsByAspect);
  } catch (e) {
    // Доменные отказы (NOT_FOUND, VALIDATION, ...) — структурированный error-результат;
    // инфраструктурные ошибки и баги не маскируются (та же дисциплина, что в execute)
    if (e instanceof ExecError) {
      return { status: 'error', error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}

type Resolution =
  | { kind: 'unknown' }
  | { kind: 'done'; out: ToolDispatchResult }
  | { kind: 'mutate'; def: OrbisToolDef; keyFieldsByAspect: Map<string, string[]> };

function errorResult(code: string, message: string, details?: unknown): ToolDispatchResult {
  return { status: 'error', error: { code, message, details } };
}

// ---------------------------------------------------------------------------
// Чтения: entity_query / entity_get / user_query — без политики §7.10, под RLS
// ---------------------------------------------------------------------------

async function runRead(
  tx: Tx,
  ctx: ToolCallCtx,
  name: string,
  input: unknown,
): Promise<ToolDispatchResult> {
  if (name === 'entity_query') return runEntityQuery(tx, ctx, input);
  if (name === 'entity_get') {
    const parsed = parseEnvelope(entityGetInput, input, 'entity_get');
    return { status: 'ok', result: await readEntity(tx, ctx.actorUserId, parsed) };
  }
  if (name === 'user_query') return runUserQuery(tx, ctx, input);
  throw new Error(`runRead: нет обработчика read-тула «${name}»`); // недостижимо: kind задаёт реестр
}

async function runEntityQuery(
  tx: Tx,
  ctx: ToolCallCtx,
  input: unknown,
): Promise<ToolDispatchResult> {
  const parsed = parseEnvelope(entityQueryInput, input, 'entity_query');
  const cctx = await queryContext(tx, ctx.actorUserId, null); // `this` вне контекста сущности
  const ast = parseAstOrThrow(parsed.query, cctx);
  const compiled = compileOrThrow(() => compileQuery(ast, cctx));
  const rows = await tx.execute(compiled);
  const entities = [...rows].map((r) => toWireEntityFromSql(r as Record<string, unknown>));
  const card: Card = {
    kind: 'query_result',
    ...(ast.title !== undefined && { title: ast.title }),
    count: entities.length,
    entityIds: entities.map((e) => e.id),
  };
  return { status: 'ok', result: entities, card };
}

/**
 * user_query (решение 7 плана): агрегация НА SQL — sum через ::numeric::text
 * (точность decimal §3.3, не JS-float), count(*) без limit (агрегат по всей выборке).
 */
async function runUserQuery(tx: Tx, ctx: ToolCallCtx, input: unknown): Promise<ToolDispatchResult> {
  const parsed = parseEnvelope(userQueryInput, input, 'user_query');
  const cctx = await queryContext(tx, ctx.actorUserId, null);
  const ast = parseAstOrThrow(parsed.query, cctx);

  if (parsed.aggregate === 'count') {
    const rows = await tx.execute(compileCount(ast, cctx));
    const count = Number(rows[0]?.count);
    return {
      status: 'ok',
      result: count,
      card: aggregateCard(ast, count, { op: 'count', value: String(count) }),
    };
  }

  // aggregate === 'sum'
  if (parsed.field === undefined) {
    throw new ExecError('VALIDATION', 'user_query: aggregate=sum требует field', {
      tool: 'user_query',
    });
  }
  const field = parsed.field;
  const compiled = compileOrThrow(() => compileSum(ast, cctx, field));
  const rows = await tx.execute(compiled);
  const count = Number(rows[0]?.count);
  const value = (rows[0]?.sum as string | null) ?? '0'; // пустая выборка: sum NULL → '0'
  return {
    status: 'ok',
    result: value,
    card: aggregateCard(ast, count, { op: 'sum', value }),
  };
}

function aggregateCard(
  ast: QueryAst,
  count: number,
  aggregate: { op: 'sum' | 'count'; value: string },
): Card {
  return {
    kind: 'query_result',
    ...(ast.title !== undefined && { title: ast.title }),
    count,
    entityIds: [], // агрегат id не выбирает; список — отдельным entity_query
    aggregate,
  };
}

// ---------------------------------------------------------------------------
// Мутации через executor (конвейер §9.2, журнал §7.8)
// ---------------------------------------------------------------------------

async function runMutation(
  ctx: ToolCallCtx,
  def: OrbisToolDef,
  input: unknown,
  keyFieldsMap: Map<string, string[]>,
): Promise<ToolDispatchResult> {
  // Точка врезки политики §7.10: уровни подтверждения подключает следующая задача
  // (Task 5, classifyToolCall врезается ровно здесь — между резолвом тула и execute);
  // до неё все мутации исполняются немедленно (уровень execute).
  //
  // Имя тула для executor'а: у attach_* он ждёт форму attach_<aspect_id с заменой
  // только «/»> — восстанавливаем из aspectId (см. OrbisToolDef.aspectId).
  const tool =
    def.aspectId !== undefined ? `attach_${def.aspectId.replaceAll('/', '_')}` : def.name;
  const r = await execute(
    ctx.db,
    {
      actorUserId: ctx.actorUserId,
      actorKind: ctx.actorKind,
      source: ctx.source,
      threadId: ctx.threadId,
      operations: [{ tool, input }],
      clock: ctx.clock,
    },
    { sink },
  );
  if (!r.ok) return { status: 'error', error: r.error };

  // batch: результат — массив по операциям; карточки batch (preview §7.10) — Task 5
  if (def.name === 'batch_execute') return { status: 'ok', result: r.results };

  const result = r.results[0];
  // entity_card (02 §2.3) — для create/update/attach; relation-мутации карточку
  // этого типа не несут (их карточки появятся вместе с confirmation/error, Task 5–6/9)
  const isEntityMutation =
    def.name === 'entity_create' || def.name === 'entity_update' || def.aspectId !== undefined;
  const card = isEntityMutation
    ? entityCard(
        result as WireEntity,
        keyFieldsMap,
        // идемпотентный replay ничего не журналил — action для Undo не существует
        r.idempotentReplay ? undefined : r.actionId,
      )
    : undefined;
  return { status: 'ok', result, ...(card !== undefined && { card }) };
}

/** keyFields карточки (02 §2.3): значения полей из viewConfig.keyFields каждого аспекта. */
function keyFieldsByAspect(rows: AspectToolRow[]): Map<string, string[]> {
  return new Map(
    rows.map((r) => {
      const kf = (r.viewConfig as { keyFields?: unknown } | null)?.keyFields;
      return [r.id, Array.isArray(kf) ? kf.filter((f): f is string => typeof f === 'string') : []];
    }),
  );
}

function entityCard(
  e: WireEntity,
  keyFieldsMap: Map<string, string[]>,
  undoActionId: string | undefined,
): Card {
  const aspects = Object.keys(e.aspects);
  const keyFields: Record<string, unknown> = {};
  for (const aspectId of aspects) {
    for (const field of keyFieldsMap.get(aspectId) ?? []) {
      const value = e.aspects[aspectId]?.[field];
      if (value !== undefined) keyFields[field] = value;
    }
  }
  return {
    kind: 'entity_card',
    entityId: e.id,
    title: e.title,
    aspects,
    keyFields,
    ...(undoActionId !== undefined && { undoActionId }),
  };
}

// ---------------------------------------------------------------------------
// thread_post — отдельная ветка мимо executor
// ---------------------------------------------------------------------------

/**
 * thread_post — НЕ мутация графа: сообщение-в-тред и есть артефакт, inverse не имеет
 * смысла (chat_messages append-only, §4.6), Undo не применяется — ровно как
 * appendUserMessage владельца. Поэтому action в журнал §7.8 не пишется, а исполнение
 * идёт мимо executor: ensureEntityThread + appendMessage одним withIdentity-tx.
 * kind 'mutate' в реестре — для политики §7.10 (уровень одиночной мутации).
 */
async function runThreadPost(ctx: ToolCallCtx, input: unknown): Promise<ToolDispatchResult> {
  const parsed = parseEnvelope(threadPostInput, input, 'thread_post');
  const message = await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
    // Тред создаётся только для видимой актору сущности; чужая и несуществующая
    // под RLS неразличимы — единый NOT_FOUND (бросает ensureEntityThread)
    const threadId = await ensureEntityThread(tx, ctx.actorUserId, parsed.entity_id);
    return appendMessage(tx, {
      id: newId(),
      threadId,
      role: 'user',
      content: parsed.content,
      // Пометка автора — только для внешнего агента (§9.3): владелец видит, что
      // заметку в треде оставил не он и не внутренний AI
      metadata: ctx.actorKind === 'agent' ? { author_kind: ctx.actorKind } : {},
    });
  });
  return { status: 'ok', result: message };
}

// ---------------------------------------------------------------------------
// Общие хелперы
// ---------------------------------------------------------------------------

/** Структурная валидация envelope read-тулов и thread_post (мутации валидирует executor). */
function parseEnvelope<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  tool: string,
): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ExecError('VALIDATION', `невалидный input тула «${tool}»`, {
      tool,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

/** Разбор запроса грамматики §6: ошибка парсинга → VALIDATION со структурой §6.4. */
function parseAstOrThrow(query: string, cctx: CompileContext): QueryAst {
  const parsed = parseQuery(query, cctx.catalog);
  if (!parsed.ok) {
    throw new ExecError('VALIDATION', parsed.error.message, {
      position: parsed.error.position,
    });
  }
  return parsed.ast;
}

/** Структурная ошибка компиляции (`this` вне контекста, нечисловое поле sum) → VALIDATION. */
function compileOrThrow<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof QueryCompileError) {
      throw new ExecError('VALIDATION', e.message);
    }
    throw e;
  }
}
