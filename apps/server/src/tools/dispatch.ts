// apps/server/src/tools/dispatch.ts
// Диспатч тулов LLM/MCP (§9.2) поверх executor'а — контракт для Task 9 (ai.sendMessage)
// и Task 10 (MCP-адаптер). Семантика: (1) резолв тула по реестру (неизвестный —
// ряд «!known → forbidden» политики §7.10, error/FORBIDDEN_LEVEL); (2) чтения — под
// withIdentity, без ветвлений политики (ряд «read → execute»); (3) мутации — уровень
// назначает classifyToolCall (policy/confirmation) ДО execute: forbidden →
// FORBIDDEN_LEVEL, explicit-confirmation → ВРЕМЕННО VALIDATION с details.wouldBe
// (pending-механизм подключает Task 6 — см. levelGate), preview → исполнение +
// confirmation_card mode='preview', execute — немедленно; исполнение — через execute
// с боевым JournalSink (audit в ctx.threadId, без него — в глобальный тред);
// (4) thread_post — отдельная ветка мимо executor (см. runThreadPost), но тоже
// через классификатор §7.10.
import {
  attachAspectInput,
  type BatchExecuteInput,
  batchExecuteInput,
  entityCreateInput,
  entityGetInput,
  entityQueryInput,
  entityUpdateInput,
  newId,
  parseQuery,
  type QueryAst,
  relationCreateInput,
  relationDeleteInput,
} from '@orbis/shared';
import type { z } from 'zod';
import { appendMessage } from '../chat/messages';
import { ensureEntityThread } from '../chat/threads';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import { readEntity } from '../entity-read';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ActorKind, JournalSink, JournalWrite, WireEntity } from '../executor/types';
import {
  type ConfirmationLevel,
  classifyToolCall,
  entityUpdatePreviewDiff,
  factsFromToolCall,
} from '../policy/confirmation';
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
  type ThreadPostInput,
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
      const defs = buildToolDefs(rows);
      const def = defs.find((d) => d.name === name);
      if (!def) return { kind: 'unknown' };
      // internalOnly — fail-closed прямо в диспатче (fix round): фильтрация списка
      // тулов в MCP-адаптере (Task 10) — вторая линия, не единственная
      if (def.internalOnly === true && ctx.source === 'mcp') {
        return {
          kind: 'done',
          out: errorResult(
            'VALIDATION',
            `тул «${name}» внутренний — внешним агентам (MCP) недоступен (§9.2)`,
            { tool: name },
          ),
        };
      }
      if (def.kind === 'read')
        return { kind: 'done', out: await runRead(tx, ctx, def.name, input) };
      return {
        kind: 'mutate',
        def,
        keyFieldsByAspect: keyFieldsByAspect(rows),
        execToolByName: execToolNames(defs),
      };
    });
    if (pre.kind === 'unknown') {
      // §7.10, ряд «!known → forbidden» (fail-closed): незнакомый вызов не исполняется,
      // и переформулировкой имени запрет не обходится. Уровень честно берём у
      // классификатора — правило живёт в одном месте, dispatch лишь мапит его в код
      // ошибки. kind без реестра неопределим — консервативно 'mutate'; на исход не
      // влияет: ряд «!known» — первый в таблице.
      const level = classifyToolCall({
        tool: name,
        kind: 'mutate',
        known: false,
        actorKind: ctx.actorKind,
        explicitCommand: ctx.explicitCommand,
        archives: false,
        isBatch: false,
      });
      const gated = levelGate(level, name, `неизвестный тул «${name}» — вызов запрещён (§7.10)`);
      if (gated !== null) return gated;
      // недостижимо: ряд «!known» всегда даёт forbidden
      throw new Error(`classifyToolCall: неожиданный уровень «${level}» для неизвестного тула`);
    }
    if (pre.kind === 'done') return pre.out;
    // await обязателен: return без await вывел бы reject за пределы try/catch ниже
    if (pre.def.name === 'thread_post') {
      // §7.10 распространяется и на thread_post (kind='mutate' в реестре — ради
      // политики): по MVP-таблице одиночная не-архивирующая мутация → execute, но
      // уровень спрашиваем у классификатора — правило в одном месте. preview для
      // thread_post таблицей недостижим (не batch) — карточки предпросмотра нет.
      // Envelope-валидация — ДО классификации (§7.10 дословно, fix round Task 5).
      const parsed = parseEnvelope(threadPostInput, input, 'thread_post');
      const level = classifyToolCall({
        ...factsFromToolCall(pre.def, parsed),
        actorKind: ctx.actorKind,
        explicitCommand: ctx.explicitCommand,
      });
      const gated = levelGate(level, pre.def.name);
      if (gated !== null) return gated;
      return await runThreadPost(ctx, parsed);
    }
    return await runMutation(ctx, pre.def, input, pre.keyFieldsByAspect, pre.execToolByName);
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
  | {
      kind: 'mutate';
      def: OrbisToolDef;
      keyFieldsByAspect: Map<string, string[]>;
      /** Реестровое имя → executor-форма (для трансляции вложенных операций batch). */
      execToolByName: Map<string, string>;
    };

function errorResult(code: string, message: string, details?: unknown): ToolDispatchResult {
  return { status: 'error', error: { code, message, details } };
}

/**
 * §7.10: маппинг уровня в ранний отказ; null — уровень исполняемый (execute/preview),
 * вызов идёт дальше. forbidden → FORBIDDEN_LEVEL (403 маппингом errors.ts).
 * ФАЗИРОВКА: explicit-confirmation в 1b — ВРЕМЕННО структурная ошибка с details.wouldBe;
 * pending-механизм (сохранённый payload + карточка-запрос + approve с ревалидацией)
 * подключает Task 6, заменяя эту ветку на status 'pending_confirmation'. Это явная
 * схема двух шагов, не забытый хвост — тесты фиксируют временное поведение.
 *
 * КОНТРАКТ ДЛЯ TASK 6 (fix round Task 5): сюда уровень приходит только ПОСЛЕ
 * envelope-валидации input'а (validateMutationEnvelope / validateBatchOperations в
 * runMutation) — pending создаётся из envelope-валидированного payload'а. Полная
 * провалидированность (стадии 3–4 конвейера §9.2: expectedUpdatedAt/§5.2, доменные
 * инварианты над текущим состоянием) — обязанность dry-run'а при создании pending
 * ЛИБО ревалидации approve — решение Task 6.
 */
function levelGate(
  level: ConfirmationLevel,
  tool: string,
  forbiddenMessage?: string,
): ToolDispatchResult | null {
  if (level === 'forbidden') {
    return errorResult(
      'FORBIDDEN_LEVEL',
      forbiddenMessage ?? `вызов тула «${tool}» запрещён политикой подтверждений (§7.10)`,
      { tool },
    );
  }
  if (level === 'explicit-confirmation') {
    return errorResult(
      'VALIDATION',
      `«${tool}» требует подтверждения — механизм появится следующей задачей`,
      { tool, wouldBe: 'explicit-confirmation' },
    );
  }
  return null;
}

/**
 * Обёртка боевого синка для уровня preview (§7.10): перехватывает JournalWrite —
 * diff карточки строится из action.inverse (§7.8) — делегируя запись боевому синку
 * тем же tx. Push после успешной записи: конфликт/откат не оставляет фантомного entry.
 */
function captureSink(inner: JournalSink): { sink: JournalSink; entries: JournalWrite[] } {
  const entries: JournalWrite[] = [];
  return {
    entries,
    sink: {
      async write(tx, entry) {
        await inner.write(tx, entry);
        entries.push(entry);
      },
      findByAuditId: (tx, id) => inner.findByAuditId(tx, id),
    },
  };
}

/** Русский плюрал для summary batch-preview: 1 операция, 2 операции, 5 операций. */
function operationsNoun(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'операций';
  const mod10 = n % 10;
  if (mod10 === 1) return 'операция';
  if (mod10 >= 2 && mod10 <= 4) return 'операции';
  return 'операций';
}

// ---------------------------------------------------------------------------
// Чтения: entity_query / entity_get / user_query — под RLS; ветвлений политики нет:
// ряд «read → execute» таблицы §7.10 (закреплён юнит-тестом классификатора)
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
    // compileOrThrow обязателен и здесь: QueryCompileError (например children_of=this
    // вне контекста) — структурная VALIDATION, не throw мимо catch (fix round)
    const compiledCount = compileOrThrow(() => compileCount(ast, cctx));
    const rows = await tx.execute(compiledCount);
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
  execToolByName: Map<string, string>,
): Promise<ToolDispatchResult> {
  // Имя тула для executor'а: у attach_* он ждёт форму attach_<aspect_id с заменой
  // только «/»> — восстанавливаем из aspectId (см. OrbisToolDef.aspectId).
  // Структурная валидация ДО классификации (§7.10 дословно: уровень получает tool-call
  // ПОСЛЕ структурной валидации input'а): невалидный envelope — честная VALIDATION с
  // zod-issues (путь самокоррекции модели), а не wouldBe; для batch — трансляция имён
  // (fix round Task 4) плюс валидация каждого operations[].input схемой его тула.
  // Факты классификатора дальше извлекаются из уже ПРОВАЛИДИРОВАННОГО payload'а.
  const tool = execToolName(def);
  const batchPayload =
    def.name === 'batch_execute'
      ? validateBatchOperations(translateBatchInput(input, execToolByName))
      : undefined;
  const payload = batchPayload ?? validateMutationEnvelope(def, input);

  // §7.10: уровень определяет политика по типизированным фактам вызова, не модель;
  // forbidden и explicit-confirmation разворачиваются ДО execute — в БД и журнал (§7.8)
  // ничего не попадает
  const level = classifyToolCall({
    ...factsFromToolCall(def, payload),
    actorKind: ctx.actorKind,
    explicitCommand: ctx.explicitCommand,
  });
  const gated = levelGate(level, def.name);
  if (gated !== null) return gated;

  // execute | preview — действие исполняется (§7.10: предпросмотр информационный, не
  // блокирующий); для preview перехватываем JournalWrite — diff строится из inverse (§7.8)
  const capture = level === 'preview' ? captureSink(sink) : undefined;
  const r = await execute(
    ctx.db,
    {
      actorUserId: ctx.actorUserId,
      actorKind: ctx.actorKind,
      source: ctx.source,
      threadId: ctx.threadId,
      operations: [{ tool, input: payload }],
      clock: ctx.clock,
    },
    { sink: capture?.sink ?? sink },
  );
  if (!r.ok) return { status: 'error', error: r.error };

  // batch: результат — массив по операциям; на уровне preview — confirmation_card с
  // кратким summary «N операций» (пополевого diff у группы нет — масштаб задаёт размер)
  if (batchPayload !== undefined) {
    if (level === 'preview') {
      const n = batchPayload.operations.length;
      return {
        status: 'ok',
        result: r.results,
        card: { kind: 'confirmation_card', mode: 'preview', summary: `${n} ${operationsNoun(n)}` },
      };
    }
    return { status: 'ok', result: r.results };
  }

  const result = r.results[0];
  if (level === 'preview') {
    // Одиночный preview: MVP-таблицей §7.10 сейчас недостижим (preview даёт только
    // batch), но семантика уровня общая — при эволюции таблицы ветка готова: diff
    // entity_update — прежние значения vs новые из inverse журнала (§7.8)
    const entry = capture?.entries[0];
    const diff =
      def.name === 'entity_update' && entry !== undefined
        ? entityUpdatePreviewDiff(entry.action)
        : undefined;
    return {
      status: 'ok',
      result,
      card: {
        kind: 'confirmation_card',
        mode: 'preview',
        summary:
          def.name === 'entity_update' ? `Обновление «${(result as WireEntity).title}»` : def.name,
        ...(diff !== undefined && { diff }),
      },
    };
  }

  // уровень execute — немедленное исполнение, карточка и журнал постфактум (§7.10):
  // entity_card (02 §2.3) — для create/update/attach; relation-мутации карточку
  // этого типа не несут (их карточки появятся вместе с confirmation/error, Task 6/9)
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

/** Имя тула в executor-форме: у attach_* «/» → «_», «-» сохраняется (см. aspectId). */
function execToolName(def: OrbisToolDef): string {
  return def.aspectId !== undefined ? `attach_${def.aspectId.replaceAll('/', '_')}` : def.name;
}

/** Маппинг реестровое имя → executor-форма по всем тулам (для операций batch). */
function execToolNames(defs: OrbisToolDef[]): Map<string, string> {
  return new Map(defs.map((d) => [d.name, execToolName(d)]));
}

/**
 * Трансляция envelope batch_execute: operations[].tool — реестровые имена (их публикует
 * buildToolRegistry и видят LLM/MCP) → executor-форма. Имя вне реестра — структурная
 * VALIDATION с индексом элемента. Известные, но непригодные для batch имена (read-тулы,
 * thread_post, вложенный batch_execute) транслируются как есть — их отклоняет стадия 1
 * executor'а собственной честной ошибкой.
 */
function translateBatchInput(
  input: unknown,
  execToolByName: Map<string, string>,
): BatchExecuteInput {
  const parsed = parseEnvelope(batchExecuteInput, input, 'batch_execute');
  return {
    batch_id: parsed.batch_id,
    operations: parsed.operations.map((op, index) => {
      const tool = execToolByName.get(op.tool);
      if (tool === undefined) {
        throw new ExecError('VALIDATION', `batch_execute: неизвестный тул операции «${op.tool}»`, {
          index,
          tool: op.tool,
        });
      }
      return { tool, input: op.input };
    }),
  };
}

/**
 * Envelope-схемы мутирующих core-тулов §9.2 (shared) — для структурной валидации ДО
 * классификации §7.10 (fix round Task 5). batch_execute и thread_post здесь не нужны:
 * batch валидируют translateBatchInput + validateBatchOperations, thread_post — своя
 * ветка dispatchTool; ключи — исполнительные имена (у core они совпадают с реестровыми).
 */
const MUTATION_ENVELOPES: Record<string, z.ZodTypeAny> = {
  entity_create: entityCreateInput,
  entity_update: entityUpdateInput,
  relation_create: relationCreateInput,
  relation_delete: relationDeleteInput,
};

/**
 * Структурная валидация envelope одиночной мутации ДО классификации (§7.10 дословно:
 * уровень получает структурно валидный вызов). Возвращает ПРОВАЛИДИРОВАННЫЙ payload
 * (safeParse.data) — из него же извлекаются факты классификатора; стадия 1 executor'а
 * остаётся второй линией (тот же контракт схем).
 */
function validateMutationEnvelope(def: OrbisToolDef, input: unknown): unknown {
  const schema = def.aspectId !== undefined ? attachAspectInput : MUTATION_ENVELOPES[def.name];
  if (schema === undefined) {
    // недостижимо: все мутирующие тулы реестра покрыты (batch/thread_post — свои ветки)
    throw new Error(`validateMutationEnvelope: нет схемы envelope для «${def.name}»`);
  }
  return parseEnvelope(schema, input, def.name);
}

/**
 * Структурная валидация вложенных операций batch ДО классификации §7.10 (fix round
 * Task 5): operations[].input проверяется схемой соответствующего мутирующего тула
 * (имена уже в executor-форме после translateBatchInput). Имена, непригодные для batch
 * (read-тулы, thread_post, вложенный batch_execute), не валидируются — их отклоняет
 * стадия 1 executor'а собственной честной ошибкой, валидировать их envelope бессмысленно.
 * Возвращает payload с ПРОВАЛИДИРОВАННЫМИ input'ами операций.
 */
function validateBatchOperations(payload: BatchExecuteInput): BatchExecuteInput {
  return {
    batch_id: payload.batch_id,
    operations: payload.operations.map((op, index) => {
      const schema = op.tool.startsWith('attach_')
        ? attachAspectInput
        : MUTATION_ENVELOPES[op.tool];
      if (schema === undefined) return op;
      const parsed = schema.safeParse(op.input);
      if (!parsed.success) {
        throw new ExecError('VALIDATION', `batch_execute: невалидный input операции «${op.tool}»`, {
          index,
          tool: op.tool,
          issues: parsed.error.issues,
        });
      }
      return { tool: op.tool, input: parsed.data as Record<string, unknown> };
    }),
  };
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
 * Envelope валидирует dispatchTool ДО классификации (§7.10) — сюда приходит parsed.
 */
async function runThreadPost(
  ctx: ToolCallCtx,
  parsed: ThreadPostInput,
): Promise<ToolDispatchResult> {
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
