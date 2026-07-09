// apps/server/src/executor/executor.ts
// Семистадийный конвейер §9.2 для мутирующих тулов: entity_create / entity_update /
// attach_<aspect> / relation_create / relation_delete и атомарной группы batch_execute
// (§7.8). Каждый тул разложен на prepare (стадии 1–4: parse → validate schema →
// load state → invariants+gate, БЕЗ записи) и apply (стадия 5 — единственные записи).
// Одиночный вызов: prepare → apply → журнал (стадии 6–7). Batch: prepare ВСЕХ операций
// над «виртуальным» состоянием (эффекты операции N видны проверкам операции N+1) →
// apply по порядку → ОДИН action с id = batch_id в том же tx. Стадии 5–7 выполняются
// в одном withIdentity-tx (RLS активна), поэтому отказ на любой стадии не оставляет
// частичного следа.
import {
  attachAspectInput,
  batchAuditMessageId,
  batchExecuteInput,
  entityCreateInput,
  entityUpdateInput,
  newId,
  relationCreateInput,
  relationDeleteInput,
} from '@orbis/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { entities, relations } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { resolveEntitlement } from '../entitlements';
// Date→ISO живёт ТОЛЬКО в wire.ts (Task 12); executor использует те же функции
import { toWireEntity as toWire, toWireRelation } from '../wire';
import { type AspectRegistry, loadAspectRegistry, validateAspectData } from './aspects-validate';
import { ExecError } from './errors';
import {
  assertAcyclicBlocks,
  assertNoDuplicateRelation,
  assertSingleBudgetParent,
  duplicateRelationError,
  type RelationKey,
  resolveEntityTitles,
  type VirtualGraphEffects,
} from './invariants';
import {
  type AspectsMap,
  applyTaskCompletion,
  assertFinancialInvariant,
  extractBodyRefs,
  financialRecurringNeedsDerivedFrom,
  mergeAspects,
  normalizeTags,
} from './normalize';
import type {
  ActionOperation,
  ActionRecord,
  ExecuteRequest,
  ExecuteResult,
  ExecutorDeps,
  InternalUndoMode,
  JournalSink,
  JournalWrite,
  WireEntity,
  WireRelation,
} from './types';
import { AuditIdConflictError } from './types';

type EntityRow = typeof entities.$inferSelect;
type EntityPatch = Partial<typeof entities.$inferInsert>;

interface ExecCtx {
  tx: Tx;
  registry: AspectRegistry;
  req: ExecuteRequest;
  actionId: string;
  clock: () => Date;
  sink: JournalSink;
  /** Внутренний режим undo (§7.8) — см. InternalUndoMode; только из undo.ts. */
  internalUndo?: InternalUndoMode;
}

interface OpOutcome {
  result: WireEntity | WireRelation;
  replay?: boolean;
}

/** Данные стадий 6–7 одной операции; для batch агрегируются в один action (§7.8). */
interface JournalPlan {
  type: ActionRecord['type'];
  entityId: string | null;
  tool: string;
  title: string;
  operations: ActionOperation[];
  inverse: ActionOperation[];
}

/** Результат стадий 1–4: план записи. apply — стадия 5, единственные записи в БД. */
interface PreparedOp {
  journal: JournalPlan;
  apply(ctx: ExecCtx): Promise<OpOutcome>;
}

/**
 * «Виртуальное» состояние batch (§7.8): весь batch валидируется ДО первой записи,
 * поэтому эффекты операций 1..N−1 (созданные/изменённые сущности, созданные/удалённые
 * связи) накапливаются здесь и видны стадиям 3–4 операции N.
 */
class BatchState {
  /** Строки сущностей ПОСЛЕ эффектов предыдущих операций batch (created/updated/attach). */
  readonly entities = new Map<string, EntityRow>();
  readonly createdRelations: Array<RelationKey & { sourceHasBudget: boolean }> = [];
  readonly deletedRelations: RelationKey[] = [];
  /**
   * target'ы derived_from-связей, объявленных ЛЮБОЙ операцией batch: batch атомарен,
   * поэтому financial-инвариант (§3.3) легитимируется связью независимо от её позиции.
   */
  readonly declaredDerivedFromTargets: ReadonlySet<string>;

  constructor(declaredDerivedFromTargets: ReadonlySet<string>) {
    this.declaredDerivedFromTargets = declaredDerivedFromTargets;
  }

  graph(): VirtualGraphEffects {
    return {
      created: this.createdRelations,
      deleted: this.deletedRelations,
      titleOf: (id) => this.entities.get(id)?.title,
    };
  }
}

/** Синк по умолчанию: стадии 6–7 вычисляются, но никуда не пишутся (боевой — Task 11).
 *  ВНИМАНИЕ: без персистентного синка идемпотентность batch по batch_id недоступна. */
const NOOP_SINK: JournalSink = {
  write: async () => {},
  findByAuditId: async () => undefined,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Внутренняя (undo, §7.8) форма relation_create: + meta восстанавливаемой связи —
 * inverse relation_delete сохраняет meta, и откат обязан вернуть её. В публичный
 * контракт §9.2 meta не входит (форма недостижима через tRPC/тулы).
 */
const relationCreateInternalInput = relationCreateInput
  .extend({ meta: z.record(z.unknown()).optional() })
  .strict();

export async function execute(
  db: Db,
  req: ExecuteRequest,
  deps: ExecutorDeps = {},
): Promise<ExecuteResult> {
  const clock = req.clock ?? (() => new Date());
  const sink = deps.sink ?? NOOP_SINK;
  try {
    const single = req.operations.length === 1 ? req.operations[0] : undefined;

    // Ветка batch (§7.8, §9.2): явный batchId, несколько операций или тул batch_execute
    if (single === undefined || req.batchId !== undefined || single.tool === 'batch_execute') {
      return await executeBatch(db, req, sink, clock, deps.internalUndo, deps.beforeStages);
    }

    const actionId = newId();
    return await withIdentity(db, req.actorUserId, async (tx) => {
      // Шов сериализации §7.10 — первым statement'ом tx (см. ExecutorDeps.beforeStages)
      if (deps.beforeStages) await deps.beforeStages(tx);
      const registry = await loadAspectRegistry(tx);
      const ctx: ExecCtx = {
        tx,
        registry,
        req,
        actionId,
        clock,
        sink,
        internalUndo: deps.internalUndo,
      };
      const plan = await prepareOp(ctx, single.tool, single.input); // стадии 1–4
      const out = await plan.apply(ctx); // стадия 5
      // Стадии 6–7. Внутренний режим undo: вместо action тем же tx пишется
      // undo-сообщение — undo не порождает нового action (undo неотменяем, §7.8).
      // Иначе — обычный журнал; идемпотентный replay по client-UUID его пропускает (§5.3)
      if (ctx.internalUndo) await ctx.internalUndo.writeUndoMessage(tx);
      else if (out.replay !== true) await writeJournal(ctx, plan.journal);
      return {
        ok: true as const,
        actionId,
        results: [out.result],
        idempotentReplay: out.replay === true,
      };
    });
  } catch (e) {
    if (e instanceof ExecError) {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e; // инфраструктурные ошибки и баги не маскируются под структурированный отказ
  }
}

// ---------------------------------------------------------------------------
// batch_execute (§7.8, §9.2)
// ---------------------------------------------------------------------------
async function executeBatch(
  db: Db,
  req: ExecuteRequest,
  sink: JournalSink,
  clock: () => Date,
  internalUndo?: InternalUndoMode,
  beforeStages?: ExecutorDeps['beforeStages'],
): Promise<ExecuteResult> {
  // Нормализация двух входных форм: тул batch_execute с envelope {batch_id, operations}
  // (§9.2) либо operations>1 + req.batchId (транспортная форма ExecuteRequest)
  let batchId: string;
  let ops: Array<{ tool: string; input: unknown }>;
  const single = req.operations.length === 1 ? req.operations[0] : undefined;
  if (single?.tool === 'batch_execute') {
    const input = parseEnvelope(batchExecuteInput, single.input, 'batch_execute');
    if (req.batchId !== undefined && req.batchId !== input.batch_id) {
      throw new ExecError('VALIDATION', 'batchId запроса расходится с batch_id envelope', {
        batchId: req.batchId,
        envelopeBatchId: input.batch_id,
      });
    }
    batchId = input.batch_id;
    ops = input.operations;
  } else {
    if (req.batchId === undefined) {
      throw new ExecError(
        'VALIDATION',
        'operations.length ≠ 1 — атомарная группа требует batchId (batch_execute, §9.2)',
        { operations: req.operations.length },
      );
    }
    if (!UUID_RE.test(req.batchId)) {
      throw new ExecError('VALIDATION', 'batch_id должен быть uuid (§9.2)', {
        batchId: req.batchId,
      });
    }
    if (req.operations.length === 0) {
      throw new ExecError('VALIDATION', 'batch без операций (§9.2: минимум одна)', {});
    }
    batchId = req.batchId;
    ops = req.operations;
  }

  // Идемпотентность §7.8: детерминированный PK audit-сообщения
  const auditId = batchAuditMessageId(req.actorUserId, batchId);

  try {
    return await withIdentity(db, req.actorUserId, async (tx) => {
      // Шов сериализации §7.10 — первым statement'ом tx, ДО replay-проверки и стадий
      // (см. ExecutorDeps.beforeStages): конкурентный reject либо закоммичен (проверка
      // beforeStages его увидит), либо ждёт этот tx и увидит audit-сообщение
      if (beforeStages) await beforeStages(tx);
      const registry = await loadAspectRegistry(tx);
      const ctx: ExecCtx = { tx, registry, req, actionId: batchId, clock, sink, internalUndo };

      // Повтор batch_id: вернуть сохранённый результат, ничего не применяя (§7.8, §13.4).
      // Внутренний режим undo не идемпотентен по batch_id (id технический) — не проверяем.
      if (!internalUndo) {
        const existing = await sink.findByAuditId(tx, auditId);
        if (existing) return replayFromAudit(batchId, existing);
      }

      // Стадия 1 (гейт batch): допустимы только мутирующие тулы, вложенный batch запрещён.
      // Парс envelope каждой операции — внутри её prepare*.
      for (const op of ops) {
        if (op.tool === 'batch_execute') {
          throw new ExecError('VALIDATION', 'вложенный batch_execute запрещён (§9.2)', {
            tool: op.tool,
          });
        }
      }

      const batch = new BatchState(collectDeclaredDerivedFrom(ops));

      // Стадии 1–4 ВСЕХ операций над виртуальным состоянием — до первой записи (§7.8)
      const plans: PreparedOp[] = [];
      for (const op of ops) {
        plans.push(await prepareOp(ctx, op.tool, op.input, batch));
      }

      // Стадия 5: применение по порядку одним tx
      const results: unknown[] = [];
      for (const plan of plans) {
        results.push((await plan.apply(ctx)).result);
      }

      // Стадии 6–7. Внутренний режим undo: вместо action тем же tx пишется
      // undo-сообщение (undo не порождает нового action — undo неотменяем, §7.8)
      if (internalUndo) {
        await internalUndo.writeUndoMessage(tx);
        return { ok: true as const, actionId: batchId, results, idempotentReplay: false };
      }
      // Обычный batch: ОДИН action на весь batch, id = batch_id; inverse — в обратном
      // порядке исполнения (§7.8). PK audit-сообщения — batchAuditMessageId.
      const action: ActionRecord = {
        id: batchId,
        type: 'batch',
        entity_id: null,
        actor_user_id: req.actorUserId,
        actor_kind: req.actorKind,
        source: req.source,
        operations: plans.flatMap((p) => p.journal.operations),
        inverse: [...plans].reverse().flatMap((p) => [...p.journal.inverse].reverse()),
      };
      await sink.write(tx, {
        id: auditId,
        ownerId: req.actorUserId,
        threadId: req.threadId,
        action,
        card: { tool: 'batch_execute', entity_id: null, title: `batch: операций — ${ops.length}` },
        results,
      });
      return { ok: true as const, actionId: batchId, results, idempotentReplay: false };
    });
  } catch (e) {
    // Гонка одинаковых batch'ей: конкурент вставил audit-сообщение первым → конфликт PK
    // (23505) → tx уже откачен → читаем сохранённый результат отдельным tx (§7.8)
    if (e instanceof AuditIdConflictError) {
      const saved = await withIdentity(db, req.actorUserId, (tx) =>
        sink.findByAuditId(tx, auditId),
      );
      if (saved) return replayFromAudit(batchId, saved);
    }
    throw e;
  }
}

function replayFromAudit(batchId: string, saved: JournalWrite): ExecuteResult {
  return {
    ok: true,
    actionId: batchId,
    results: saved.results ?? [],
    idempotentReplay: true,
  };
}

/** target'ы derived_from из envelope'ов relation_create — по ВСЕМ операциям batch (§3.3). */
function collectDeclaredDerivedFrom(ops: Array<{ tool: string; input: unknown }>): Set<string> {
  const targets = new Set<string>();
  for (const op of ops) {
    if (op.tool !== 'relation_create') continue;
    // Внутренняя форма шире публичной (meta опциональна): для публичных input'ов
    // различий нет, а inverse-операции undo несут meta — пре-пасс не должен их терять
    const parsed = relationCreateInternalInput.safeParse(op.input);
    if (parsed.success && parsed.data.relation_type === 'derived_from') {
      targets.add(parsed.data.target_id);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Диспетчер стадий 1–4
// ---------------------------------------------------------------------------
async function prepareOp(
  ctx: ExecCtx,
  tool: string,
  input: unknown,
  batch?: BatchState,
): Promise<PreparedOp> {
  if (tool === 'entity_create') return prepareEntityCreate(ctx, input, batch);
  if (tool === 'entity_update') return prepareEntityUpdate(ctx, input, batch);
  if (tool === 'relation_create') return prepareRelationCreate(ctx, input, batch);
  if (tool === 'relation_delete') return prepareRelationDelete(ctx, input, batch);
  if (tool.startsWith('attach_')) {
    const aspectId = resolveAttachAspect(ctx.registry, tool);
    if (aspectId) return prepareAttach(ctx, tool, aspectId, input, batch);
  }
  // Стадия 1: неизвестный (или немутирующий) тул → VALIDATION
  throw new ExecError('VALIDATION', `неизвестный тул «${tool}»`, { tool });
}

/** attach_<aspect>-тулы генерируются из реестра (§7.6): orbis/task → attach_orbis_task. */
function resolveAttachAspect(registry: AspectRegistry, tool: string): string | undefined {
  for (const id of registry.keys()) {
    if (tool === `attach_${id.replace(/\//g, '_')}`) return id;
  }
  return undefined;
}

/** Стадия 1: структурная валидация envelope по zod-схеме тула. */
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

/** Стадия 4 (гейт-хук): entitlements §8 — на плане dev всегда разрешено (точка врезки 1b). */
function gateEntitlements(ctx: ExecCtx, key: string): void {
  const decision = resolveEntitlement(ctx.req.actorUserId, key);
  if (!decision.allowed) {
    throw new ExecError('LIMIT', `лимит «${key}» исчерпан`, { key, limit: decision.limit });
  }
}

/** Стадии 6–7 одиночного вызова: запись action в JournalSink тем же tx. */
async function writeJournal(ctx: ExecCtx, p: JournalPlan): Promise<void> {
  const action: ActionRecord = {
    id: ctx.actionId,
    type: p.type,
    entity_id: p.entityId,
    actor_user_id: ctx.req.actorUserId,
    actor_kind: ctx.req.actorKind,
    source: ctx.req.source,
    operations: p.operations,
    inverse: p.inverse,
  };
  await ctx.sink.write(ctx.tx, {
    ownerId: ctx.req.actorUserId,
    threadId: ctx.req.threadId,
    action,
    card: { tool: p.tool, entity_id: p.entityId, title: p.title },
  });
}

/**
 * Стадия 3: строка сущности под замком. В batch виртуальная строка (эффект предыдущих
 * операций) имеет приоритет над БД; отсутствие в обоих источниках — NOT_FOUND у вызывающего.
 * RLS скрывает чужие строки — «чужая» и «несуществующая» неразличимы намеренно.
 */
async function loadEntityForUpdate(
  ctx: ExecCtx,
  id: string,
  batch?: BatchState,
): Promise<EntityRow | undefined> {
  const virtual = batch?.entities.get(id);
  if (virtual) return virtual;
  const rows = await ctx.tx.select().from(entities).where(eq(entities.id, id)).for('update');
  return rows[0];
}

/**
 * Financial-инвариант §3.3 с derived_from-веткой: наличие входящей derived_from
 * резолвится только когда от него зависит валидность (recurring=true без recurrence) —
 * из связей, объявленных тем же batch, либо из БД (минус удаляемые batch'ем).
 */
async function assertFinancial(
  ctx: ExecCtx,
  entityId: string,
  aspects: AspectsMap,
  batch?: BatchState,
): Promise<void> {
  let hasDerivedFrom = false;
  if (financialRecurringNeedsDerivedFrom(aspects)) {
    hasDerivedFrom = await hasIncomingDerivedFrom(ctx, entityId, batch);
  }
  assertFinancialInvariant(aspects, hasDerivedFrom);
}

async function hasIncomingDerivedFrom(
  ctx: ExecCtx,
  entityId: string,
  batch?: BatchState,
): Promise<boolean> {
  if (batch?.declaredDerivedFromTargets.has(entityId)) return true;
  const rows = await ctx.tx
    .select({ sourceId: relations.sourceId })
    .from(relations)
    .where(and(eq(relations.targetId, entityId), eq(relations.relationType, 'derived_from')));
  const deleted = batch?.deletedRelations ?? [];
  return rows.some(
    (r) =>
      !deleted.some(
        (d) =>
          d.sourceId === r.sourceId && d.targetId === entityId && d.relationType === 'derived_from',
      ),
  );
}

/** Код/constraint ошибки PG: drizzle может обернуть причину драйвера в цепочку .cause. */
export function pgErrorInfo(e: unknown): { code?: string; constraint?: string } {
  let cur: unknown = e;
  for (let depth = 0; cur !== null && typeof cur === 'object' && depth < 5; depth++) {
    const err = cur as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof err.code === 'string') {
      const constraint =
        typeof err.constraint_name === 'string'
          ? err.constraint_name
          : typeof err.constraint === 'string'
            ? err.constraint
            : undefined;
      return { code: err.code, constraint };
    }
    cur = err.cause;
  }
  return {};
}

// ---------------------------------------------------------------------------
// entity_create
// ---------------------------------------------------------------------------
async function prepareEntityCreate(
  ctx: ExecCtx,
  rawInput: unknown,
  batch?: BatchState,
): Promise<PreparedOp> {
  // Стадия 1
  const input = parseEnvelope(entityCreateInput, rawInput, 'entity_create');
  const now = ctx.clock();
  const id = input.id ?? newId();

  // Нормализации (§2.1, §4.1): tags lowercase+dedupe, body_refs из body, серверные таймстампы
  const tags = normalizeTags(input.tags);
  const body = input.body ?? '';
  const bodyRefs = extractBodyRefs(body);
  const aspects: AspectsMap = {};
  for (const [aspectId, data] of Object.entries(input.aspects ?? {})) {
    aspects[aspectId] = { ...data };
  }
  // §3.2: create сразу в done без completed_at → проставить clock() (до стадии 2,
  // чтобы валидировалось финальное сохраняемое значение)
  const task = aspects['orbis/task'];
  if (task) applyTaskCompletion(undefined, task, now);

  // Стадия 2: ajv по схемам реестра из БД
  for (const [aspectId, data] of Object.entries(aspects)) {
    validateAspectData(ctx.registry, aspectId, data);
  }

  // Стадия 3 (ТОЛЬКО batch): занятый id — reject, не replay. Идемпотентность batch
  // ключуется по batch_id (§7.8), а не по id операции: replay-семантика одиночного
  // entity_create (§5.3) внутри batch НЕ действует — занятый id в batch всегда ошибка
  // вызывающего. Без этой проверки в виртуальное состояние лёг бы ФАНТОМ с новыми
  // значениями, скрыв реальные аспекты от инвариантов графа (обход «одного
  // budget-parent»), а inverse-архивация ссылалась бы на несозданную сущность.
  // FOR UPDATE держит замок до конца tx: конкурентный create того же id сериализуется.
  // Чужой/невидимый id RLS скрывает от SELECT — его единообразно отклонит стадия 5.
  //
  // Код всех id_conflict-путей — CONFLICT, не VALIDATION (финальное ревью): единый
  // wire-контракт с chat.appendMessage — 1b MCP и 1c retry-буфер ключуются на кодах,
  // 409 = конфликт ресурса. Текст нейтрален и одинаков — не подтверждает занятость
  // конкретного UUID (оракул чужих id, минор Task 9).
  if (batch && input.id !== undefined) {
    if (batch.entities.has(id)) {
      // Дубль явного id внутри одного batch
      throw new ExecError('CONFLICT', 'id непригоден для создания — сгенерируйте новый UUID', {
        id,
        reason: 'id_conflict',
      });
    }
    const occupied = await ctx.tx
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.id, id))
      .for('update');
    if (occupied.length > 0) {
      // id занят видимой (своей) существующей сущностью — reject, не replay (§7.8)
      throw new ExecError('CONFLICT', 'id непригоден для создания — сгенерируйте новый UUID', {
        id,
        reason: 'id_conflict',
      });
    }
  }

  // Стадия 4: доменные инварианты + entitlements-гейт — всё ДО первой записи
  await assertFinancial(ctx, id, aspects, batch);
  gateEntitlements(ctx, 'entity_create');

  const values = {
    id,
    ownerId: ctx.req.actorUserId,
    title: input.title,
    emoji: input.emoji ?? null,
    body,
    bodyRefs,
    tags,
    meta: input.meta ?? {},
    aspects,
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
  // Эффект batch: созданная строка видна стадиям 3–4 следующих операций
  batch?.entities.set(id, values as EntityRow);

  const journal: JournalPlan = {
    type: 'entity_created',
    entityId: id,
    tool: 'entity_create',
    title: input.title,
    operations: [
      {
        op: 'entity_create',
        payload: {
          id,
          title: input.title,
          emoji: values.emoji,
          body,
          tags,
          meta: values.meta,
          aspects,
        },
      },
    ],
    // §7.8: создание → архивация (жёсткого удаления нет)
    inverse: [{ op: 'entity_update', payload: { id, archived: true } }],
  };

  const inBatch = batch !== undefined;
  return {
    journal,
    // Стадия 5: идемпотентная вставка по client-UUID (§5.3, §9.1)
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      const inserted = await applyCtx.tx
        .insert(entities)
        .values(values)
        .onConflictDoNothing({ target: entities.id })
        .returning();
      const row = inserted[0];
      if (!row) {
        // Конфликт id в batch — всегда отказ (единообразно со стадией 3 batch):
        // сюда доходит чужая/невидимая RLS строка, которую стадия 3 не увидела.
        // CONFLICT (409) и нейтральный текст — см. комментарий у стадии 3 batch.
        if (inBatch) {
          throw new ExecError('CONFLICT', 'id непригоден для создания — сгенерируйте новый UUID', {
            id,
            reason: 'id_conflict',
          });
        }
        // Одиночный вызов. Своя строка (RLS видит) → идемпотентный replay без стадий 6–7;
        // чужая (RLS скрывает SELECT) → это НЕ replay, а занятый id — CONFLICT (409),
        // единый wire-контракт id_conflict (см. стадию 3 batch и errors.ts).
        const existing = await applyCtx.tx.select().from(entities).where(eq(entities.id, id));
        const own = existing[0];
        if (!own) {
          throw new ExecError('CONFLICT', 'id непригоден для создания — сгенерируйте новый UUID', {
            id,
            reason: 'id_conflict',
          });
        }
        return { result: toWire(own), replay: true };
      }
      return { result: toWire(row) };
    },
  };
}

// ---------------------------------------------------------------------------
// entity_update
// ---------------------------------------------------------------------------
async function prepareEntityUpdate(
  ctx: ExecCtx,
  rawInput: unknown,
  batch?: BatchState,
): Promise<PreparedOp> {
  // Стадия 1
  const input = parseEnvelope(entityUpdateInput, rawInput, 'entity_update');

  // Стадия 3: load state ПОД ЗАМКОМ — merge аспектов это read-modify-write, без
  // FOR UPDATE конкурентные патчи разных полей одного аспекта теряли бы правки
  const current = await loadEntityForUpdate(ctx, input.id, batch);
  if (!current) {
    throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.id });
  }

  // §5.2: правка body требует optimistic-check по updated_at; патчи без body — LWW.
  // Внутренний режим undo (§7.8) требование ПРОПУСКАЕТ: Undo восстанавливает
  // зафиксированное в журнале прежнее состояние поверх текущего — это осознанный
  // LWW-откат, а не пользовательская правка (inverse не несёт expectedUpdatedAt).
  if (input.body !== undefined && ctx.internalUndo === undefined) {
    if (input.expectedUpdatedAt === undefined) {
      throw new ExecError('VALIDATION', 'правка body требует expectedUpdatedAt (§5.2)', {
        id: input.id,
      });
    }
    const currentIso = current.updatedAt.toISOString();
    if (currentIso !== input.expectedUpdatedAt) {
      throw new ExecError(
        'STALE_VERSION',
        'body изменён конкурентно: перечитайте сущность и повторите правку (§5.2)',
        { id: input.id, expected: input.expectedUpdatedAt, current: currentIso },
      );
    }
  }

  const now = ctx.clock();
  const currentAspects = current.aspects as AspectsMap;

  // Merge аспектов §9.2 + переходы §3.2; стадия 2 валидирует РЕЗУЛЬТАТ merge, не патч
  let nextAspects = currentAspects;
  let touched: string[] = [];
  if (input.aspects) {
    if (ctx.internalUndo) {
      // Внутренний режим undo (§7.8): inverse несёт прежнее значение ВСЕГО затронутого
      // аспект-ключа — восстанавливаем ключ ЦЕЛИКОМ заменой (null → ключа не было).
      // Shallow-merge §9.2 оставил бы поля, добавленные отменяемым действием, а
      // нормализации §3.2 исказили бы зафиксированное состояние — не применяются.
      const replaced: AspectsMap = { ...currentAspects };
      touched = Object.keys(input.aspects);
      for (const [aspectId, value] of Object.entries(input.aspects)) {
        if (value === null) delete replaced[aspectId];
        else replaced[aspectId] = { ...value };
      }
      nextAspects = replaced;
    } else {
      const m = mergeAspects(currentAspects, input.aspects);
      nextAspects = m.merged;
      touched = m.touched;
      const mergedTask = nextAspects['orbis/task'];
      if (touched.includes('orbis/task') && mergedTask) {
        applyTaskCompletion(currentAspects['orbis/task'], mergedTask, now);
      }
    }
    for (const aspectId of touched) {
      const data = nextAspects[aspectId];
      if (data !== undefined) validateAspectData(ctx.registry, aspectId, data); // detach не валидируется
    }
    // Стадия 4: инвариант §3.3 над финальным состоянием (ловит и detach orbis/schedule)
    await assertFinancial(ctx, input.id, nextAspects, batch);
  }

  // Стадия 4: нормализации патча + гейт; changed — «как исполнено», prior — для inverse
  const patch: EntityPatch = { updatedAt: now }; // updated_at проставляется сервером всегда
  const changed: Record<string, unknown> = {};
  const prior: Record<string, unknown> = {};
  if (input.title !== undefined) {
    patch.title = input.title;
    changed.title = input.title;
    prior.title = current.title;
  }
  if (input.emoji !== undefined) {
    patch.emoji = input.emoji;
    changed.emoji = input.emoji;
    prior.emoji = current.emoji;
  }
  if (input.body !== undefined) {
    patch.body = input.body;
    patch.bodyRefs = extractBodyRefs(input.body); // §2.1: при каждом update, затрагивающем body
    changed.body = input.body;
    prior.body = current.body;
  }
  if (input.tags !== undefined) {
    patch.tags = normalizeTags(input.tags);
    changed.tags = patch.tags;
    prior.tags = current.tags;
  }
  if (input.meta !== undefined) {
    patch.meta = input.meta;
    changed.meta = input.meta;
    prior.meta = current.meta;
  }
  if (input.archived !== undefined) {
    patch.archived = input.archived;
    changed.archived = input.archived;
    prior.archived = current.archived;
  }
  if (input.aspects) {
    patch.aspects = nextAspects;
    changed.aspects = Object.fromEntries(touched.map((k) => [k, nextAspects[k] ?? null]));
    // §7.8: inverse аспектов — прежнее значение ВСЕГО затронутого ключа
    // (shallow-merge делает пофазовый откат ненадёжным)
    prior.aspects = Object.fromEntries(touched.map((k) => [k, currentAspects[k] ?? null]));
  }
  gateEntitlements(ctx, 'entity_update');

  // Эффект batch: строка после патча видна следующим операциям
  batch?.entities.set(input.id, { ...current, ...patch } as EntityRow);

  const journal: JournalPlan = {
    type: 'entity_updated',
    entityId: input.id,
    tool: 'entity_update',
    title: input.title ?? current.title,
    operations: [{ op: 'entity_update', payload: { id: input.id, ...changed } }],
    inverse: [{ op: 'entity_update', payload: { id: input.id, ...prior } }],
  };

  return {
    journal,
    // Стадия 5
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      const updated = await applyCtx.tx
        .update(entities)
        .set(patch)
        .where(eq(entities.id, input.id))
        .returning();
      const row = updated[0];
      if (!row) throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.id });
      return { result: toWire(row) };
    },
  };
}

// ---------------------------------------------------------------------------
// attach_<aspect> — установка/замена аспект-ключа целиком (data валидируется схемой реестра)
// ---------------------------------------------------------------------------
async function prepareAttach(
  ctx: ExecCtx,
  tool: string,
  aspectId: string,
  rawInput: unknown,
  batch?: BatchState,
): Promise<PreparedOp> {
  // Стадия 1
  const input = parseEnvelope(attachAspectInput, rawInput, tool);

  // Стадия 3: под замком — attach конкурирует с merge-обновлениями того же jsonb
  const current = await loadEntityForUpdate(ctx, input.entity_id, batch);
  if (!current) {
    throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.entity_id });
  }

  const now = ctx.clock();
  const currentAspects = current.aspects as AspectsMap;
  const prev = currentAspects[aspectId];
  const data = { ...input.data };
  if (aspectId === 'orbis/task') applyTaskCompletion(prev, data, now); // §3.2 и для attach

  // Стадия 2
  validateAspectData(ctx.registry, aspectId, data);

  // Стадия 4
  const nextAspects: AspectsMap = { ...currentAspects, [aspectId]: data };
  await assertFinancial(ctx, input.entity_id, nextAspects, batch);
  gateEntitlements(ctx, tool);

  // Эффект batch
  batch?.entities.set(input.entity_id, { ...current, aspects: nextAspects, updatedAt: now });

  const journal: JournalPlan = {
    type: 'entity_updated',
    entityId: input.entity_id,
    tool,
    title: current.title,
    operations: [{ op: tool, payload: { entity_id: input.entity_id, data } }],
    // Стадии 6–7: inverse — прежнее значение аспект-ключа (null, если аспекта не было)
    inverse: [
      {
        op: 'entity_update',
        payload: { id: input.entity_id, aspects: { [aspectId]: prev ?? null } },
      },
    ],
  };

  return {
    journal,
    // Стадия 5
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      const updated = await applyCtx.tx
        .update(entities)
        .set({ aspects: nextAspects, updatedAt: now })
        .where(eq(entities.id, input.entity_id))
        .returning();
      const row = updated[0];
      if (!row) throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.entity_id });
      return { result: toWire(row) };
    },
  };
}

// ---------------------------------------------------------------------------
// relation_create (§4.2)
// ---------------------------------------------------------------------------

/**
 * Стадия 3 relation-тулов: обе сущности под FOR UPDATE в детерминированном порядке id
 * (меньше дедлоков при перекрёстных связях). Отсутствие любой из них — в т.ч. чужой,
 * скрытой RLS (42501 недостижим: до INSERT не доходим) — единообразный NOT_FOUND.
 */
async function loadBothEndsForUpdate(
  ctx: ExecCtx,
  key: RelationKey,
  batch?: BatchState,
): Promise<{ source: EntityRow; target: EntityRow }> {
  const loaded = new Map<string, EntityRow>();
  for (const id of [key.sourceId, key.targetId].sort()) {
    const row = await loadEntityForUpdate(ctx, id, batch);
    if (!row) throw new ExecError('NOT_FOUND', 'сущность не найдена', { id });
    loaded.set(id, row);
  }
  const source = loaded.get(key.sourceId);
  const target = loaded.get(key.targetId);
  if (!source || !target) {
    throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: key.sourceId }); // недостижимо
  }
  return { source, target };
}

function hasAspect(row: EntityRow, aspectId: string): boolean {
  return (row.aspects as AspectsMap)[aspectId] !== undefined;
}

async function prepareRelationCreate(
  ctx: ExecCtx,
  rawInput: unknown,
  batch?: BatchState,
): Promise<PreparedOp> {
  // Стадия 1. Внутренний режим undo принимает meta восстанавливаемой связи (§7.8):
  // inverse relation_delete сохраняет meta, откат обязан вернуть её как было
  const input = parseEnvelope(
    ctx.internalUndo ? relationCreateInternalInput : relationCreateInput,
    rawInput,
    'relation_create',
  );
  const meta = ctx.internalUndo ? ((input as { meta?: Record<string, unknown> }).meta ?? {}) : {};
  const key: RelationKey = {
    sourceId: input.source_id,
    targetId: input.target_id,
    relationType: input.relation_type,
  };

  // Самосвязь — превентивно (честный текст вместо CHECK rel_no_self со стадии 5)
  if (key.sourceId === key.targetId) {
    throw new ExecError('INVARIANT', 'связь сущности с самой собой запрещена (rel_no_self, §4.2)', {
      invariant: 'self_relation',
      id: key.sourceId,
    });
  }

  // Стадия 3
  const { source, target } = await loadBothEndsForUpdate(ctx, key, batch);

  // Стадия 4: доменные инварианты графа (§4.2)
  if (batch) await assertNoDuplicateRelation(ctx.tx, key, batch.graph()); // batch: дубль ловим ДО записи
  if (key.relationType === 'blocks') {
    await assertAcyclicBlocks(
      ctx.tx,
      ctx.req.actorUserId,
      key.sourceId,
      key.targetId,
      batch?.graph(),
    );
  }
  const sourceHasBudget = hasAspect(source, 'orbis/budget');
  if (key.relationType === 'parent' && sourceHasBudget && hasAspect(target, 'orbis/financial')) {
    await assertSingleBudgetParent(ctx.tx, key.sourceId, key.targetId, batch?.graph());
  }
  gateEntitlements(ctx, 'relation_create');

  const id = newId();
  const now = ctx.clock();

  // Эффект batch: связь видна проверкам следующих операций
  batch?.createdRelations.push({ ...key, sourceHasBudget });

  const journal: JournalPlan = {
    type: 'relation_created',
    entityId: key.sourceId,
    tool: 'relation_create',
    title: `${key.relationType}: «${source.title}» → «${target.title}»`,
    operations: [
      {
        op: 'relation_create',
        payload: {
          id,
          source_id: key.sourceId,
          target_id: key.targetId,
          relation_type: key.relationType,
        },
      },
    ],
    // §7.8: создание relation → её удаление
    inverse: [
      {
        op: 'relation_delete',
        payload: {
          source_id: key.sourceId,
          target_id: key.targetId,
          relation_type: key.relationType,
        },
      },
    ],
  };

  return {
    journal,
    // Стадия 5: вставка; повтор тройки под гонкой — 23505 rel_uniq → структурированная
    // INVARIANT/duplicate_relation, не 500 (§4.2)
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      try {
        const inserted = await applyCtx.tx
          .insert(relations)
          .values({
            id,
            sourceId: key.sourceId,
            targetId: key.targetId,
            relationType: key.relationType,
            meta,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const row = inserted[0];
        if (!row) throw new ExecError('NOT_FOUND', 'связь не записана', { ...key }); // недостижимо
        return { result: toWireRelation(row) };
      } catch (e) {
        const pg = pgErrorInfo(e);
        if (pg.code === '23505' && pg.constraint === 'rel_uniq') throw duplicateRelationError(key);
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// relation_delete (§4.2): обычный DELETE; пересоздание — новая строка с новым id
// ---------------------------------------------------------------------------
async function prepareRelationDelete(
  ctx: ExecCtx,
  rawInput: unknown,
  batch?: BatchState,
): Promise<PreparedOp> {
  // Стадия 1
  const input = parseEnvelope(relationDeleteInput, rawInput, 'relation_delete');
  const key: RelationKey = {
    sourceId: input.source_id,
    targetId: input.target_id,
    relationType: input.relation_type,
  };
  const matchesKey = (k: RelationKey) =>
    k.sourceId === key.sourceId &&
    k.targetId === key.targetId &&
    k.relationType === key.relationType;

  // Стадия 3: строка связи под замком. Приоритет — виртуальная связь, созданная тем же
  // batch (к моменту apply она уже будет вставлена); RLS скрывает чужие → NOT_FOUND.
  const virtualIdx = batch ? batch.createdRelations.findIndex(matchesKey) : -1;
  let existingMeta: Record<string, unknown> = {};
  if (virtualIdx < 0) {
    const rows = await ctx.tx
      .select()
      .from(relations)
      .where(
        and(
          eq(relations.sourceId, key.sourceId),
          eq(relations.targetId, key.targetId),
          eq(relations.relationType, key.relationType),
        ),
      )
      .for('update');
    const row = rows[0];
    // Строка, уже удаляемая предыдущей операцией того же batch, — «не найдена»
    const alreadyDeletedInBatch = batch?.deletedRelations.some(matchesKey) === true;
    if (!row || alreadyDeletedInBatch) {
      throw new ExecError('NOT_FOUND', 'связь не найдена', { ...key });
    }
    existingMeta = row.meta as Record<string, unknown>;
  }

  // Стадия 4
  gateEntitlements(ctx, 'relation_delete');

  // Эффекты batch: связь исчезает из виртуального графа
  if (batch) {
    if (virtualIdx >= 0) batch.createdRelations.splice(virtualIdx, 1);
    else batch.deletedRelations.push(key);
  }

  // Титулы — только для карточки (без замка)
  const titles = await resolveEntityTitles(
    ctx.tx,
    [key.sourceId, key.targetId],
    batch ? (id) => batch.entities.get(id)?.title : undefined,
  );

  const journal: JournalPlan = {
    type: 'relation_deleted',
    entityId: key.sourceId,
    tool: 'relation_delete',
    title: `удалена ${key.relationType}: «${titles.get(key.sourceId) ?? key.sourceId}» → «${titles.get(key.targetId) ?? key.targetId}»`,
    operations: [
      {
        op: 'relation_delete',
        payload: {
          source_id: key.sourceId,
          target_id: key.targetId,
          relation_type: key.relationType,
        },
      },
    ],
    // §7.8: удаление relation → её пересоздание (meta сохраняется в inverse)
    inverse: [
      {
        op: 'relation_create',
        payload: {
          source_id: key.sourceId,
          target_id: key.targetId,
          relation_type: key.relationType,
          meta: existingMeta,
        },
      },
    ],
  };

  return {
    journal,
    // Стадия 5: DELETE по тройке (строка под замком стадии 3 либо вставлена этим же batch)
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      const deleted = await applyCtx.tx
        .delete(relations)
        .where(
          and(
            eq(relations.sourceId, key.sourceId),
            eq(relations.targetId, key.targetId),
            eq(relations.relationType, key.relationType),
          ),
        )
        .returning();
      const row = deleted[0];
      if (!row) throw new ExecError('NOT_FOUND', 'связь не найдена', { ...key });
      return { result: toWireRelation(row) };
    },
  };
}
