// apps/server/src/executor/executor.ts
// Семистадийный конвейер §9.2 для одиночных тулов entity_create / entity_update /
// attach_<aspect> (batch и relations — Task 10). Стадии — последовательность функций
// над ExecCtx; стадии 1–4 гарантируют «всё или ничего» ДО первой записи, стадии 5–7
// выполняются в одном withIdentity-tx (RLS активна), поэтому отказ на любой стадии
// не оставляет частичного следа.
import { attachAspectInput, entityCreateInput, entityUpdateInput, newId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../db/client';
import { entities } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { resolveEntitlement } from '../entitlements';
import { type AspectRegistry, loadAspectRegistry, validateAspectData } from './aspects-validate';
import { ExecError } from './errors';
import {
  type AspectsMap,
  applyTaskCompletion,
  assertFinancialInvariant,
  extractBodyRefs,
  mergeAspects,
  normalizeTags,
} from './normalize';
import type {
  ActionOperation,
  ActionRecord,
  ExecuteRequest,
  ExecuteResult,
  ExecutorDeps,
  JournalSink,
  WireEntity,
} from './types';

type EntityRow = typeof entities.$inferSelect;
type EntityPatch = Partial<typeof entities.$inferInsert>;

interface ExecCtx {
  tx: Tx;
  registry: AspectRegistry;
  req: ExecuteRequest;
  actionId: string;
  clock: () => Date;
  sink: JournalSink;
}

interface OpOutcome {
  result: WireEntity;
  replay?: boolean;
}

/** Синк по умолчанию: стадии 6–7 вычисляются, но никуда не пишутся (боевой — Task 11). */
const NOOP_SINK: JournalSink = { write: async () => {} };

export async function execute(
  db: Db,
  req: ExecuteRequest,
  deps: ExecutorDeps = {},
): Promise<ExecuteResult> {
  const clock = req.clock ?? (() => new Date());
  const sink = deps.sink ?? NOOP_SINK;
  try {
    const op = req.operations[0];
    if (!op || req.operations.length !== 1) {
      throw new ExecError(
        'VALIDATION',
        'одиночный вызов ожидает ровно одну операцию (атомарная группа — batch_execute)',
        { operations: req.operations.length },
      );
    }
    const actionId = newId();
    return await withIdentity(db, req.actorUserId, async (tx) => {
      const registry = await loadAspectRegistry(tx);
      const ctx: ExecCtx = { tx, registry, req, actionId, clock, sink };
      const out = await dispatch(ctx, op.tool, op.input);
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

async function dispatch(ctx: ExecCtx, tool: string, input: unknown): Promise<OpOutcome> {
  if (tool === 'entity_create') return runEntityCreate(ctx, input);
  if (tool === 'entity_update') return runEntityUpdate(ctx, input);
  if (tool.startsWith('attach_')) {
    const aspectId = resolveAttachAspect(ctx.registry, tool);
    if (aspectId) return runAttach(ctx, tool, aspectId, input);
  }
  // Стадия 1: неизвестный тул → VALIDATION
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

/** Стадии 6–7: inverse-операции + карточка (§7.8) и запись action в JournalSink тем же tx. */
async function writeJournal(
  ctx: ExecCtx,
  p: {
    type: ActionRecord['type'];
    entityId: string;
    tool: string;
    title: string;
    operations: ActionOperation[];
    inverse: ActionOperation[];
  },
): Promise<void> {
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
 * Wire-форма: core-таймстампы наружу — всегда Date.toISOString() (решение 12 плана).
 * БД хранит микросекунды, но драйвер парсит timestamptz в Date (мс), поэтому сравнение
 * expectedUpdatedAt (клиент видел wire-форму) с row.updatedAt.toISOString() симметрично.
 */
function toWire(row: EntityRow): WireEntity {
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    emoji: row.emoji,
    body: row.body,
    bodyRefs: row.bodyRefs,
    tags: row.tags,
    meta: row.meta as Record<string, unknown>,
    aspects: row.aspects as Record<string, Record<string, unknown>>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archived: row.archived,
  };
}

// ---------------------------------------------------------------------------
// entity_create
// ---------------------------------------------------------------------------
async function runEntityCreate(ctx: ExecCtx, rawInput: unknown): Promise<OpOutcome> {
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

  // Стадия 4: доменные инварианты + entitlements-гейт — всё ДО первой записи
  assertFinancialInvariant(aspects);
  gateEntitlements(ctx, 'entity_create');

  // Стадия 5: идемпотентная вставка по client-UUID (§5.3, §9.1)
  const inserted = await ctx.tx
    .insert(entities)
    .values({
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
    })
    .onConflictDoNothing({ target: entities.id })
    .returning();

  const row = inserted[0];
  if (!row) {
    // Конфликт id. Своя строка (RLS видит) → идемпотентный replay без стадий 6–7;
    // чужая (RLS скрывает SELECT) → это НЕ replay, а занятый id — структурированный отказ.
    const existing = await ctx.tx.select().from(entities).where(eq(entities.id, id));
    const own = existing[0];
    if (!own) {
      throw new ExecError(
        'VALIDATION',
        'entity_create: id уже занят недоступной сущностью — сгенерируйте новый UUID',
        { id, reason: 'id_conflict' },
      );
    }
    return { result: toWire(own), replay: true };
  }

  // Стадии 6–7
  const wire = toWire(row);
  await writeJournal(ctx, {
    type: 'entity_created',
    entityId: id,
    tool: 'entity_create',
    title: row.title,
    operations: [
      {
        op: 'entity_create',
        payload: { id, title: row.title, emoji: wire.emoji, body, tags, meta: wire.meta, aspects },
      },
    ],
    // §7.8: создание → архивация (жёсткого удаления нет)
    inverse: [{ op: 'entity_update', payload: { id, archived: true } }],
  });
  return { result: wire };
}

// ---------------------------------------------------------------------------
// entity_update
// ---------------------------------------------------------------------------
async function runEntityUpdate(ctx: ExecCtx, rawInput: unknown): Promise<OpOutcome> {
  // Стадия 1
  const input = parseEnvelope(entityUpdateInput, rawInput, 'entity_update');

  // Стадия 3: load state ПОД ЗАМКОМ — merge аспектов это read-modify-write, без
  // FOR UPDATE конкурентные патчи разных полей одного аспекта теряли бы правки
  const rows = await ctx.tx.select().from(entities).where(eq(entities.id, input.id)).for('update');
  const current = rows[0];
  if (!current) {
    // RLS скрывает чужие строки — «чужая» и «несуществующая» неразличимы намеренно
    throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.id });
  }

  // §5.2: правка body требует optimistic-check по updated_at; патчи без body — LWW
  if (input.body !== undefined) {
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
    const m = mergeAspects(currentAspects, input.aspects);
    nextAspects = m.merged;
    touched = m.touched;
    const mergedTask = nextAspects['orbis/task'];
    if (touched.includes('orbis/task') && mergedTask) {
      applyTaskCompletion(currentAspects['orbis/task'], mergedTask, now);
    }
    for (const aspectId of touched) {
      const data = nextAspects[aspectId];
      if (data !== undefined) validateAspectData(ctx.registry, aspectId, data); // detach не валидируется
    }
    // Стадия 4: инвариант §3.3 над финальным состоянием (ловит и detach orbis/schedule)
    assertFinancialInvariant(nextAspects);
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

  // Стадия 5
  const updated = await ctx.tx
    .update(entities)
    .set(patch)
    .where(eq(entities.id, input.id))
    .returning();
  const row = updated[0];
  if (!row) throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.id });

  // Стадии 6–7
  await writeJournal(ctx, {
    type: 'entity_updated',
    entityId: input.id,
    tool: 'entity_update',
    title: row.title,
    operations: [{ op: 'entity_update', payload: { id: input.id, ...changed } }],
    inverse: [{ op: 'entity_update', payload: { id: input.id, ...prior } }],
  });
  return { result: toWire(row) };
}

// ---------------------------------------------------------------------------
// attach_<aspect> — установка/замена аспект-ключа целиком (data валидируется схемой реестра)
// ---------------------------------------------------------------------------
async function runAttach(
  ctx: ExecCtx,
  tool: string,
  aspectId: string,
  rawInput: unknown,
): Promise<OpOutcome> {
  // Стадия 1
  const input = parseEnvelope(attachAspectInput, rawInput, tool);

  // Стадия 3: под замком — attach конкурирует с merge-обновлениями того же jsonb
  const rows = await ctx.tx
    .select()
    .from(entities)
    .where(eq(entities.id, input.entity_id))
    .for('update');
  const current = rows[0];
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
  assertFinancialInvariant(nextAspects);
  gateEntitlements(ctx, tool);

  // Стадия 5
  const updated = await ctx.tx
    .update(entities)
    .set({ aspects: nextAspects, updatedAt: now })
    .where(eq(entities.id, input.entity_id))
    .returning();
  const row = updated[0];
  if (!row) throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.entity_id });

  // Стадии 6–7: inverse — прежнее значение аспект-ключа (null, если аспекта не было)
  await writeJournal(ctx, {
    type: 'entity_updated',
    entityId: input.entity_id,
    tool,
    title: row.title,
    operations: [{ op: tool, payload: { entity_id: input.entity_id, data } }],
    inverse: [
      {
        op: 'entity_update',
        payload: { id: input.entity_id, aspects: { [aspectId]: prev ?? null } },
      },
    ],
  });
  return { result: toWire(row) };
}
