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
  attachToolName,
  batchAuditMessageId,
  batchExecuteInput,
  type EntityUpdatePrecondition,
  type EntityUpdatePreconditionItem,
  effectiveLabel,
  entityCreateExecInput,
  entityUpdateExecInput,
  newId,
  type PreconditionMismatch,
  ROLE_ENVELOPE_BINDING,
  ROLE_INSTANCE_OF,
  RULE_NEAREST_ANCESTOR,
  relationCreateInput,
  relationDeleteInput,
} from '@orbis/shared';
// Конверсия тела живёт в @orbis/shared/doc — ОДИН экземпляр правил разбора и сериализации
// на сервер и клиент; своей копии у executor'а нет и быть не должно.
import {
  bindQueryBlocks,
  bodyDocError,
  bodyPairFromDoc,
  bodyRefsFromDoc,
  DOC_SCHEMA_VERSION,
  queryRefsFromDoc,
} from '@orbis/shared/doc';
import { OWNER_LOCALE } from '@orbis/shared/query';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  assertEnvelopeUnique,
  BindingReads,
  type BindingTarget,
  type BudgetOpDesc,
  bindingOps,
  bindingTargetOf,
  lockOwnerBudget,
  normalizeEnvelopeCurrency,
  rebindForEnvelope,
  unbindOps,
} from '../budget/binding';
import type { Db } from '../db/client';
import { entities, entityOrigins, entityVersions, relations } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { resolveEntitlement } from '../entitlements';
import type { CompileCtx } from '../query/compile-ast';
import { ownerTimeZone, todayInTimeZone } from '../query/context';
import { effectiveRegistry, parseRegistryOfSnapshot } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import {
  type CreatePropertyInput,
  createProperty,
  lockOwnerRegistry,
  type MergeInverse,
  mergeProperty,
  type PropertyRow,
  readAspectDelta,
  readOwnProperty,
  removeAspectDelta,
  restorePropertyRow,
  setAspectDelta,
  undoMerge,
  updateProperty,
} from '../registry/ops';
import {
  assertReferenceProps,
  changedRefProps,
  markRefSourcesNeedsReview,
  type RefPropChange,
  syncRefMirror,
} from '../registry/ref';
import { projectBodyTemplate } from '../seed/project-body';
import {
  aspectDeltaRemoveInput,
  aspectDeltaSetInput,
  propertyCreateInput,
  propertyMergeInput,
  propertyUpdateInput,
  REGISTRY_TOOL_NAMES,
} from '../tools/registry-tools';
// Date→ISO живёт ТОЛЬКО в wire.ts (Task 12); executor использует те же функции
import { toWireEntity as toWire, toWireRelation } from '../wire';
import { PROJECT_ASPECT, recomputeProjectAncestors } from './ancestors';
import { assertEntityProps } from './aspects-validate';
import { bodyFieldsFromMarkdown } from './body-fields';
import { ExecError } from './errors';
import {
  assertAssignment,
  assertRoutineRelationUntouchable,
  assertRoutineUntouchable,
  assertRunSubject,
  resolveEntityTitles,
} from './invariants';
import {
  fromLegacyInput,
  hasPropsInput,
  projectLegacyAspects,
  projectLegacyRelationType,
} from './legacy-form';
import {
  type AspectsMap,
  applyTaskCompletion,
  assertFinancialInvariant,
  dropStaleCarryover,
  financialRecurringNeedsDerivedFrom,
  hasBodyInInput,
  needsProjectSeed,
  normalizeTags,
  TASK_STATUS,
} from './normalize';
import {
  applyPropsPatch,
  assertPropsWritable,
  comparePropertyValue,
  type EntityState,
  type PropsPatch,
  replaceAspectProps,
  resolvePropertyRef,
  stateDelta,
  touchedAspects,
  touchedProperties,
  writableOnly,
} from './props';
import {
  assertNoDuplicateRelation,
  assertRoleConstraints,
  assertSingleLegacyBudgetParent,
  duplicateRelationError,
  LEGACY_PARENT_ROLES,
  type RelationKey,
  sameRelationKey,
  type VirtualGraphEffects,
  type VirtualRelationCreate,
} from './relations';
import type {
  ActionOperation,
  ActionRecord,
  ActorKind,
  ExecuteRequest,
  ExecuteResult,
  ExecutorDeps,
  InternalUndoMode,
  JournalSink,
  JournalWrite,
  MutationMechanism,
  WireEntity,
  WireEntityVersion,
  WireOrigin,
  WireRelation,
} from './types';
import { AuditIdConflictError } from './types';

type EntityRow = typeof entities.$inferSelect;
type EntityPatch = Partial<typeof entities.$inferInsert>;

interface ExecCtx {
  tx: Tx;
  /** Снимок реестров владельца на транзакцию (§А10): по нему идут и резолв, и валидация. */
  registry: RegistrySnapshot;
  /** Механизм записи (§А4-4): ось гейтов флагов, отдельная от канала `req.source`. */
  mechanism: MutationMechanism;
  req: ExecuteRequest;
  actionId: string;
  clock: () => Date;
  sink: JournalSink;
  /** Внутренний режим undo (§7.8) — см. InternalUndoMode; только из undo.ts. */
  internalUndo?: InternalUndoMode;
  /**
   * Контекст компиляции запросов (§А5-7) — ЛЕНИВЫЙ и на транзакцию: его спрашивает
   * единственный потребитель, проверка ссылочных свойств (§А6-1), и только когда операция
   * ДЕЙСТВИТЕЛЬНО пишет ссылку. Иначе каждая правка заголовка платила бы лишним SELECT'ом
   * по `user_settings` за таймзону, которой ей не нужно.
   */
  compileCtx?: Promise<CompileCtx>;
}

/**
 * Контекст компиляции для проверки ссылок. Реестр берётся из снимка транзакции (второй его
 * загрузкой платил бы каждый вызов), таймзона — из настроек владельца, «сегодня» — от часов
 * операции, а не от `new Date()`: компиляция обязана быть детерминированной вместе со всей
 * остальной транзакцией.
 *
 * `today`/`timeZone` при этом множеством цели НЕ читаются: `ref.target` обязан быть
 * СТАТИЧЕСКИМ (§А6-1), а статичность запрещает date-токены именно затем, чтобы ссылка,
 * законная в понедельник, во вторник не оказывалась вне цели. Поля здесь потому, что их
 * требует ОБЩИЙ контекст компилятора, а не потому, что их кто-то спросит.
 *
 * Чем это обязательство держится СЕГОДНЯ: гейтом на ПУТИ ЗАПИСИ определения
 * (`registry/ops.ts`, `assertRegistryQuery` — он зовёт `assertStaticQuery` на `scope` и на
 * `ref.target` своего свойства владельца, до INSERT'а), плюс тестом `ref.test.ts` («каждый
 * встроенный `ref.target` статичен») по встроенному словарю. До Задачи 15 боевых
 * вызывающих у `assertStaticQuery` не было ни одного, и пин по словарю был всем, что тут
 * можно было проверить честно.
 */
function compileCtxOf(ctx: ExecCtx): Promise<CompileCtx> {
  ctx.compileCtx ??= (async () => {
    const timeZone = await ownerTimeZone(ctx.tx, ctx.req.actorUserId);
    return {
      ownerId: ctx.req.actorUserId,
      reg: ctx.registry,
      thisEntityId: null,
      timeZone,
      today: todayInTimeZone(timeZone, ctx.clock()),
    };
  })();
  return ctx.compileCtx;
}

/**
 * Исход операции РЕЕСТРА (§А10-2): ни сущность, ни связь — реестр меняется, а граф нет.
 * Отдельный тип, а не приведение чужого: в публичном контракте §9.2 такого ответа не было,
 * и «сущность без полей» читалась бы как пустой результат.
 */
export type WireRegistryResult =
  | { property: string; key: string }
  | { property: string }
  | { source: string; into: string; rewrittenEntities: number; rewrittenQueries: number }
  | { aspect: string };

interface OpOutcome {
  result: WireEntity | WireRelation | WireOrigin | WireEntityVersion | WireRegistryResult;
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

/**
 * Вход бюджет-хука A4 (§2.3): состояние сущности до и после операции. Заполняется
 * prepare-стадией entity_create/entity_update/attach_<aspect>; после применения
 * операции executor дописывает в тот же action операции привязки/ребиндинга.
 */
interface BudgetHook {
  before: EntityRow | null;
  after: EntityRow;
}

/** Результат стадий 1–4: план записи. apply — стадия 5, единственные записи в БД. */
interface PreparedOp {
  journal: JournalPlan;
  apply(ctx: ExecCtx): Promise<OpOutcome>;
  budgetHook?: BudgetHook;
  /**
   * Сущности, чьё ПОДДЕРЕВО операция могла сдвинуть по правилу `nearest_ancestor` (§А8):
   * цель изменённого иерархического ребра либо сущность, у которой навесили/сняли
   * `orbis/project`. Пересчёт запускается после стадии 5 (см. `applyAncestorRecompute`).
   */
  ancestorRoots?: string[];
  /**
   * Ссылочная половина записи свойств (§А6): что проверить против множеств `target` и какие
   * зеркала-рёбра пересобрать. И то и другое — ПОСЛЕ стадии 5 (см. `applyRefEffects`).
   */
  refWrite?: {
    entityId: string;
    /** Итоговые значения свойств: по ним идут и проверка целей, и сборка зеркала. */
    props: Record<string, unknown>;
    /** Затронутые ССЫЛОЧНЫЕ свойства (`ref`/`registry_ref`) — вход проверки §А6-1. */
    touched: string[];
    /** Ссылочные свойства, чьё зеркало пересобирается (§А6-2). */
    mirror: RefPropChange[];
  };
  /**
   * Сущность, которую операция УБРАЛА В АРХИВ: её источники ссылок получают `needs-review`
   * (§А6-3) той же транзакцией. Не «архивна», а «стала архивной» — иначе каждая правка
   * архивной записи перепомечала бы её источников заново.
   */
  archivedRefTarget?: string;
}

/**
 * «Виртуальное» состояние batch (§7.8): весь batch валидируется ДО первой записи,
 * поэтому эффекты операций 1..N−1 (созданные/изменённые сущности, созданные/удалённые
 * связи) накапливаются здесь и видны стадиям 3–4 операции N.
 */
class BatchState {
  /** Строки сущностей ПОСЛЕ эффектов предыдущих операций batch (created/updated/attach). */
  readonly entities = new Map<string, EntityRow>();
  readonly createdRelations: VirtualRelationCreate[] = [];
  readonly deletedRelations: RelationKey[] = [];
  /**
   * target'ы связей роли `instance-of`, объявленных ЛЮБОЙ операцией batch: batch атомарен,
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
      // Строки, ТРОНУТЫЕ batch'ем, лежат здесь уже в состоянии ПОСЛЕ операции (create /
      // update / attach кладут afterRow) — значит проверка видит аспекты такими, какими они
      // будут, а не какими были на момент создания ребра. `loadEntityForUpdate` сюда ничего
      // не кладёт: нетронутый источник остаётся `undefined`, и у него в силе фолбэк.
      aspectsOf: (id) => this.entities.get(id)?.aspects,
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

/**
 * Внутренние операции provenance импорта (01-arch §4.8, 03-budget §3.4/§3.4.1).
 * Схемы живут ЗДЕСЬ, а не в публичном контракте §9.2 (shared/contracts/tools.ts), и
 * операции НЕ регистрируются в CORE_TOOLS: dispatchTool их не резолвит, в tools/list
 * по MCP они не попадают — строку origins пишет только серверный флоу импорта
 * (routers/import.ts), а inverse при Undo её физически удаляет.
 */
const entityOriginCreateInput = z
  .object({
    entity_id: z.string().uuid(),
    namespace: z.string().min(1),
    external_id: z.string().min(1),
  })
  .strict();

/** Ключ строки origins — уникальная тройка (owner_id из RLS, namespace, external_id). */
const entityOriginDeleteInput = z
  .object({ namespace: z.string().min(1), external_id: z.string().min(1) })
  .strict();

/**
 * Внутренние операции закрепления версии тела (С11, ADE-срез 1). Как и origin-операции
 * выше, они живут ЗДЕСЬ и в CORE_TOOLS не регистрируются: dispatchTool их не резолвит, в
 * tools/list по MCP они не попадают. Единственный внешний путь — роутер version (tRPC), то
 * есть рука владельца; модель закрепляет версию не сама, а прося владельца.
 *
 * id строки опционален: обычно его выбирает сервер (newId), но вызывающий вправе задать
 * свой — тогда идентификатор снимка известен до записи. Повтор занятого id — не replay, а
 * отказ CONFLICT (PK): у закрепления нет входа, по которому «повторить» было бы тем же
 * снимком (тело сущности к этому моменту уже другое).
 */
const entityVersionPinInput = z
  .object({
    id: z.string().uuid().optional(),
    entity_id: z.string().uuid(),
    // 200 — подпись, а не заметка: она рисуется одной строкой в списке версий.
    // trim ДО min(1): подпись из одних пробелов рисуется пустотой в списке и в карточке
    // журнала («Закреплена версия «   »») — то есть снимок без подписи, а её тут нет
    // только у строк «до бэкфилла».
    label: z.string().trim().min(1).max(200),
  })
  .strict();

/** Ключ строки версии — её собственный id (в отличие от origins, тройки здесь нет). */
const entityVersionDeleteInput = z.object({ id: z.string().uuid() }).strict();

/**
 * Wire-форма снимка: тела в ней нет (см. докблок WireEntityVersion) — вместо документа
 * едет признак его наличия. actorKind в БД — text (колонка общая с будущими агентами),
 * сужение до ActorKind законно: пишет её только executor из ExecuteRequest.
 */
function toWireEntityVersion(row: typeof entityVersions.$inferSelect): WireEntityVersion {
  return {
    id: row.id,
    entityId: row.entityId,
    label: row.label,
    hasDoc: row.bodyDoc !== null,
    actorKind: row.actorKind as ActorKind,
    createdAt: row.createdAt.toISOString(),
  };
}

function toWireOrigin(row: typeof entityOrigins.$inferSelect): WireOrigin {
  return {
    id: row.id,
    entityId: row.entityId,
    namespace: row.namespace,
    externalId: row.externalId,
    createdAt: row.createdAt.toISOString(),
  };
}

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
      // Шов сериализации §7.10 — до первого чтения состояния (см. ExecutorDeps.beforeStages)
      if (deps.beforeStages) await deps.beforeStages(tx);
      // Снимок реестра — ДО замка контура, и это безопасно: три SELECT'а по таблицам
      // определений не берут ни строковых, ни advisory-блокировок, то есть в цикл ожидания
      // §2.3 войти не могут. А замку он НУЖЕН: предикат контура теперь смотрит на id
      // свойств financial/budget по реестру, а не на имена полей во входе (Р-27).
      const registry = await effectiveRegistry(tx, req.actorUserId);
      // Замок РЕЕСТРА — ПЕРВЫЙ из двух (см. lockOwnerRegistry): порядок «реестр → бюджет»
      // глобален, и переставить его местами значит завести цикл ожидания.
      await lockRegistry(tx, req.actorUserId, [single]);
      // Замок бюджет-контура — ДО стадий и любых строковых блокировок (см. lockBudgetContour)
      await lockBudgetContour(tx, registry, req.actorUserId, [single]);
      const ctx: ExecCtx = {
        tx,
        registry,
        mechanism: req.mechanism ?? 'user',
        req,
        actionId,
        clock,
        sink,
        internalUndo: deps.internalUndo,
      };
      const plan = await prepareOp(ctx, single.tool, single.input); // стадии 1–4
      const out = await plan.apply(ctx); // стадия 5
      // Бюджет-хук A4 (§2.3): привязка/ребиндинг ТЕМ ЖЕ tx, операции — в тот же action.
      // Replay по client-UUID ничего не применял — хук не запускается (идемпотентность §5.3)
      let followUps: PreparedOp[] = [];
      if (!ctx.internalUndo && out.replay !== true && plan.budgetHook) {
        followUps = await applyBudgetFollowUps(ctx, [plan.budgetHook]);
      }
      // Стадии 6–7. Внутренний режим undo: вместо action тем же tx пишется
      // undo-сообщение — undo не порождает нового action (undo неотменяем, §7.8).
      // Иначе — обычный журнал; идемпотентный replay по client-UUID его пропускает (§5.3)
      if (ctx.internalUndo) {
        // Пересчёт предков (§А8) откату НУЖЕН: inverse вернул ребро, предки обязаны сойтись
        // с восстановленным графом. Журнала у undo нет, поэтому строка пересчёта отбрасывается.
        await applyAncestorRecompute(ctx, [plan]);
        // Зеркала ссылок (§А6-2) — по той же причине: откат вернул ЗНАЧЕНИЕ, ребро обязано
        // сойтись с ним (своего inverse у зеркала нет — см. шапку `registry/ref.ts`).
        await applyRefEffects(ctx, [plan]);
        await ctx.internalUndo.writeUndoMessage(tx);
      } else if (out.replay !== true) {
        const allPlans = [plan, ...followUps];
        // Пересчёт — ПОСЛЕ бюджет-хука: снятие устаревшей привязки удаляет ребро роли
        // владельца (`budgetParentsOfMany` до 0017 считает привязкой и её), а такая роль
        // бывает иерархической — считать предков до хука значило бы считать их по графу,
        // которого к коммиту уже нет.
        const recomputeOps = await applyAncestorRecompute(ctx, allPlans);
        const refOps = await applyRefEffects(ctx, allPlans);
        await writeJournal(ctx, {
          ...plan.journal,
          operations: [
            ...allPlans.flatMap((p) => p.journal.operations),
            ...recomputeOps,
            ...refOps,
          ],
          inverse: aggregateInverse(allPlans),
        });
      }
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
      // Шов сериализации §7.10 — до первого чтения состояния, ДО replay-проверки и стадий
      // (см. ExecutorDeps.beforeStages): конкурентный reject либо закоммичен (проверка
      // beforeStages его увидит), либо ждёт этот tx и увидит audit-сообщение
      if (beforeStages) await beforeStages(tx);
      // Снимок реестра — ДО замка контура (см. одиночный путь: плановые SELECT'ы в цикл
      // ожидания не входят, а предикат контура без реестра неполон — Р-27)
      const registry = await effectiveRegistry(tx, req.actorUserId);
      // Замок РЕЕСТРА — ПЕРВЫЙ из двух, тем же порядком, что и на одиночном пути
      await lockRegistry(tx, req.actorUserId, ops);
      // Замок бюджет-контура — ДО стадий и любых строковых блокировок (см. lockBudgetContour)
      await lockBudgetContour(tx, registry, req.actorUserId, ops);
      const ctx: ExecCtx = {
        tx,
        registry,
        mechanism: req.mechanism ?? 'user',
        req,
        actionId: batchId,
        clock,
        sink,
        internalUndo,
      };

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
        // См. одиночный путь: откату пересчёт предков и сведение зеркал нужны, журнала нет.
        await applyAncestorRecompute(ctx, plans);
        await applyRefEffects(ctx, plans);
        await internalUndo.writeUndoMessage(tx);
        return { ok: true as const, actionId: batchId, results, idempotentReplay: false };
      }
      // Бюджет-хук A4 (§2.3): после применения ВСЕХ операций batch — привязка/ребиндинг
      // тем же tx. Дописанные операции входят в тот же action (Undo откатывает целиком);
      // в results НЕ попадают — ответ batch соответствует запрошенным операциям (§9.2)
      const followUps = await applyBudgetFollowUps(
        ctx,
        plans.flatMap((p) => (p.budgetHook ? [p.budgetHook] : [])),
      );
      const allPlans = [...plans, ...followUps];
      // Пересчёт предков — после бюджет-хука (см. одиночный путь).
      const recomputeOps = await applyAncestorRecompute(ctx, allPlans);
      const refOps = await applyRefEffects(ctx, allPlans);
      // Обычный batch: ОДИН action на весь batch, id = batch_id; inverse — в обратном
      // порядке исполнения (§7.8). PK audit-сообщения — batchAuditMessageId.
      const action: ActionRecord = {
        id: batchId,
        type: 'batch',
        entity_id: null,
        actor_user_id: req.actorUserId,
        actor_kind: req.actorKind,
        source: req.source,
        mechanism: ctx.mechanism,
        // Только если заданы: пустых ключей в журнале не заводим (см. ActionRecord)
        ...(req.actorGrantId !== undefined && { actor_grant_id: req.actorGrantId }),
        ...(req.runId !== undefined && { run_id: req.runId }),
        ...(req.editedFrom !== undefined && { edited_from: req.editedFrom }),
        operations: [...allPlans.flatMap((p) => p.journal.operations), ...recomputeOps, ...refOps],
        inverse: aggregateInverse(allPlans),
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

/** target'ы роли `instance-of` из envelope'ов relation_create — по ВСЕМ операциям batch (§3.3). */
function collectDeclaredDerivedFrom(ops: Array<{ tool: string; input: unknown }>): Set<string> {
  const targets = new Set<string>();
  for (const op of ops) {
    if (op.tool !== 'relation_create') continue;
    // Внутренняя форма шире публичной (meta опциональна): для публичных input'ов
    // различий нет, а inverse-операции undo несут meta — пре-пасс не должен их терять
    const parsed = relationCreateInternalInput.safeParse(op.input);
    if (parsed.success && parsed.data.role === ROLE_INSTANCE_OF) {
      targets.add(parsed.data.target_id);
    }
  }
  return targets;
}

/** Аспекты, из которых состоит бюджет-контур владельца (§2.3): транзакция и конверт. */
const BUDGET_CONTOUR_ASPECTS = ['orbis/financial', 'orbis/budget'] as const;

/**
 * Свойства бюджет-контура — объединение свойств `orbis/financial` и `orbis/budget` ПО
 * РЕЕСТРУ. Считается на каждый вызов и не кешируется: снимок реестра живёт одну транзакцию,
 * а аспектов здесь два и свойств в них полтора десятка.
 */
function budgetContourProperties(reg: RegistrySnapshot): Set<string> {
  const ids = new Set<string>();
  for (const aspectId of BUDGET_CONTOUR_ASPECTS) {
    for (const ref of reg.aspects.get(aspectId)?.properties ?? []) ids.add(ref.propertyId);
  }
  return ids;
}

/**
 * Трогает ли операция бюджет-контур — по входу, до стадий разбора.
 *
 * Нужен ровно для одного: взять замок владельца ПЕРВЫМ блокирующим statement'ом транзакции,
 * до любых строковых блокировок (см. lockBudgetContour ниже). Точность здесь не критична в
 * сторону «лишний раз взяли» (замок владельческий, реентерабельный и дешёвый), критична в
 * сторону «не взяли»: тогда путь вернётся к прежнему порядку захвата и вернётся дедлок E9.
 *
 * Ровно поэтому предикат ПЕРЕПИСАН на реестр (Р-27), а не оставлен нюхать имена полей.
 * После реформы контур адресуется тремя разными способами сразу: старой картой аспектов
 * (её ещё шлют тулы и web), новой формой `props`/`unset` по id ИЛИ key свойства и списком
 * `aspects.attach/detach`. Прежний предикат («ключ 'orbis/financial' в карте `aspects`»)
 * видел только первый — и на переведённом пути замок молча перестал бы браться. Тесты
 * этого не показали бы: дедлок ловится не отказом, а таймаутом под конкуренцией.
 *
 * `archived` в entity_update: архивация/разархивация транзакции меняет привязку (ветка
 * archivedChanged бюджет-хука), а какие у сущности аспекты, по входу не видно.
 *
 * ЭКСПОРТИРОВАН РАДИ ТЕСТА, и это осознанно: провал предиката наблюдаем не отказом, а
 * таймаутом под конкуренцией — поведенческий тест его не увидит, а увидит владелец, у
 * которого правка транзакции однажды повиснет. Прямая проверка предиката — единственный
 * дешёвый способ пиннить его формы.
 */
export function touchesBudgetContour(
  reg: RegistrySnapshot,
  op: { tool: string; input: unknown },
): boolean {
  if (op.tool.startsWith('attach_')) {
    const aspectId = resolveAttachAspect(reg, op.tool);
    if (
      aspectId !== undefined &&
      (BUDGET_CONTOUR_ASPECTS as readonly string[]).includes(aspectId)
    ) {
      return true;
    }
  }
  if (op.tool === 'batch_execute') {
    const env = op.input as { operations?: Array<{ tool: string; input: unknown }> } | null;
    return (env?.operations ?? []).some((inner) => touchesBudgetContour(reg, inner));
  }
  const input = op.input as {
    aspects?: unknown;
    props?: unknown;
    unset?: unknown;
    archived?: unknown;
  } | null;
  if (input === null || typeof input !== 'object') return false;
  if (op.tool === 'entity_update' && input.archived !== undefined) return true;

  const contourProps = budgetContourProperties(reg);
  const touchesProperty = (keyOrId: string): boolean => {
    const def = resolvePropertyRef(reg, keyOrId);
    return contourProps.has(def?.id ?? keyOrId);
  };
  if (typeof input.props === 'object' && input.props !== null) {
    if (Object.keys(input.props).some(touchesProperty)) return true;
  }
  if (
    Array.isArray(input.unset) &&
    input.unset.some((k) => typeof k === 'string' && touchesProperty(k))
  ) {
    return true;
  }

  const aspects = input.aspects;
  if (aspects === null || aspects === undefined || typeof aspects !== 'object') return false;
  // Три формы `aspects`, и все три обязаны быть видны: список навешиваемых (create новой
  // формы), `{attach, detach}` (update новой формы) и старая карта.
  const named = Array.isArray(aspects)
    ? aspects.filter((a): a is string => typeof a === 'string')
    : isAspectsPatchInput(aspects)
      ? [...(aspects.attach ?? []), ...(aspects.detach ?? [])]
      : Object.keys(aspects);
  return named.some((a) => (BUDGET_CONTOUR_ASPECTS as readonly string[]).includes(a));
}

/** Новая форма `aspects` во ВХОДЕ: у неё нет ключей, кроме attach/detach (см. fromLegacyInput). */
function isAspectsPatchInput(value: object): value is { attach?: string[]; detach?: string[] } {
  return Object.keys(value).every((k) => k === 'attach' || k === 'detach');
}

/**
 * Замок бюджет-контура владельца ПЕРВЫМ statement'ом транзакции исполнителя (E9 + фикс-раунд).
 *
 * Порядок захвата обязан быть глобальным «advisory → строки». Раньше замок брался внутри
 * applyBudgetFollowUps, то есть уже ПОСЛЕ `SELECT … FOR UPDATE` строки правимой сущности,
 * а встречный путь (создание/правка конверта) берёт тот же замок в `assertEnvelopeUnique`
 * на стадии prepare — ДО своих строковых блокировок. Два порядка на один замок — цикл
 * ожидания: PostgreSQL разорвал бы его отказом одной транзакции по дедлоку. Здесь замок
 * берётся до стадий, поэтому обе стороны выстраиваются в одну очередь.
 *
 * Реентерабельность делает повторный захват в `assertEnvelopeUnique` бесплатным — снимать
 * его там не нужно (и нельзя: конверты пишутся и путями, которые сюда не заходят).
 */
/**
 * Трогает ли вызов реестр владельца — тот же приём, что у бюджет-контура: вложенный batch
 * разворачивается, потому что замок берётся ДО стадий и про его содержимое знает только
 * форма входа.
 *
 * Обратные операции (`property_row_restore`, `property_merge_undo`) в наборе ОБЯЗАНЫ быть:
 * откат пишет в те же таблицы, и без замка он встал бы в очередь позже конкурента, который
 * уже держит бюджетный, — то есть ровно тот цикл, ради которого порядок и заведён.
 */
function touchesRegistry(op: { tool: string; input: unknown }): boolean {
  if (REGISTRY_OPS.has(op.tool)) return true;
  if (op.tool !== 'batch_execute') return false;
  const env = op.input as { operations?: Array<{ tool: string; input: unknown }> } | null;
  return (env?.operations ?? []).some((inner) => touchesRegistry(inner));
}

async function lockRegistry(
  tx: Tx,
  ownerId: string,
  ops: ReadonlyArray<{ tool: string; input: unknown }>,
): Promise<void> {
  if (ops.some(touchesRegistry)) await lockOwnerRegistry(tx, ownerId);
}

async function lockBudgetContour(
  tx: Tx,
  reg: RegistrySnapshot,
  ownerId: string,
  ops: ReadonlyArray<{ tool: string; input: unknown }>,
): Promise<void> {
  if (ops.some((op) => touchesBudgetContour(reg, op))) await lockOwnerBudget(tx, ownerId);
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
  if (tool === 'entity_origin_create') return prepareOriginCreate(ctx, input);
  if (tool === 'entity_origin_delete') return prepareOriginDelete(ctx, input);
  if (tool === 'entity_version_pin') return prepareVersionPin(ctx, input, batch);
  if (tool === 'entity_version_delete') return prepareVersionDelete(ctx, input);
  if (tool === 'property_create') return preparePropertyCreate(ctx, input);
  if (tool === 'property_update') return preparePropertyUpdate(ctx, input);
  if (tool === 'property_merge') return preparePropertyMerge(ctx, input);
  if (tool === 'aspect_delta_set') return prepareAspectDeltaSet(ctx, input);
  if (tool === 'aspect_delta_remove') return prepareAspectDeltaRemove(ctx, input);
  if (tool === 'property_row_restore') return preparePropertyRowRestore(ctx, input);
  if (tool === 'property_merge_undo') return preparePropertyMergeUndo(ctx, input);
  if (tool.startsWith('attach_')) {
    const aspectId = resolveAttachAspect(ctx.registry, tool);
    if (aspectId) return prepareAttach(ctx, tool, aspectId, input, batch);
  }
  // Стадия 1: неизвестный (или немутирующий) тул → VALIDATION
  throw new ExecError('VALIDATION', `неизвестный тул «${tool}»`, { tool });
}

/**
 * attach_<аспект>-тулы генерируются из реестра (§7.6): `orbis/task` → `attach_orbis_task`.
 * Имя собирается из КЛЮЧА аспекта, а не из его id: у встроенных они совпадают, а у своего
 * аспекта владельца ключ — то, что он назвал, и именно его видит модель в списке тулов.
 *
 * Нормализация — ОБЩАЯ `attachToolName` (§А9-1, Задача 12). До неё их было две: реестр
 * заменял «/» и «-» на «_», исполнитель — только «/», и на каждом аспекте с дефисом в ключе
 * модель звала одно имя, а исполнитель ждал другое; держал их вместе переводчик в диспатче.
 * Одна функция снимает и переводчика, и повод им разойтись.
 */
function resolveAttachAspect(reg: RegistrySnapshot, tool: string): string | undefined {
  for (const aspect of reg.aspects.values()) {
    if (tool === attachToolName(aspect.key)) return aspect.id;
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
    mechanism: ctx.mechanism,
    // Только если заданы: пустых ключей в журнале не заводим (см. ActionRecord)
    ...(ctx.req.actorGrantId !== undefined && { actor_grant_id: ctx.req.actorGrantId }),
    ...(ctx.req.runId !== undefined && { run_id: ctx.req.runId }),
    ...(ctx.req.editedFrom !== undefined && { edited_from: ctx.req.editedFrom }),
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

/** Inverse планов в порядке отката: обратный порядок исполнения, внутри плана — тоже (§7.8). */
function aggregateInverse(plans: readonly PreparedOp[]): ActionOperation[] {
  return [...plans].reverse().flatMap((p) => [...p.journal.inverse].reverse());
}

/**
 * Пересчёт вычисляемых предков (§А8, правило `nearest_ancestor`) — ПОСЛЕ применения всех
 * операций и ТЕМ ЖЕ tx: значения обязаны быть согласованы с графом на момент коммита, а не
 * «когда-нибудь потом» фоновой задачей.
 *
 * Зовётся и во внутреннем режиме undo, в отличие от бюджет-хука: откат правки ребра
 * восстанавливает рёбра, и предки обязаны сойтись с восстановленным графом. Именно поэтому
 * у пересчёта НЕТ inverse (см. ниже): «отменить пересчёт» — это пересчитать заново.
 *
 * Возвращает строки журнала: одну, если что-то действительно пересчиталось, и ни одной
 * иначе. Пустая строка «пересчитано 0» была бы шумом в каждом действии владельца.
 */
async function applyAncestorRecompute(
  ctx: ExecCtx,
  plans: readonly PreparedOp[],
): Promise<ActionOperation[]> {
  const roots = plans.flatMap((p) => p.ancestorRoots ?? []);
  if (roots.length === 0) return [];
  const { recomputed } = await recomputeProjectAncestors(
    ctx.tx,
    ctx.req.actorUserId,
    roots,
    ctx.registry,
  );
  if (recomputed === 0) return [];
  // Половина «operations» у этой строки есть, половины «inverse» — нет, и это ЗАКОННОЕ
  // исключение из §7.8, а не пропуск: откат восстанавливает рёбра, а по ним пересчёт
  // повторяется сам (см. вызов из ветки internalUndo). Обратная операция «вернуть прежние
  // значения кэша» была бы вторым источником правды о том, что и так выводится из графа.
  return [{ op: 'props_recomputed', payload: { rule: RULE_NEAREST_ANCESTOR, recomputed } }];
}

/**
 * Ссылочная половина записи свойств (§А6) в форме плана. Считается на стадии 4 вместе с
 * остальными проверками, а исполняется после стадии 5 — см. `applyRefEffects`.
 */
function refWriteOf(
  ctx: ExecCtx,
  entityId: string,
  before: EntityState,
  after: EntityState,
  patch: PropsPatch,
): { refWrite?: PreparedOp['refWrite'] } {
  const touchedIds = touchedProperties(patch);
  const touched = [...touchedIds].filter((propertyId) => {
    const kind = ctx.registry.properties.get(propertyId)?.type.kind;
    return kind === 'ref' || kind === 'registry_ref';
  });
  const mirror = changedRefProps(ctx.registry, before.props, after.props, touchedIds);
  if (touched.length === 0 && mirror.length === 0) return {};
  return { refWrite: { entityId, props: after.props, touched, mirror } };
}

/**
 * Следствия ссылочных свойств (§А6) — ПОСЛЕ применения всех операций и ТЕМ ЖЕ tx: цели
 * ссылок проверяются против объявленных множеств, зеркала рёбер приводятся к записанным
 * значениям, источники ссылок на только что заархивированную цель получают `needs-review`.
 *
 * ПОЧЕМУ ПРОВЕРКА ЦЕЛЕЙ СТОИТ ЗДЕСЬ, А НЕ НА СТАДИИ 4 «до первой записи». Множество цели
 * вычисляет компилятор запросов ПО БАЗЕ (§А6-1), а виртуального состояния batch он не видит
 * и видеть не может: чтобы увидеть, ему пришлось бы уметь исполнять Q-AST в памяти — вторая
 * реализация языка запросов, ровно та, которую реформа убирает. Стой проверка на стадии 4,
 * законный batch «заведи категорию, положи в неё трату» получал бы «цель не найдена»: на
 * момент его стадий строки категории в базе ещё нет. После стадии 5 состояние в транзакции
 * ИТОГОВОЕ, и вопрос задаётся ровно тому, кто на него отвечает. Атомарности это не стоит
 * ничего: отказ бросается тем же ExecError из той же tx — она откатывается целиком.
 *
 * Внутренний режим undo проверку ПРОПУСКАЕТ (как и стадия 4 у остальных инвариантов): он
 * восстанавливает своё же законно записанное состояние, а цель могли заархивировать уже
 * после — отказ означал бы, что законную запись нельзя отменить. Зеркала при этом сводятся:
 * откат вернул ЗНАЧЕНИЕ, а своего inverse у ребра нет вовсе (см. шапку `registry/ref.ts`).
 *
 * В журнал уезжает ОДНА строка и только про пометку: зеркало производно от свойства, которое
 * в журнале уже есть, и вторая запись о том же факте была бы шумом, а тег `needs-review`
 * ложится на ЧУЖИЕ сущности, и без этой строки владелец не узнал бы, откуда он взялся. Строка
 * несёт СПИСОК помеченных id — по нему откат снимает пометку (Р-11-1): у обычной операции это
 * сделал бы inverse, но inverse исполняется тулами, а «снять тег у списка сущностей» тулом не
 * выражается, и живёт откат пометки в `undo.ts` (единственный его шов внутри той же tx).
 */
async function applyRefEffects(
  ctx: ExecCtx,
  plans: readonly PreparedOp[],
): Promise<ActionOperation[]> {
  if (ctx.internalUndo === undefined) {
    for (const plan of plans) {
      if (plan.refWrite === undefined || plan.refWrite.touched.length === 0) continue;
      await assertReferenceProps(
        ctx.tx,
        ctx.registry,
        () => compileCtxOf(ctx),
        plan.refWrite.props,
        plan.refWrite.touched,
      );
    }
  }
  for (const plan of plans) {
    if (plan.refWrite === undefined || plan.refWrite.mirror.length === 0) continue;
    await syncRefMirror(
      ctx.tx,
      ctx.req.actorUserId,
      plan.refWrite.entityId,
      plan.refWrite.mirror,
      ctx.registry,
    );
  }
  const ops: ActionOperation[] = [];
  for (const plan of plans) {
    if (plan.archivedRefTarget === undefined) continue;
    const sources = await markRefSourcesNeedsReview(
      ctx.tx,
      ctx.req.actorUserId,
      plan.archivedRefTarget,
    );
    if (sources.length > 0) {
      // `sources` — ИМЕННО id, а не счётчик: по ним откат снимает пометку (Р-11-1,
      // `undo.ts`). Числа рядом нет намеренно — оно выводится из длины, а второй его
      // экземпляр в той же строке журнала был бы вторым мнением о том же факте.
      ops.push({ op: 'ref_sources_marked', payload: { target: plan.archivedRefTarget, sources } });
    }
  }
  return ops;
}

/** Данные аспект-ключа изменились операцией (стабильно для одинаковых объектов). */
function hookAspectChanged(hook: BudgetHook, aspectId: string): boolean {
  const before = (hook.before?.aspectsLegacy as AspectsMap | undefined)?.[aspectId];
  const after = (hook.after.aspectsLegacy as AspectsMap)[aspectId];
  return JSON.stringify(before) !== JSON.stringify(after);
}

/**
 * Какие ветки бюджет-хука сработают (§2.3). Отдельно от расчёта операций: те же
 * условия нужны прогреву кэша чтений ДО первого хука (иначе набор целей неизвестен).
 * (а) итоговая сущность несёт orbis/financial и financial-данные/архивность/шаблонность
 *     (orbis/schedule) изменились → bindingOps (шаблон recurring отвязывается);
 * (б) операция затронула orbis/budget (create/update периода-категории/архивация/detach)
 *     → rebindForEnvelope по окну «старый ИЛИ новый период»;
 * (в) сущность ПЕРЕСТАЛА нести orbis/financial (detach) → unbindOps снимает привязку.
 */
function budgetHookBranches(hook: BudgetHook): {
  rebind: boolean;
  bind: boolean;
  unbind: boolean;
} {
  const { before, after } = hook;
  const beforeAspects = before?.aspectsLegacy as AspectsMap | undefined;
  const afterAspects = after.aspectsLegacy as AspectsMap;
  const archivedChanged = before !== null && before.archived !== after.archived;
  return {
    // (в) сущность ПЕРЕСТАЛА быть транзакцией: detach orbis/financial. Ветка (а) сюда не
    // достаёт (она требует financial в ИТОГОВЫХ аспектах), и bindingOps на такой сущности
    // возвращает [] — снять устаревшую привязку было некому, и конверт оставался
    // родителем не-financial сущности. Зеркальный кейс «стал шаблоном recurring»
    // закрывает ветка (а) через bindingTargetOf → fin:null.
    unbind:
      beforeAspects?.['orbis/financial'] !== undefined &&
      afterAspects['orbis/financial'] === undefined,
    rebind:
      (beforeAspects?.['orbis/budget'] !== undefined ||
        afterAspects['orbis/budget'] !== undefined) &&
      (before === null || archivedChanged || hookAspectChanged(hook, 'orbis/budget')),
    // orbis/schedule в условии — сценарий «пометить повторяющейся» (§3.1): attach/detach
    // recurrence меняет шаблонность при неизменном financial, привязку надо пересчитать
    // (шаблон отвязывается, экс-шаблон привязывается заново)
    bind:
      afterAspects['orbis/financial'] !== undefined &&
      (before === null ||
        archivedChanged ||
        hookAspectChanged(hook, 'orbis/financial') ||
        hookAspectChanged(hook, 'orbis/schedule')),
  };
}

/**
 * Бюджет-хук A4 (03-budget §2.3): операции привязки/ребиндинга для одной применённой
 * операции. Вызывается ПОСЛЕ apply породившей операции (тем же tx): SQL селектора и
 * окна ребиндинга видят фактическое состояние, включая эффекты предыдущих операций
 * batch, — результат зависит только от текущего набора конвертов (§7.3), без
 * дублирования tie-break в JS. reads — общий кэш чтений исполнения (см. BindingReads).
 */
async function budgetFollowUpDescs(
  ctx: ExecCtx,
  hook: BudgetHook,
  reads: BindingReads,
  /** Уже посчитанные ветки хука (applyBudgetFollowUps считает их один раз на хук). */
  precomputed?: ReturnType<typeof budgetHookBranches>,
): Promise<BudgetOpDesc[]> {
  const { before, after } = hook;
  const ownerId = ctx.req.actorUserId;
  const branches = precomputed ?? budgetHookBranches(hook);
  const descs: BudgetOpDesc[] = [];

  // (б) конверт: до или после операции сущность несёт orbis/budget
  if (branches.rebind) {
    descs.push(
      ...(await rebindForEnvelope(ctx.tx, {
        ownerId,
        envelope: toWire(after),
        before: before === null ? null : toWire(before),
        reads,
      })),
    );
  }

  // (а) транзакция: bindingOps сам отсекает шаблоны recurring и архивные сущности
  if (branches.bind) {
    descs.push(...(await bindingOps(ctx.tx, { ownerId, entity: toWire(after), reads })));
  }

  // (в) сущность перестала быть транзакцией: снимаем привязку к конверту
  if (branches.unbind) {
    descs.push(...(await unbindOps(ctx.tx, { ownerId, entityId: after.id, reads })));
  }

  // Дедуп в рамках хука: сущность с обоими аспектами могла бы породить одинаковые ops
  const seen = new Set<string>();
  return descs.filter((d) => {
    const key = JSON.stringify([d.tool, d.input]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Применение бюджет-хуков: последовательно prepare → apply каждой дописанной операции
 * (БД к моменту prepare следующей уже актуальна — инвариант «один budget-parent»
 * видит удаление старой связи до создания новой). Хуки обрабатываются в порядке
 * операций: повторный хук видит эффект предыдущего и сходится к пустому diff.
 * Дописанные планы возвращаются вызывающему для журнала — операции входят в тот же
 * action, Undo откатывает целиком (§2.3). НЕ вызывается в internalUndo-режиме (§7.8:
 * undo воспроизводит зафиксированные inverse-операции, ничего не довычисляя).
 *
 * Чтения привязки прогреваются на ВЕСЬ набор хуков одним запросом на конверты и одним
 * на родителей (Task C2a): batch импорта — это сотни хуков, каждый из которых иначе
 * стоил бы трёх последовательных SQL. Порядок чтений при этом сохраняется: применённая
 * связь инвалидирует кэш родителей своей транзакции, и следующий хук перечитывает их.
 */
async function applyBudgetFollowUps(ctx: ExecCtx, hooks: BudgetHook[]): Promise<PreparedOp[]> {
  const ownerId = ctx.req.actorUserId;
  const reads = new BindingReads();
  // Замок владельца (E9) здесь НЕ берётся: он уже взят первым statement'ом транзакции
  // (lockBudgetContour) — иначе получился бы второй, обратный порядок захвата
  // относительно строковых блокировок и цикл ожидания с путём конверта.
  //
  // Ветки считаются ОДИН раз на хук: внутри budgetHookBranches живёт JSON.stringify по
  // значениям аспектов, а на импорте в 300 строк хуков ровно столько же.
  const branches = hooks.map(budgetHookBranches);
  const targets: BindingTarget[] = [];
  for (const [i, hook] of hooks.entries()) {
    if (!branches[i]?.bind) continue;
    // Окно ребиндинга (ветка «б») прогревается внутри rebindForEnvelope — его строки
    // известны только после запроса затронутых транзакций
    const target = bindingTargetOf(toWire(hook.after));
    if (target !== null) targets.push(target);
  }
  if (targets.length > 0) await reads.prefetch(ctx.tx, { ownerId, targets });

  // Механизм операций хука ПРОСТАВЛЯЕТСЯ ЯВНО (§А4-4). Хук не зовёт `execute` — он строит
  // операции через `prepareOp` в ТОМ ЖЕ ctx и без этой строки унаследовал бы механизм
  // вызывающего (для правки владельца в UI — `user`). Гейт `created_by: 'system'` роли
  // `envelope-binding` тогда отказал бы системе в её собственной привязке: владелец правил
  // бы категорию транзакции и получал ROLE_SYSTEM_ONLY на операции, которой не просил.
  const hookCtx: ExecCtx = { ...ctx, mechanism: 'hook' };
  const applied: PreparedOp[] = [];
  for (const [i, hook] of hooks.entries()) {
    for (const desc of await budgetFollowUpDescs(ctx, hook, reads, branches[i])) {
      const plan = await prepareOp(hookCtx, desc.tool, desc.input);
      await plan.apply(hookCtx);
      reads.invalidateParents(desc.input.target_id);
      applied.push(plan);
    }
  }
  return applied;
}

/**
 * Сохранить исходное тело, если строка ПРЯМО СЕЙЧАС впервые получает документ.
 *
 * Страховку обратимости кладёт не только разовый бэкфилл: путь записи переводит строку в
 * структурную форму при первой же правке (ленивая конверсия при чтении в базу не пишет, а
 * сохранение — пишет). Без этого кран «сконвертировано без страховки обратимости» на ЖИВОЙ
 * системе стал бы вечно красным: бэкфилл такие строки уже не выберет (`body_doc IS NOT NULL`),
 * а кран их видит — то есть шаг регламента «дождаться нуля» не наступил бы никогда
 * (ре-ревью раунда 7, Д2). Кран, всегда красный на живой системе, читать перестают — ровно тот
 * провал, который разобран в отчёте §11.6.
 *
 * Условие узкое: пишем ТОЛЬКО при переходе «документа не было → документ появился». У строки,
 * которая документ уже имеет, сохранять нечего — исходное тело либо уже лежит в колонке, либо
 * его никогда и не было (запись родилась с документом).
 */
function preserveBodyBeforeDoc(patch: EntityPatch, current: EntityRow): void {
  if (current.bodyDoc === null && current.bodyBeforeDoc === null) {
    patch.bodyBeforeDoc = current.body;
  }
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
 * Значение CORE-свойства (§А1-3) из строки: хранение у него — колонка, а адрес — обычный id
 * свойства. Отдельная функция, а не ветка внутри сверки, потому что тот же перевод
 * «свойство ядра → колонка» понадобится компилятору запросов (§А5-1) — второй его копии
 * быть не должно.
 *
 * Отметки времени отдаются ISO-СТРОКАМИ: в предусловии значение приезжает из JSON, где
 * `Date` не существует, и сравнивать объект со строкой было бы сравнением разных вещей.
 * Незнакомый core-id — `undefined`: он невозможен (список закрыт `CORE_PROPERTY_IDS`), но
 * молчаливое совпадение здесь стоило бы дороже лишней ветки.
 */
function corePropertyValue(propertyId: string, row: EntityRow): unknown {
  if (propertyId === 'orbis/archived') return row.archived;
  if (propertyId === 'orbis/title') return row.title;
  if (propertyId === 'orbis/created_at') return row.createdAt.toISOString();
  if (propertyId === 'orbis/updated_at') return row.updatedAt.toISOString();
  return undefined;
}

/**
 * CAS-предусловие (§А7-3) против состояния строки, ПРОЧИТАННОЙ ПОД ЗАМКОМ. Вызывается только
 * из prepareEntityUpdate сразу после loadEntityForUpdate — своего чтения не делает намеренно:
 * второй SELECT снял бы весь смысл, сверяя значение вне транзакционного замка. По той же
 * причине core-колонки приходят параметром `row` — из ТОЙ ЖЕ прочитанной строки; в batch это
 * виртуальная строка, где видны эффекты предыдущих операций пачки.
 *
 * Адрес пункта — id свойства, и источник значения выбирается по РЕЕСТРУ, а не по имени:
 * `storage: 'core'` — колонка строки (§А1-3), всё остальное — `props`. Псевдо-аспекта
 * `orbis/entity`, под которым колонка адресовалась раньше, больше нет: он был вторым,
 * несовместимым способом сказать «это не поле аспекта», и жил ровно потому, что у пары
 * «аспект + поле» для колонки не было имени.
 *
 * Свойство, которого в реестре НЕТ, — `VALIDATION`, а не расхождение. Это рулинг, а не
 * вкус: над `CONFLICT` стоит retry-лестница глаголов, и опечатка в id, выглядящая как
 * проигранная гонка, заставляла бы её перезапускать заведомо невыполнимое предусловие.
 *
 * Форма `in`: сравнение — `comparePropertyValue` по типу свойства (деньги численно, json
 * каноном, список поэлементно). Отсутствующее значение не совпадает ни с чем — захват
 * несуществующего тикета невозможен. Это обещание БЕЗУСЛОВНО: `actual === undefined`
 * отсекается отдельно, до сравнения, потому что иначе `in: [undefined]` (одна опечатка в
 * предусловии) совпадал бы с отсутствием значения, то есть разрешал правку ровно там, где
 * предусловие и поставлено её запретить. Форма `absent` (V1.7) — зеркало того же: выполнена
 * РОВНО когда значения нет. `default` типа её не отменяет (РП-9): он не материализуется на
 * записи, и «поля ещё нет» обязано отличаться от «поле есть и равно умолчанию».
 *
 * Проверяются ВСЕ пункты, даже когда первый уже провалился: бросок один, но список
 * расхождений полный (`details.mismatches`). Выход на первом же несовпадении экономил бы
 * несколько сравнений по уже прочитанной строке и стоил бы владельцу разбора по одному
 * пункту за попытку — предложение рутины применяется «всё или ничего».
 */
function assertPrecondition(
  reg: RegistrySnapshot,
  precondition: EntityUpdatePrecondition,
  state: EntityState,
  row: EntityRow,
): void {
  const mismatches: PreconditionMismatch[] = [];
  /** Первый провалившийся ПУНКТ в исходной форме (не расхождение) — его читает verbs.ts. */
  let failed: { item: EntityUpdatePreconditionItem; actual: unknown } | undefined;

  for (const p of precondition) {
    const def = resolvePropertyRef(reg, p.property);
    if (def === undefined) {
      throw new ExecError(
        'VALIDATION',
        `предусловие ссылается на неизвестное свойство «${p.property}» (§А7-3)`,
        { property: p.property, reason: 'unknown_property' },
      );
    }
    // Источник значения — по РЕЕСТРУ: у core-проекции это колонка строки (§А1-3), у всех
    // остальных — новая правда значений `props`.
    const actual = def.storage === 'core' ? corePropertyValue(def.id, row) : state.props[def.id];
    const satisfied =
      'absent' in p
        ? actual === undefined
        : actual !== undefined && p.in.some((v) => comparePropertyValue(def.type, v, actual));
    if (satisfied) continue;
    failed ??= { item: p, actual };
    mismatches.push({
      property: p.property,
      expected: 'absent' in p ? 'absent' : p.in,
      actual,
    });
  }

  if (failed === undefined) return;
  const rest = mismatches.length - 1;
  throw new ExecError(
    'CONFLICT',
    // Хвост «(и ещё N)» — чтобы текст не врал, будто расхождение одно: полный разбор
    // читатель возьмёт из details.mismatches, но по сообщению обязан понять его размер.
    `предусловие не выполнено: ${failed.item.property}${rest > 0 ? ` (и ещё ${rest})` : ''}`,
    {
      // Второй смысл CONFLICT помимо занятого client-UUID — различает их именно reason
      // (см. докблок errors.ts): потребители кодов не должны гадать по тексту сообщения.
      reason: 'precondition_failed',
      // ПЕРВЫЙ провалившийся пункт, а не весь массив: CAS-шаг по счётчику читает
      // details.precondition.property (verbs.ts), чтобы решить, повторять ли попытку, и
      // менять эту форму ради нового свойства значило бы ломать глаголы на ровном месте.
      precondition: failed.item,
      actual: failed.actual,
      // Полный список — для владельца (V1.7): по нему карточка предложения показывает,
      // что именно разошлось, вместо «поправь первое и попробуй ещё раз».
      mismatches,
    },
  );
}

/**
 * Financial-инвариант §3.3 с derived_from-веткой: наличие входящей derived_from
 * резолвится только когда от него зависит валидность (recurring=true без recurrence) —
 * из связей, объявленных тем же batch, либо из БД (минус удаляемые batch'ем).
 */
async function assertFinancial(
  ctx: ExecCtx,
  entityId: string,
  state: EntityState,
  batch?: BatchState,
): Promise<void> {
  let hasDerivedFrom = false;
  if (financialRecurringNeedsDerivedFrom(state)) {
    hasDerivedFrom = await hasIncomingDerivedFrom(ctx, entityId, batch);
  }
  assertFinancialInvariant(state, hasDerivedFrom);
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
    .where(and(eq(relations.targetId, entityId), eq(relations.role, ROLE_INSTANCE_OF)));
  const deleted = batch?.deletedRelations ?? [];
  return rows.some(
    (r) =>
      !deleted.some(
        (d) => d.sourceId === r.sourceId && d.targetId === entityId && d.role === ROLE_INSTANCE_OF,
      ),
  );
}

/**
 * Монотонный updated_at (§5.2): clock() с ms-точностью не различает два апдейта в один
 * тик — optimistic-check body пропускал бы stale-правку. Токен конкурентности всегда
 * строго растёт: max(clock(), prev + 1ms). Доменные таймстампы (completed_at и т.п.)
 * остаются на чистом clock().
 */
function monotonicUpdatedAt(now: Date, prev: Date): Date {
  return now.getTime() > prev.getTime() ? now : new Date(prev.getTime() + 1);
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
  // Стадия 1: exec-надмножество — старая карта аспектов ЛИБО новая форма (§А1-1, РП-3)
  const input = parseEnvelope(entityCreateExecInput, rawInput, 'entity_create');
  const now = ctx.clock();
  const id = input.id ?? newId();

  // Нормализации (§2.1, §4.1): tags lowercase+dedupe, обе формы тела, серверные таймстампы.
  // body — КАНОН (сериализация собранного документа), а не строка входа: правда о теле одна,
  // и это документ; «как написала модель» эталоном быть не может (вердикт Б1).
  const tags = normalizeTags(input.tags);
  // Ссылки — из дерева ∪ raw-блоков (Б2): `[[entity:…]]` в блоке кода связью не считается (Р7),
  // но тело, не разобранное целиком и уехавшее в rawBlock, backlinks не теряет.
  let { body, bodyDoc, bodyRefs, queryRefs } = bodyFieldsFromMarkdown(
    input.body ?? '',
    ctx.registry,
  );

  // Слияние (§А7-1): у create «состояние до» — пустое, поэтому весь вход и есть патч.
  const before: EntityState = { props: {}, aspects: [] };
  const propsPatch = fromLegacyInput(ctx.registry, input);
  const state = applyPropsPatch(before, propsPatch);
  // §3.2: create сразу в done без completed_at → проставить clock() (до стадии 2,
  // чтобы валидировалось финальное сохраняемое значение)
  if (touchedProperties(propsPatch).has(TASK_STATUS) && state.aspects.includes('orbis/task')) {
    applyTaskCompletion(before, state, now);
  }
  // Нормализация валюты конверта (бэклог A7): NULL→defaultCurrency ДО валидации,
  // проверки уникальности §2.1 и записи — комбинация всегда каноничная
  await normalizeEnvelopeProps(ctx, before, state, propsPatch);

  // Запрет по объекту для источника routine (V1.10) — ПЕРВЫМ из отказов: он про то, кому
  // вообще нельзя трогать этот объект, и не зависит ни от формы значения, ни от флагов
  // свойств. Стой он позже, рутина, подделывающая ответ владельца, получала бы
  // `COMPUTED_WRITE` («это свойство пишет сервер») вместо честного «рутина не меняет
  // прогоны» — два разных ответа на один запрет.
  assertRoutineUntouchable(ctx.req.source, {
    next: state.aspects,
    touched: touchedAspects(ctx.registry, before, state, propsPatch),
  });
  // Гейт флагов (§А2-5/Б6) — ДО валидации значений: «вам сюда нельзя» честнее, чем
  // «ваше значение не той формы», когда запись запрещена независимо от значения.
  assertPropsWritable(ctx.registry, ctx.mechanism, propsPatch);
  // Стадия 2: реестр свойств (§А7-1) — по итоговому состоянию, а не по патчу
  assertEntityProps(ctx.registry, state);
  // Ссылочная половина записи (§А6): проверка целей и зеркала — после стадии 5.
  const refWrite = refWriteOf(ctx, id, before, state, propsPatch);

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
  await assertFinancial(ctx, id, state, batch);
  // Живой грант в назначении (С4/С7): у create «затронуто» всё, что пришло во входе
  await assertAssignment(ctx.tx, ctx.req.actorUserId, state);
  // Ровно один субъект у прогона (V1.4) — тем же путём, что и назначение
  assertRunSubject(state);
  // Заготовка тела проекта (С10). Засев живёт в executor'е, а не в роутере/адаптере: тогда
  // проект, заведённый чатом, MCP и UI, получает одно и то же тело. У create «тело до
  // операции» — это канон входа (пусто, если body не прислали ИЛИ прислали пустую строку:
  // что считать телом входа, решает hasBodyInInput — одно правило на все три пути).
  if (needsProjectSeed(undefined, state, body, hasBodyInInput(input))) {
    ({ body, bodyDoc, bodyRefs, queryRefs } = bodyFieldsFromMarkdown(
      projectBodyTemplate(id),
      ctx.registry,
    ));
  }
  // Дуальная запись (§А1-1, до Задачи 23): старая карта — ПРОЕКЦИЯ новой правды, а не
  // второй независимый перевод входа. Она же — вход доменных проверок бюджета, которые
  // переводятся своей задачей (7a).
  const aspectsLegacy = projectLegacyAspects(ctx.registry, state);
  // Уникальность конверта (03-budget §2.1): дубль точной комбинации отклоняется
  if (state.aspects.includes('orbis/budget')) {
    await assertEnvelopeUnique(ctx.tx, {
      ownerId: ctx.req.actorUserId,
      entityId: id,
      props: state.props,
      virtualEntities: batch?.entities,
    });
  }
  gateEntitlements(ctx, 'entity_create');

  const values = {
    id,
    ownerId: ctx.req.actorUserId,
    title: input.title,
    emoji: input.emoji ?? null,
    body,
    bodyDoc,
    // Запись рождается СРАЗУ с документом, поэтому «тела до конверсии» у неё нет — но колонка
    // обязана быть заполнена, иначе кран «сконвертировано без страховки обратимости» краснел бы
    // на КАЖДОЙ новой заметке и перестал бы читаться (ре-ревью раунда 7, Д2). Кладём то же
    // тело: инвариант «есть документ ⇒ есть страховка» становится проверяемым БЕЗ отсечки по
    // времени наката миграции, а колонка всё равно снимается после переноса.
    //
    // ЧЕСТНО ПРО ГРАНИЦУ: здесь ложится КАНОН (`bodyFieldsFromMarkdown` выше), а не то, что написал
    // автор. Для записей, созданных после выкатки, колонка ничего не восстанавливает — она
    // страхует ПЕРЕНОС корпуса, а не путь записи. В отчёте это сказано тем же словами
    // (ре-ревью раунда 8, п.4).
    bodyBeforeDoc: body,
    bodyRefs,
    // Кого адресуют query-блоки тела (§А11-1): обратный индекс, по которому слияние свойства
    // находит тела без обхода корпуса. Ставится РЯДОМ С `bodyRefs` во всех пяти точках записи
    // тела — иначе у проекта, заведённого через attach, индекс молча остался бы пустым.
    queryRefs,
    tags,
    // `meta` больше НЕ пишется (§А1-1): мешок был write-only во всех пяти зонах, свойства
    // заменили его адресуемым значением, а колонка доживает до миграции 0017 пустой. Вход
    // тула поле ещё принимает (контракт §9.2 не двигается до Задачи 12) — и молча роняет.
    meta: {},
    props: state.props,
    aspects: state.aspects,
    aspectsLegacy,
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
          // Единица журнала — СВОЙСТВО (§А7-4): нагрузка несёт плоские `props` по id и
          // список аспектов — ровно ту форму, которую принимает вход исполнителя
          // (`entityCreateExecInput`), потому что операция журнала обязана оставаться
          // исполнимой. `meta` ушла вместе с записью колонки (§А1-1).
          // Записано ВСЁ состояние, а не дельта: у создания «состояние до» пусто, и
          // дельта совпадает с ним по построению.
          props: state.props,
          aspects: state.aspects,
        },
      },
    ],
    // §7.8: создание → архивация (жёсткого удаления нет)
    inverse: [{ op: 'entity_update', payload: { id, archived: true } }],
  };

  const inBatch = batch !== undefined;
  return {
    journal,
    budgetHook: { before: null, after: values as EntityRow },
    ...refWrite,
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
  // Надмножество тул-контракта: тулы шлют узкую форму (bodyDoc и precondition в ней просто
  // отсутствуют и отвергаются ещё диспатчем), UI — форму с bodyDoc, серверные пути — ещё и
  // с CAS-предусловием. Расширять сам entityUpdateInput нельзя: он — контракт ТУЛА, и оба
  // поля в нём показались бы модели.
  const input = parseEnvelope(entityUpdateExecInput, rawInput, 'entity_update');

  // Стадия 3: load state ПОД ЗАМКОМ — merge аспектов это read-modify-write, без
  // FOR UPDATE конкурентные патчи разных полей одного аспекта теряли бы правки
  const current = await loadEntityForUpdate(ctx, input.id, batch);
  if (!current) {
    throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.id });
  }
  // Правда строки — `props`/`aspects[]` (§А1-1). Прежние значения для журнала берутся
  // отсюда же: единица отката — свойство (§А7-4), и старая карта в этом больше не участвует.
  const before = stateOf(current);

  // CAS-расширение стадий 4–5 (С7): предусловие сверяется по ТОЙ ЖЕ строке, что и весь
  // остальной update — прочитанной под FOR UPDATE (в batch — по виртуальной строке, где
  // видны эффекты предыдущих операций того же batch). Отдельный SELECT читал бы состояние
  // ВНЕ замка, и два конкурентных захвата тикета оба увидели бы `planned`.
  //
  // Проверка идёт ДО гейта тела и ДО merge: проигравший захват не должен ни писать, ни
  // получать STALE_VERSION вместо честного CONFLICT. Внутренний режим undo (§7.8)
  // предусловий не встречает — inverse их не несёт, поэтому отдельной ветки здесь нет.
  if (input.precondition) assertPrecondition(ctx.registry, input.precondition, before, current);

  // §5.2: правка body требует optimistic-check по updated_at; патчи без body — LWW.
  // Внутренний режим undo (§7.8) требование ПРОПУСКАЕТ: Undo восстанавливает
  // зафиксированное в журнале прежнее состояние поверх текущего — это осознанный
  // LWW-откат, а не пользовательская правка (inverse не несёт expectedUpdatedAt).
  //
  // ОБА поля тела под одним гейтом: сохранения редактора едут ТОЛЬКО bodyDoc, и пока условие
  // смотрело на один input.body, они проходили мимо — 409 не наступал никогда, а конкурентная
  // правка затиралась молча (ревью Б3).
  if ((input.body !== undefined || input.bodyDoc !== undefined) && ctx.internalUndo === undefined) {
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

  // Слияние свойств (§А7-1) + переходы §3.2; стадия 2 валидирует РЕЗУЛЬТАТ, не патч
  let state = before;
  let propsPatch: PropsPatch = {};
  let touched: string[] = [];
  if (hasPropsInput(input)) {
    // Одна форма разбора на все входы, включая внутренний режим undo (§7.8). Семантики
    // «заменить ключ целиком» здесь БОЛЬШЕ НЕТ: с §А7-4 inverse говорит свойствами и
    // называет снятие ЯВНО (`unset`), поэтому восстанавливать носитель нечего и незачем.
    // Замена носителя целиком живёт ровно у одного вызывающего — тула `attach_<аспект>`
    // (`replaceAspectProps`), где она и есть смысл операции.
    //
    // ЦЕНА, НАЗВАННАЯ ВСЛУХ: ДО-РЕФОРМЕННЫЕ ЗАПИСИ ЖУРНАЛА ОТКАТЫВАЮТСЯ НЕТОЧНО.
    // Записи, сделанные до перевода журнала на свойства, несут inverse старой картой
    // (`{aspects: {'orbis/task': {…}}}`). Прежде такая нагрузка разбиралась заменой ключа
    // ЦЕЛИКОМ, теперь — слиянием (`legacyPatchToProps`), и разница наблюдаема: действие,
    // дописавшее полю значение, оставит его после отката вместо того, чтобы снять, —
    // восстановленное состояние не совпадёт с зафиксированным, и молча. Точный откат
    // гарантирован только для записей, сделанных НАЧИНАЯ С ЭТОГО КОММИТА.
    //
    // Переходного чтения обеих форм здесь нет НАМЕРЕННО (рулинг координатора): второй адрес
    // в разборе нагрузки — та самая вторая копия знания, которую реформа убирает, и жила бы
    // она до конца среза без единого потребителя. Окно риска ровно одно — деплой БЕЗ
    // пересева мира; пересев (РП-7, Задача 23) сносит и граф, и журнал, и окно закрывает.
    // Требование «пересев ДО деплоя» занесено в чек-лист Задачи 23 и в реестр швов леджера.
    propsPatch = fromLegacyInput(ctx.registry, input);
    state = applyPropsPatch(before, propsPatch);
    touched = touchedAspects(ctx.registry, before, state, propsPatch);
  }

  // Запрет по объекту для источника routine (V1.10). Стоит ЗДЕСЬ по двум причинам сразу.
  // Первая (была и раньше): переименование, архивация и правка тела рутины аспектов не
  // трогают, но правкой рутины быть не перестают — запрет сформулирован по объекту, а не
  // по содержимому патча, поэтому он вне гейта «есть ли правка свойств». Вторая (реформа):
  // он обязан отвечать РАНЬШЕ гейта флагов — иначе рутина, подделывающая ответ владельца,
  // получала бы «это свойство пишет сервер» вместо «рутина не меняет прогоны».
  // Строка прочитана под FOR UPDATE выше, запись — ниже.
  assertRoutineUntouchable(ctx.req.source, {
    before: before.aspects,
    next: state.aspects,
    touched,
  });

  if (hasPropsInput(input)) {
    if (ctx.internalUndo === undefined) {
      if (touchedProperties(propsPatch).has(TASK_STATUS) && state.aspects.includes('orbis/task')) {
        applyTaskCompletion(before, state, now);
      }
      // Нормализация валюты конверта (бэклог A7): патч мог снять currency или добавить
      // orbis/budget без неё — NULL не пишем, подставляем defaultCurrency ДО валидации и
      // проверки уникальности §2.1. Внутренний undo восстанавливает состояние verbatim.
      //
      // НАЗВАННЫЙ ИНТЕРВАЛ (гейт-ревью 4b, рулинг координатора: код в срезе А не меняем).
      // Подстановка материализует умолчание в `orbis/currency`, а оно СЛИТО у транзакции и
      // конверта (В1). Отсюда угол, где undo перестаёт быть точным: у financial-записи без
      // валюты патч, добавляющий аспект конверта, кладёт умолчание владельца в общее
      // свойство, но `touched` содержит только `orbis/budget` — и inverse не несёт
      // financial-ключ. После отката валюта-умолчание остаётся, хотя до операции её не было.
      // До реформы поля были раздельными, и откат был точным.
      //
      // Владелец починки — Задача 6 (§А7-4, «единица отката — свойство»): она переписывает
      // inverse целиком и закрывает угол по построению; латать его здесь значило бы городить
      // временный расчёт затронутых ключей поверх формы, которая всё равно уходит.
      //
      // Трение с РП-9 («default не материализуется на записи») тоже названо вслух: здесь
      // материализация ПРЕДНАМЕРЕННА — валюта входит в ключ уникальности конверта (§2.1),
      // и NULL в нём сделал бы два конверта на одну комбинацию неразличимыми.
      if (touched.includes('orbis/budget')) {
        await normalizeEnvelopeProps(ctx, before, state, propsPatch);
      }
      // Гейт флагов (§А2-5/Б6). Внутренний undo его ПРОПУСКАЕТ — ровно как семь проверок
      // ниже: он восстанавливает СВОЁ ЖЕ законно записанное состояние, и отказ здесь
      // означал бы, что законную запись нельзя отменить.
      assertPropsWritable(ctx.registry, ctx.mechanism, propsPatch);
    }
    assertEntityProps(ctx.registry, state);
    // Стадия 4: инвариант §3.3 над финальным состоянием (ловит и detach orbis/schedule)
    await assertFinancial(ctx, input.id, state, batch);
    // Живой грант в назначении (С4/С7) — только когда назначение ЗАТРОНУТО патчем.
    // Проверять его на каждой правке нельзя: отзыв гранта иначе замораживал бы тикет
    // целиком (даже переименование), а отзыв закрывает доступ агенту, а не сущность.
    // Внутренний undo восстанавливает зафиксированное состояние — не проверяется.
    if (ctx.internalUndo === undefined && touched.includes('orbis/assignment')) {
      await assertAssignment(ctx.tx, ctx.req.actorUserId, state);
    }
    // Ровно один субъект у прогона (V1.4) — только когда патч ЗАТРОНУЛ прогон: слияние
    // дописывает свойства к уже навешенному аспекту, то есть второй субъект приезжает
    // именно этим путём. Внутренний undo восстанавливает зафиксированное — не проверяется.
    if (ctx.internalUndo === undefined && touched.includes('orbis/agent-run')) {
      assertRunSubject(state);
    }
    // «Один budget-parent» (§4.2/§13.7) и для патча свойств: аспект конверта может
    // появиться и так — второй путь ретроспективного второго конверта помимо attach
    // (fix round ревью A1.1). Detach второго budget-parent'а не создаёт.
    // Внутренний undo восстанавливает зафиксированное состояние — не проверяется.
    if (
      ctx.internalUndo === undefined &&
      touched.includes('orbis/budget') &&
      state.aspects.includes('orbis/budget')
    ) {
      await assertBudgetAttachKeepsSingleParent(ctx, input.id, batch);
    }
  }

  // Дуальная запись (§А1-1): старая карта — проекция новой правды. Считается ОДИН раз и
  // отсюда же уезжает в проверки бюджета (их перевод — Задача 7a) и в журнал.
  const nextLegacy = projectLegacyAspects(ctx.registry, state);

  // Уникальность конверта (03-budget §2.1) над ФИНАЛЬНЫМ состоянием: и правка
  // комбинации, и разархивация (archived=false возвращает конверт в множество
  // неархивных) не должны создавать дубль. Внутренний undo восстанавливает
  // зафиксированное состояние — не проверяется (как прочие инварианты выше).
  if (
    ctx.internalUndo === undefined &&
    state.aspects.includes('orbis/budget') &&
    (touched.includes('orbis/budget') || (input.archived === false && current.archived))
  ) {
    await assertEnvelopeUnique(ctx.tx, {
      ownerId: ctx.req.actorUserId,
      entityId: input.id,
      props: state.props,
      virtualEntities: batch?.entities,
    });
  }

  // Стадия 4: нормализации патча + гейт; changed — «как исполнено», prior — для inverse
  // updated_at проставляется сервером всегда и строго растёт (monotonicUpdatedAt, §5.2)
  const patch: EntityPatch = { updatedAt: monotonicUpdatedAt(now, current.updatedAt) };
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
  // Тело приходит в ОДНОЙ из двух форм (схема запрещает обе сразу), а в БД всегда ложатся ОБЕ:
  // body_doc — правда, body — её проекция и аварийный дубль. Это единственное место, где формы
  // переводятся друг в друга. body_refs — из ДЕРЕВА в обеих ветках (§2.1 при каждом update,
  // затрагивающем тело): иначе правка модели и правка из UI считали бы backlinks по разным
  // правилам, и `[[entity:…]]` в блоке кода то появлялся бы в графе, то исчезал.
  if (input.bodyDoc !== undefined) {
    // Версия сверяется НА ЗАПИСИ, и гейт УЖЕ ЧТЕНИЯ: с версии 2 `readBodyDoc` принимает
    // предыдущую версию и конвертирует её по дереву (`upgradeBodyDoc`), а сюда она не
    // проезжает. Асимметрия намеренная — конвертировать ВВЕРХ проверяемо, а принять на запись
    // документ, который пришлось бы конвертировать, значило бы сохранять форму, которую сама
    // приславшая вкладка уже не понимает; её место — перештамповка черновика на клиенте.
    // Принять здесь версию из будущего значило бы сохранить заведомо обречённое — и
    // это потеря СОДЕРЖИМОГО, а не оформления: незнакомые ноды выпадают уже из проекции
    // (проверено пробой — v=2 с новой нодой даёт body без её текста), а чтение потом
    // пересоберёт документ из этого урезанного body. Ровно то, ради чего версия и заведена.
    if (input.bodyDoc.v !== DOC_SCHEMA_VERSION) {
      throw new ExecError(
        'VALIDATION',
        'документ другой версии схемы: перезагрузите приложение и повторите правку',
        { id: input.id, expected: DOC_SCHEMA_VERSION, got: input.bodyDoc.v },
      );
    }
    // Структурная целость — вопросом К СХЕМЕ, а не по косвенному следу «проекция пуста».
    // На незнакомой НОДЕ serializeBody исключения не бросает: он молча отдаёт '', и запись
    // обнулила бы body вместе с body_refs, оставив в body_doc тот же мусор (readBodyDoc
    // пропускает его по версии) — обе формы терялись бы с 200 OK. (Оговорка честности: «не
    // бросает» верно НЕ для любого входа — на документе, непригодном по схеме, он падает
    // TypeError'ом из недр @tiptap/markdown, замерено на listItem с пустым content. Здесь это
    // безопасно ровно потому, что такой вход отсекает гейт ниже, до сериализации.) Но пустая
    // проекция — лишь
    // СЛЕД поломки, а не она сама: в '' законно сериализуются и пустой заголовок, и абзац с
    // одним hardBreak, и пробельный абзац, так что гейт по этому признаку отвергал бы штатные
    // состояния редактора (заметка из одного заголовка, у которого стёрли текст, не
    // сохранялась бы ВООБЩЕ). Спрашиваем прямо то, что хотим знать.
    const docError = bodyDocError(input.bodyDoc);
    if (docError !== undefined) {
      throw new ExecError('VALIDATION', 'документ не соответствует схеме — правка отклонена', {
        id: input.id,
        reason: docError,
      });
    }
    // Третья проверка, которой здесь не было (итоговое ревью, находка 3): что проекция НИЧЕГО
    // НЕ ТЕРЯЕТ — ни одного непробельного символа, ни одной ссылки. Версия и структура
    // сверялись, а то, ради чего вся конструкция затеяна, — нет, и ровно через этот шов
    // проходила порча вложенных оград и подписей со скобкой.
    //
    // Спрашивается ИМЕННО «ничего не пропало», а НЕ «проекция — неподвижная точка канона»:
    // второе было первой редакцией страховки и оказалось регрессом (ре-ревью, Б1). markdown не
    // умеет выражать пустой абзац, поэтому у любого документа с пустой строкой неподвижность
    // недостижима В ПРИНЦИПЕ, и страховка уводила живую заметку в один неправимый rawBlock на
    // каждом круге автосохранения. Замер трёх критериев — в докблоке bodyPairFromDoc, там же
    // и причина, по которой «канон устойчив» годится аудиту корпуса, но не этому месту.
    //
    // Логика живёт в @orbis/shared/doc рядом с самим сериализатором (там же её и проверяют без
    // базы): отказа не будет — терминальный VALIDATION остановил бы автосохранение, — текст
    // уезжает в БД байт в байт, а непрошедший документ подменяется rawBlock'ом, который
    // печатается дословно.
    //
    // В БД едет ВХОД, а не результат валидации: nodeFromJSON().toJSON() теряет незнакомые схеме
    // атрибуты, а блочные id живут именно так (UniqueID — расширение редактора, в
    // DOC_EXTENSIONS его нет). Проверено пробой.
    // Привязка ДО страховки проекции: `bodyPairFromDoc` печатает документ и сверяет, что
    // печать ничего не потеряла, — а `text` блока становится key-формой именно здесь. Сверь
    // раньше привязки, и сравнивалась бы печать документа, который в БД не поедет.
    const bound = bindQueryBlocks(input.bodyDoc, parseRegistryOfSnapshot(ctx.registry));
    const { doc: storedDoc, body } = bodyPairFromDoc(bound);
    patch.bodyDoc = storedDoc;
    patch.body = body;
    preserveBodyBeforeDoc(patch, current);
    // Ссылки — из ТОГО, ЧТО ЛЁГЛО. В штатной ветке это тот же вход; в ветке страховки — raw,
    // и связи из него достаёт регэксп (Б2: backlinks не зависят от разбираемости тела).
    patch.bodyRefs = bodyRefsFromDoc(storedDoc);
    patch.queryRefs = queryRefsFromDoc(storedDoc);
    changed.body = body;
    prior.body = current.body;
  } else if (
    ctx.internalUndo === undefined &&
    needsProjectSeed(before, state, current.body, hasBodyInInput(input))
  ) {
    // Заготовка тела проекта (С10). Ветка стоит ПЕРЕД строковой намеренно: `body: ''` — это
    // «тела не прислали» (hasBodyInInput), и строковая ветка записала бы пустоту, отменив
    // засев. Документ во входе разобран веткой выше — он телом считается всегда, даже пустой.
    // Гейт expectedUpdatedAt (§5.2) не срабатывает и срабатывать не должен: он смотрит на
    // ВХОД, а не на патч, и терять тут нечего — тело пусто.
    const seeded = bodyFieldsFromMarkdown(projectBodyTemplate(input.id), ctx.registry);
    patch.body = seeded.body;
    patch.bodyDoc = seeded.bodyDoc;
    preserveBodyBeforeDoc(patch, current);
    patch.bodyRefs = seeded.bodyRefs;
    patch.queryRefs = seeded.queryRefs;
    // Засев — часть эффекта операции, поэтому едет и в журнал: undo вернёт пустое тело
    // вместе с аспектом, а не оставит заготовку на сущности, которая проектом быть перестала.
    changed.body = seeded.body;
    prior.body = current.body;
  } else if (input.body !== undefined) {
    // КАНОН, а не input.body: body — производная документа, и сравнивать «как написала
    // модель» бессмысленно (вердикт Б1). FTS не страдает (проверено спайком), сиды каноничны.
    const { body, bodyDoc, bodyRefs, queryRefs } = bodyFieldsFromMarkdown(input.body, ctx.registry);
    patch.body = body;
    patch.bodyDoc = bodyDoc;
    preserveBodyBeforeDoc(patch, current);
    patch.bodyRefs = bodyRefs; // дерево ∪ raw — backlinks не теряются (Б2)
    patch.queryRefs = queryRefs;
    changed.body = body;
    prior.body = current.body;
  }
  if (input.tags !== undefined) {
    patch.tags = normalizeTags(input.tags);
    changed.tags = patch.tags;
    prior.tags = current.tags;
  }
  if (input.archived !== undefined) {
    patch.archived = input.archived;
    changed.archived = input.archived;
    prior.archived = current.archived;
  }
  if (hasPropsInput(input)) {
    patch.props = state.props;
    patch.aspects = state.aspects;
    patch.aspectsLegacy = nextLegacy;
  }
  // Единица журнала и отката — СВОЙСТВО (§А7-4). Обе половины записи — дельты состояний,
  // зеркальные друг другу, и отсюда обратимость «байт-в-байт» (§С7-13) по построению.
  //
  // Считается БЕЗУСЛОВНО, а не под `hasPropsInput`: дельта пуста ровно тогда, когда правки
  // свойств не было (тогда `state === before`), и лишнего ключа в нагрузке не появится. Зато
  // нормализация, тронувшая состояние мимо патча, попадёт в журнал при любом входе — а
  // именно так и рождался угол с умолчанием валюты, где inverse не нёс материализованного
  // значения и откат оставлял его в графе.
  //
  // Слитое свойство (В1) закрылось тем же движением: `orbis/finance_category` одно, и одна
  // запись в дельте возвращает обе половины старой карты — считать «затронутые аспекты»
  // ради второго ключа больше не нужно.
  Object.assign(changed, stateDelta(before, state));
  Object.assign(prior, stateDelta(state, before));
  gateEntitlements(ctx, 'entity_update');

  // Эффект batch: строка после патча видна следующим операциям
  const afterRow = { ...current, ...patch } as EntityRow;
  batch?.entities.set(input.id, afterRow);

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
    budgetHook: { before: current, after: afterRow },
    ...ancestorRootsOnProjectChange(input.id, before, state),
    // Ссылочная половина записи (§А6): проверка целей и зеркала — после стадии 5.
    ...refWriteOf(ctx, input.id, before, state, propsPatch),
    // «Стала архивной», а не «архивна»: повторная архивация уже архивной цели источников не
    // перепомечает (сам тег идемпотентен, но и лишнего UPDATE по её источникам не будет).
    ...(input.archived === true && !current.archived && { archivedRefTarget: input.id }),
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
  const before = stateOf(current);

  // attach ставит носитель ЦЕЛИКОМ: свойство аспекта, не пришедшее в `data`, снимается —
  // ровно то, что делала подмена аспект-ключа в старой форме. `data` адресуется КЛЮЧАМИ
  // СВОЙСТВ (§А9-1) — той же формой, которую объявляет схема тула.
  const propsPatch = replaceAspectProps(ctx.registry, before, aspectId, input.data);
  // …но снимает ровно то, чем вызывающий вправе распоряжаться (§А2-5): `attach_orbis_financial`
  // НЕ НАЗЫВАЕТ `orbis/bank_txn_id` (в `data` его нет), и стирать импортное тождество из-за
  // навешивания аспекта значило бы терять факт владельца там, где он ни о чём таком не просил.
  // Названное явно поле доходит до гейта и получает `COMPUTED_WRITE` — фильтр только про
  // НЕназванное. Внутренний undo сюда не заходит (у него свой путь в entity_update) и
  // восстанавливает зафиксированное состояние дословно.
  propsPatch.replaced = writableOnly(ctx.registry, ctx.mechanism, propsPatch.replaced);
  const state = applyPropsPatch(before, propsPatch);
  if (aspectId === 'orbis/task') applyTaskCompletion(before, state, now); // §3.2 и для attach
  // Нормализация валюты конверта (бэклог A7): NULL→defaultCurrency и для attach-пути
  await normalizeEnvelopeProps(ctx, before, state, propsPatch);

  // Стадия 4, первый рубеж: запрет по объекту для источника routine (V1.10) — attach это
  // третий путь появления аспекта, им рутина заводилась бы на готовой сущности мимо
  // create. Отвечает РАНЬШЕ гейта флагов: см. тот же довод в entity_update.
  const touched = touchedAspects(ctx.registry, before, state, propsPatch);
  assertRoutineUntouchable(ctx.req.source, {
    before: before.aspects,
    next: state.aspects,
    touched,
  });

  // Гейт флагов (§А2-5/Б6) и стадия 2 — по итоговому состоянию
  assertPropsWritable(ctx.registry, ctx.mechanism, propsPatch);
  assertEntityProps(ctx.registry, state);

  await assertFinancial(ctx, input.entity_id, state, batch);
  // Живой грант в назначении (С4/С7): attach — третий путь появления аспекта, и обходить
  // им инвариант нельзя (тот же довод, что у «одного budget-parent» ниже)
  if (aspectId === 'orbis/assignment') {
    await assertAssignment(ctx.tx, ctx.req.actorUserId, state);
  }
  // Ровно один субъект у прогона (V1.4): attach заменяет аспект ЦЕЛИКОМ, поэтому им можно
  // и потерять субъект, и добавить второй. Гейта по aspectId нет — проверка сама молчит,
  // когда прогона в итоговой карте не оказалось.
  assertRunSubject(state);
  // «Один budget-parent» (§4.2/§13.7) и для attach: аспект orbis/budget ретроспективно
  // делает сущность budget-parent'ом её financial-детей — инвариант проверяется не
  // только в relation_create, иначе attach обходит его (ревью 2026-07-09)
  // Дуальная запись (§А1-1): старая карта — проекция новой правды; она же вход проверок
  // бюджета (их перевод — Задача 7a) и полезной нагрузки журнала.
  const nextLegacy = projectLegacyAspects(ctx.registry, state);
  if (aspectId === 'orbis/budget') {
    await assertBudgetAttachKeepsSingleParent(ctx, input.entity_id, batch);
    // Уникальность конверта (03-budget §2.1) — attach-путь той же комбинации
    await assertEnvelopeUnique(ctx.tx, {
      ownerId: ctx.req.actorUserId,
      entityId: input.entity_id,
      props: state.props,
      virtualEntities: batch?.entities,
    });
  }
  gateEntitlements(ctx, tool);

  // Заготовка тела проекта (С10): attach — третий путь появления orbis/project наравне с
  // create и update, и тело у всех трёх обязано получаться одинаковым. Вход attach тела не
  // несёт ВООБЩЕ (в схеме его нет) — отсюда false, а не hasBodyInInput.
  const seed = needsProjectSeed(before, state, current.body, false)
    ? bodyFieldsFromMarkdown(projectBodyTemplate(input.entity_id), ctx.registry)
    : undefined;

  // Эффект batch; updated_at строго растёт (monotonicUpdatedAt, §5.2)
  const updatedAt = monotonicUpdatedAt(now, current.updatedAt);
  // Патч attach узкий: свойства с аспектами и updated_at, а поля тела — ТОЛЬКО при засеве
  const patch: EntityPatch = {
    props: state.props,
    aspects: state.aspects,
    aspectsLegacy: nextLegacy,
    updatedAt,
  };
  if (seed !== undefined) {
    patch.body = seed.body;
    patch.bodyDoc = seed.bodyDoc;
    preserveBodyBeforeDoc(patch, current);
    patch.bodyRefs = seed.bodyRefs;
    patch.queryRefs = seed.queryRefs;
  }
  const afterRow = { ...current, ...patch } as EntityRow;
  batch?.entities.set(input.entity_id, afterRow);

  const journal: JournalPlan = {
    type: 'entity_updated',
    entityId: input.entity_id,
    tool,
    title: current.title,
    // Полезная нагрузка — дельта состояний (§А7-4), то есть «что именно attach сделал»
    // ПОСЛЕ нормализаций (§3.2, валюта). Не `data` входа: замена носителя снимает и то,
    // чего во входе не было вовсе, и по одному лишь `data` этого не прочитать.
    operations: [
      { op: tool, payload: { entity_id: input.entity_id, ...stateDelta(before, state) } },
    ],
    // Стадии 6–7: inverse — зеркальная дельта, то есть прежние значения ровно тронутых
    // свойств и снятие ровно добавленных (плюс detach аспекта, если его не было). Засеянное
    // тело откатывается вместе с ним, иначе undo снял бы аспект, оставив заготовку проекта
    // на заметке, у которой её не было
    inverse: [
      {
        op: 'entity_update',
        payload: {
          id: input.entity_id,
          ...stateDelta(state, before),
          ...(seed !== undefined ? { body: current.body } : {}),
        },
      },
    ],
  };

  return {
    journal,
    budgetHook: { before: current, after: afterRow },
    ...ancestorRootsOnProjectChange(input.entity_id, before, state),
    // Ссылочная половина записи (§А6): проверка целей и зеркала — после стадии 5.
    ...refWriteOf(ctx, input.entity_id, before, state, propsPatch),
    // Стадия 5
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      const updated = await applyCtx.tx
        .update(entities)
        .set(patch)
        .where(eq(entities.id, input.entity_id))
        .returning();
      const row = updated[0];
      if (!row) throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.entity_id });
      return { result: toWire(row) };
    },
  };
}

/**
 * Сущность СТАЛА проектом или перестала им быть — значит у всего, что под ней, сменился
 * ближайший проект (§А8). Один резолв на оба пути появления аспекта (attach и entity_update):
 * разъехавшись, они дали бы пересчёт по одному входу и молчание по другому.
 *
 * `entity_create` сюда не входит намеренно: у только что созданной сущности нет ни детей,
 * ни родителей, и пересчитывать под ней нечего. Ребро, созданное тем же batch, приносит
 * свой корень само.
 */
function ancestorRootsOnProjectChange(
  entityId: string,
  before: EntityState,
  after: EntityState,
): { ancestorRoots?: string[] } {
  const was = before.aspects.includes(PROJECT_ASPECT);
  const is = after.aspects.includes(PROJECT_ASPECT);
  return was === is ? {} : { ancestorRoots: [entityId] };
}

/**
 * Стадия 4 attach orbis/budget (§4.2/§13.7) — ВТОРОЙ ВХОД в ограничение роли, и он остаётся
 * кодом до части Б (правило Б-2).
 *
 * Почему он не выражается ролью. `target_max_incoming` роли `envelope-binding` смотрит на
 * рёбра ЦЕЛИ и срабатывает на создании ребра. Здесь ребра не создаются вовсе: меняется
 * АСПЕКТ ИСТОЧНИКА. Пока жива переходная колонка, «X стал конвертом» ретроспективно делает
 * budget-parent'ами все его исходящие рёбра, проецирующиеся в `parent` (`budgetParentsOfMany`
 * и агрегаты §2.10 читают именно её), — и у financial-ребёнка их оказывается два.
 *
 * Отсюда фильтр по `LEGACY_PARENT_ROLES` — и в перечислении детей, и в счёте их входящих:
 * ретроспектива живёт ровно на том множестве, которое видит старая колонка. Сама проверка —
 * `assertSingleLegacyBudgetParent`, то есть та же половина правила, что и на пути создания
 * ребра; разъехавшись, эти два входа открыли бы дыру каждый со своей стороны.
 */
async function assertBudgetAttachKeepsSingleParent(
  ctx: ExecCtx,
  entityId: string,
  batch?: BatchState,
): Promise<void> {
  // Порог берётся из реестра, а не пишется здесь числом: ослабив ограничение роли,
  // владелец обязан ослабить и ретроспективу — иначе она запрещала бы разрешённое.
  if (
    ctx.registry.roles.get(ROLE_ENVELOPE_BINDING)?.constraints.target_max_incoming === undefined
  ) {
    return;
  }
  const parentRoles = LEGACY_PARENT_ROLES as readonly string[];
  const rows = await ctx.tx
    .select({ targetId: relations.targetId, role: relations.role })
    .from(relations)
    .where(and(eq(relations.sourceId, entityId), inArray(relations.role, [...parentRoles])));
  const deleted = batch?.deletedRelations ?? [];
  const childIds = new Set(
    rows
      .filter(
        (r) =>
          !deleted.some(
            (d) => d.sourceId === entityId && d.targetId === r.targetId && d.role === r.role,
          ),
      )
      .map((r) => r.targetId),
  );
  for (const c of batch?.createdRelations ?? []) {
    if (parentRoles.includes(c.role) && c.sourceId === entityId) childIds.add(c.targetId);
  }
  // FOR UPDATE в детерминированном порядке id — меньше дедлоков при перекрёстных
  // операциях над теми же детьми (как loadBothEndsForUpdate)
  for (const childId of [...childIds].sort()) {
    const child = await loadEntityForUpdate(ctx, childId, batch);
    if (!child || !hasAspect(child, 'orbis/financial')) continue;
    // Считаем ПО ТОМУ ЖЕ множеству, по которому перечислили детей, — иначе половина правила
    // терялась бы ровно там, где ретроспектива и нужна: у ребёнка, чей другой конверт держит
    // ребро роли владельца (`subitem`), а не системной `envelope-binding`.
    const key: RelationKey = { sourceId: entityId, targetId: childId, role: ROLE_ENVELOPE_BINDING };
    await assertSingleLegacyBudgetParent(ctx.tx, ctx.registry, key, batch?.graph());
  }
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
  return row.aspects.includes(aspectId);
}

/**
 * Подпись роли для карточки журнала (Ч10-С3): её даёт РЕЕСТР, а не строка кода. Неизвестная
 * роль до карточки не доезжает (стадия 4 её отвергает) — фолбэк на id стоит ради
 * до-реформенных action'ов, которые читает лента.
 */
function roleTitle(ctx: ExecCtx, role: string): string {
  return ctx.registry.roles.get(role)?.label.ru ?? role;
}

/** Новая правда строки (§А1-1) как её видят слияние и доменные инварианты. */
function stateOf(row: EntityRow): EntityState {
  return { props: row.props as Record<string, unknown>, aspects: row.aspects };
}

/**
 * Валюта конверта по умолчанию (бэклог A7) — ЧЕРЕЗ функцию бюджета: умолчание владельца
 * обязано жить в одном месте, а не в двух копиях запроса к настройкам. Подставляется прямо
 * в `props`: с переводом бюджета на новую форму (Задача 10a) промежуточный объект «поле
 * старой карты» стал лишним звеном, которое умело только разъехаться с колонкой.
 *
 * `orbis/currency` слито у транзакции и конверта (В1), поэтому подстановка идёт только когда
 * значения нет вовсе: у записи, которая одновременно транзакция и конверт, валюта одна, и
 * перезаписывать её умолчанием значило бы менять сумму транзакции задним числом.
 */
async function normalizeEnvelopeProps(
  ctx: ExecCtx,
  before: EntityState,
  state: EntityState,
  patch: PropsPatch,
): Promise<void> {
  if (!state.aspects.includes('orbis/budget')) return;
  await normalizeEnvelopeCurrency(ctx.tx, ctx.req.actorUserId, state.props);
  // Перенос прошлого периода не переживает смену идентичности конверта (03-budget §2.6) —
  // но только тот, которого патч не касался (см. dropStaleCarryover). Считается ПОСЛЕ
  // подстановки валюты: она входит в идентичность, и до подстановки «валюты не было →
  // стала RUB» читалось бы как смена конверта.
  dropStaleCarryover(before, state, touchedProperties(patch));
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
    role: input.role,
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
  // Запрет по объекту для источника routine (V1.10): достаточно одного конца с
  // orbis/routine — оба конца уже под FOR UPDATE (loadBothEndsForUpdate выше)
  assertRoutineRelationUntouchable(ctx.req.source, {
    source: source.aspects,
    target: target.aspects,
  });
  // Ограничения роли по реестру (§А4-2): acyclic, target_max_incoming, гейт created_by.
  // Аспекты концов здесь больше не спрашиваются — смысл ребра написан его ролью.
  // Идёт ПЕРВОЙ: она же проверяет, что роль вообще существует, а проверка дубля ниже уже
  // считает её проекцию в старую колонку и на несуществующей роли упала бы голым Error.
  await assertRoleConstraints(ctx.tx, ctx.registry, key, batch?.graph(), {
    ownerId: ctx.req.actorUserId,
    mechanism: ctx.mechanism,
    undoReplay: ctx.internalUndo !== undefined,
  });
  // Дубль ловим ДО записи на ОБОИХ путях (не только в batch): под `rel_uniq` до 0017
  // попадают две разные роли, и различить их случаи можно только пока транзакция жива.
  await assertNoDuplicateRelation(ctx.tx, ctx.registry, key, batch?.graph());
  // ВТОРАЯ ПОЛОВИНА «одного budget-parent» — та, которой ограничение роли не покрывает
  // (§4.2/§13.7, интервал до 0017). Условие применимости — дословно прежнее: ребро от
  // конверта к транзакции, проецирующееся в старый `parent`. Одной ролью здесь ничего не
  // решается потому, что то же множество считают агрегаты (`spentByEnvelope`) и хук
  // привязки: сузь его здесь — и владелец увидит одну трату в двух конвертах.
  const sourceHasBudget = hasAspect(source, 'orbis/budget');
  if (
    sourceHasBudget &&
    hasAspect(target, 'orbis/financial') &&
    (LEGACY_PARENT_ROLES as readonly string[]).includes(key.role)
  ) {
    await assertSingleLegacyBudgetParent(ctx.tx, ctx.registry, key, batch?.graph());
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
    // Подпись роли — из реестра (Ч10-С3): её пишет определение, а не UI и не executor
    title: `${roleTitle(ctx, key.role)}: «${source.title}» → «${target.title}»`,
    operations: [
      {
        op: 'relation_create',
        payload: { id, source_id: key.sourceId, target_id: key.targetId, role: key.role },
      },
    ],
    // §7.8: создание relation → её удаление
    inverse: [
      {
        op: 'relation_delete',
        payload: { source_id: key.sourceId, target_id: key.targetId, role: key.role },
      },
    ],
  };

  return {
    journal,
    // Предок меняется у ЦЕЛИ ребра и всего, что под ней: «родитель → ребёнок» — это
    // source → target (§6). У неиерархической роли предки не меняются вовсе.
    ...(ctx.registry.roles.get(key.role)?.hierarchical === true && {
      ancestorRoots: [key.targetId],
    }),
    // Стадия 5: вставка; повтор под гонкой — 23505 rel_uniq → структурированная
    // INVARIANT/duplicate_relation, не 500 (§4.2)
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      try {
        const inserted = await applyCtx.tx
          .insert(relations)
          .values({
            id,
            sourceId: key.sourceId,
            targetId: key.targetId,
            role: key.role,
            // ПЕРЕХОДНОЕ (до 0017): старая колонка пишется ПРОЕКЦИЕЙ роли и только здесь —
            // другого писателя у неё нет, поэтому разъехаться с ролью она не может
            relationType: projectLegacyRelationType(key.role),
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
        // Вторая линия под гонкой: пре-чек выше отработал до вставки, но конкурент мог
        // закоммитить свою строку между стадиями 4 и 5.
        if (pg.code === '23505' && pg.constraint === 'rel_uniq') {
          throw duplicateRelationError(key, applyCtx.registry.roles.get(key.role));
        }
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
    role: input.role,
  };
  const matchesKey = (k: RelationKey) => sameRelationKey(k, key);

  // Стадия 3, ЧАСТЬ ПЕРВАЯ: концы связи под замком — только для источника routine (V1.10).
  // Порядок захвата замков во всём executor'е — «сущности → связь»: prepareRelationCreate
  // берёт оба конца (loadBothEndsForUpdate) и лишь потом вставляет строку связи, а batch
  // [entity_update A; relation_delete A→B] блокирует A раньше R. Поэтому дозагрузка стоит
  // ЗДЕСЬ, до строки связи: возьми мы её после, рутинное удаление держало бы R и ждало A,
  // пока конкурент держит A и ждёт R — цикл, PG отстреливает одну tx (40P01), и прогон
  // рутины падает непонятной ошибкой (гейт-ревью Задачи 4). Остальным источникам концы не
  // нужны — им довольно строки связи, и лишний FOR UPDATE на каждом удалении не берётся.
  const routineEnds =
    ctx.req.source === 'routine' ? await loadBothEndsForUpdate(ctx, key, batch) : undefined;

  // Стадия 3, ЧАСТЬ ВТОРАЯ: строка связи под замком. Приоритет — виртуальная связь, созданная
  // тем же batch (к моменту apply она уже будет вставлена); RLS скрывает чужие → NOT_FOUND.
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
          eq(relations.role, key.role),
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
  // Запрет по объекту для источника routine (V1.10): «удалить» — такой же глагол, как
  // «создать», и объект у него тот же. Проверка идёт по строкам, взятым под FOR UPDATE
  // стадией 3, и до любой записи; сам захват — выше, ради порядка «сущности → связь».
  if (routineEnds !== undefined) {
    assertRoutineRelationUntouchable(ctx.req.source, {
      source: routineEnds.source.aspects,
      target: routineEnds.target.aspects,
    });
  }
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
    title: `удалена ${roleTitle(ctx, key.role)}: «${titles.get(key.sourceId) ?? key.sourceId}» → «${titles.get(key.targetId) ?? key.targetId}»`,
    operations: [
      {
        op: 'relation_delete',
        payload: { source_id: key.sourceId, target_id: key.targetId, role: key.role },
      },
    ],
    // §7.8: удаление relation → её пересоздание (meta сохраняется в inverse)
    inverse: [
      {
        op: 'relation_create',
        payload: {
          source_id: key.sourceId,
          target_id: key.targetId,
          role: key.role,
          meta: existingMeta,
        },
      },
    ],
  };

  return {
    journal,
    // Снятое иерархическое ребро сдвигает предков того же поддерева, что и созданное.
    ...(ctx.registry.roles.get(key.role)?.hierarchical === true && {
      ancestorRoots: [key.targetId],
    }),
    // Стадия 5: DELETE по паре концов и роли (строка под замком стадии 3 либо вставлена
    // этим же batch)
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      const deleted = await applyCtx.tx
        .delete(relations)
        .where(
          and(
            eq(relations.sourceId, key.sourceId),
            eq(relations.targetId, key.targetId),
            eq(relations.role, key.role),
          ),
        )
        .returning();
      const row = deleted[0];
      if (!row) throw new ExecError('NOT_FOUND', 'связь не найдена', { ...key });
      return { result: toWireRelation(row) };
    },
  };
}

// ---------------------------------------------------------------------------
// entity_origin_create / entity_origin_delete — provenance импорта (01-arch §4.8)
//
// Внутренние операции: в реестр тулов не входят (см. схемы выше), но проходят те же
// стадии конвейера, что и остальные, — и потому доступны Undo (внутренний режим
// проигрывает inverse тем же execute). Гейт доступа — не стадия 4 этих операций, а
// entitlement 'import.csv' роутера импорта: единственный внешний путь к ним.
// ---------------------------------------------------------------------------

async function prepareOriginCreate(ctx: ExecCtx, rawInput: unknown): Promise<PreparedOp> {
  // Стадия 1
  const input = parseEnvelope(entityOriginCreateInput, rawInput, 'entity_origin_create');
  const id = newId(); // id строки — серверный, в контракт операции не входит
  const now = ctx.clock();

  // Стадий 3–4 нет намеренно: владение целевой сущностью проверяет RLS-политика
  // owner_owns_row_and_entity (миграция 0002), а в batch импорта сущность создаётся
  // ПРЕДЫДУЩЕЙ операцией того же batch — на момент prepare её ещё нет в БД.
  const journal: JournalPlan = {
    type: 'origin_created',
    entityId: input.entity_id,
    tool: 'entity_origin_create',
    title: `источник ${input.namespace}`,
    operations: [
      {
        op: 'entity_origin_create',
        payload: {
          entity_id: input.entity_id,
          namespace: input.namespace,
          external_id: input.external_id,
        },
      },
    ],
    // §4.8 и 03-budget §3.4.1: откат импорта УДАЛЯЕТ строку origins физически —
    // иначе тот же файл после Undo не импортировался бы («уже импортирована» навсегда)
    inverse: [
      {
        op: 'entity_origin_delete',
        payload: { namespace: input.namespace, external_id: input.external_id },
      },
    ],
  };

  return {
    journal,
    // Стадия 5
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      try {
        const inserted = await applyCtx.tx
          .insert(entityOrigins)
          .values({
            id,
            ownerId: applyCtx.req.actorUserId,
            entityId: input.entity_id,
            namespace: input.namespace,
            externalId: input.external_id,
            createdAt: now,
          })
          .returning();
        const row = inserted[0];
        if (!row) {
          throw new ExecError('NOT_FOUND', 'строка источника не записана', { id }); // недостижимо
        }
        return { result: toWireOrigin(row) };
      } catch (e) {
        const pg = pgErrorInfo(e);
        // Повтор строки того же источника — уже импортирована (§3.4.1); 23505 маппится
        // структурно, как rel_uniq у relation_create
        if (pg.code === '23505' && pg.constraint === 'entity_origins_uniq') {
          throw new ExecError(
            'CONFLICT',
            'строка этого источника уже импортирована (§3.4.1); повторный импорт не создаёт дублей',
            {
              reason: 'origin_conflict',
              namespace: input.namespace,
              external_id: input.external_id,
            },
          );
        }
        // Чужая (RLS: WITH CHECK не пропустил, 42501) или несуществующая (FK, 23503)
        // сущность — единый NOT_FOUND, как у relation-тулов: «чужая» и «несуществующая»
        // неразличимы намеренно
        if (pg.code === '42501' || pg.code === '23503') {
          throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.entity_id });
        }
        throw e;
      }
    },
  };
}

async function prepareOriginDelete(ctx: ExecCtx, rawInput: unknown): Promise<PreparedOp> {
  // Стадия 1
  const input = parseEnvelope(entityOriginDeleteInput, rawInput, 'entity_origin_delete');

  // Стадия 3: строка под замком — inverse обязан нести entity_id удаляемой строки
  // (её id пересоздание не сохраняет: строка новая). Владелец — ЯВНЫМ предикатом, а не
  // только RLS: (namespace, external_id) уникален лишь ВНУТРИ владельца, и это
  // единственное место исполнителя, которое удаляет строку ФИЗИЧЕСКИ по такому ключу.
  // Поведение не меняется (оба пути под withIdentity) — это глубина защиты.
  const rows = await ctx.tx
    .select()
    .from(entityOrigins)
    .where(
      and(
        eq(entityOrigins.ownerId, ctx.req.actorUserId),
        eq(entityOrigins.namespace, input.namespace),
        eq(entityOrigins.externalId, input.external_id),
      ),
    )
    .for('update');
  const row = rows[0];
  if (!row) {
    throw new ExecError('NOT_FOUND', 'строка источника не найдена', {
      namespace: input.namespace,
      external_id: input.external_id,
    });
  }

  const journal: JournalPlan = {
    type: 'origin_deleted',
    entityId: row.entityId,
    tool: 'entity_origin_delete',
    title: `удалён источник ${input.namespace}`,
    operations: [
      {
        op: 'entity_origin_delete',
        payload: { namespace: input.namespace, external_id: input.external_id },
      },
    ],
    inverse: [
      {
        op: 'entity_origin_create',
        payload: {
          entity_id: row.entityId,
          namespace: input.namespace,
          external_id: input.external_id,
        },
      },
    ],
  };

  return {
    journal,
    // Стадия 5: ФИЗИЧЕСКОЕ удаление (§4.8) — архивации у provenance-строк нет
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      const deleted = await applyCtx.tx
        .delete(entityOrigins)
        .where(
          and(
            // owner_id — тем же явным предикатом, что и SELECT ... FOR UPDATE выше
            eq(entityOrigins.ownerId, applyCtx.req.actorUserId),
            eq(entityOrigins.namespace, input.namespace),
            eq(entityOrigins.externalId, input.external_id),
          ),
        )
        .returning();
      const gone = deleted[0];
      if (!gone) {
        throw new ExecError('NOT_FOUND', 'строка источника не найдена', {
          namespace: input.namespace,
          external_id: input.external_id,
        });
      }
      return { result: toWireOrigin(gone) };
    },
  };
}

// ---------------------------------------------------------------------------
// entity_version_pin / entity_version_delete — закреплённые версии тела (С11)
//
// Внутренние операции (схемы выше): в реестр тулов не входят, но проходят те же стадии
// конвейера, что и остальные, — и потому доступны Undo (внутренний режим проигрывает
// inverse тем же execute). Снимок — ТЕЛО и только тело: аспекты, связи и заголовок в
// версию не входят, поэтому и откат их не трогает (инвариант 8 среза).
// ---------------------------------------------------------------------------

async function prepareVersionPin(
  ctx: ExecCtx,
  rawInput: unknown,
  batch?: BatchState,
): Promise<PreparedOp> {
  // Стадия 1
  const input = parseEnvelope(entityVersionPinInput, rawInput, 'entity_version_pin');
  const id = input.id ?? newId();
  const now = ctx.clock();

  // Стадия 3: сущность ПОД ЗАМКОМ. Замок здесь не ради merge (записи в entities нет), а
  // ради честности снимка: без него конкурентная правка тела могла бы закоммититься между
  // чтением и вставкой, и версия «до правки» содержала бы уже правленое тело.
  // RLS: чужая и несуществующая неразличимы — единый NOT_FOUND (как у entity_update).
  // Виртуальное состояние batch учитывается тем же хелпером: сущность, созданную
  // ПРЕДЫДУЩЕЙ операцией того же batch, на стадии prepare в БД ещё не найти (§7.8).
  const current = await loadEntityForUpdate(ctx, input.entity_id, batch);
  if (!current) {
    throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.entity_id });
  }

  const journal: JournalPlan = {
    type: 'version_pinned',
    entityId: input.entity_id,
    tool: 'entity_version_pin',
    title: `Закреплена версия «${input.label}»`,
    operations: [
      {
        op: 'entity_version_pin',
        // id — в операции журнала, а не только в inverse: по нему читается, что именно
        // закрепило это действие, когда версия уже удалена откатом
        payload: { id, entity_id: input.entity_id, label: input.label },
      },
    ],
    // Откат закрепления УДАЛЯЕТ снимок физически: «версия, которую я не закреплял»,
    // осталась бы висеть в списке навсегда — архивации у служебных строк нет (ср. §4.8)
    inverse: [{ op: 'entity_version_delete', payload: { id } }],
  };

  return {
    journal,
    // Стадия 5
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      try {
        const inserted = await applyCtx.tx
          .insert(entityVersions)
          .values({
            id,
            ownerId: applyCtx.req.actorUserId,
            entityId: input.entity_id,
            label: input.label,
            body: current.body,
            // Документ — КАК ЛЕЖИТ: у тела «до бэкфилла» его нет, и собирать его здесь
            // значило бы записать в снимок разбор, которого в сущности не было. body
            // (NOT NULL) переживает любую смену схемы документа — этого и достаточно.
            bodyDoc: current.bodyDoc,
            actorUserId: applyCtx.req.actorUserId,
            actorKind: applyCtx.req.actorKind,
            createdAt: now,
          })
          .returning();
        const row = inserted[0];
        if (!row) {
          throw new ExecError('NOT_FOUND', 'версия не записана', { id }); // недостижимо
        }
        return { result: toWireEntityVersion(row) };
      } catch (e) {
        const pg = pgErrorInfo(e);
        // Явный id занят: закрепление не идемпотентно по id (тело к повтору уже другое),
        // поэтому 409, а не replay — тот же wire-контракт id_conflict, что у entity_create
        if (pg.code === '23505') {
          throw new ExecError('CONFLICT', 'id непригоден для закрепления — сгенерируйте новый', {
            id,
            reason: 'id_conflict',
          });
        }
        throw e;
      }
    },
  };
}

async function prepareVersionDelete(ctx: ExecCtx, rawInput: unknown): Promise<PreparedOp> {
  // Стадия 1
  const input = parseEnvelope(entityVersionDeleteInput, rawInput, 'entity_version_delete');

  // Стадия 3: строка под замком — журнал должен нести entity_id удаляемой версии.
  // Владелец — ЯВНЫМ предикатом поверх RLS, той же глубиной защиты, что у origin-удаления:
  // это второе место исполнителя, удаляющее строку ФИЗИЧЕСКИ.
  const rows = await ctx.tx
    .select()
    .from(entityVersions)
    .where(and(eq(entityVersions.ownerId, ctx.req.actorUserId), eq(entityVersions.id, input.id)))
    .for('update');
  const row = rows[0];
  if (!row) {
    throw new ExecError('NOT_FOUND', 'версия не найдена', { id: input.id });
  }

  const journal: JournalPlan = {
    type: 'version_deleted',
    entityId: row.entityId,
    tool: 'entity_version_delete',
    title: `Удалена версия «${row.label}»`,
    operations: [{ op: 'entity_version_delete', payload: { id: input.id } }],
    // Пусто намеренно: операция достижима только как inverse закрепления, а undo самого
    // undo в Orbis не существует (undo.ts:4-5 — undo не порождает нового action).
    inverse: [],
  };

  return {
    journal,
    // Стадия 5: ФИЗИЧЕСКОЕ удаление — снимок тела, которого владелец не закреплял,
    // хранить незачем (та же логика, что у provenance-строк §4.8)
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      const deleted = await applyCtx.tx
        .delete(entityVersions)
        .where(
          and(
            // owner_id — тем же явным предикатом, что и SELECT ... FOR UPDATE выше
            eq(entityVersions.ownerId, applyCtx.req.actorUserId),
            eq(entityVersions.id, input.id),
          ),
        )
        .returning();
      const gone = deleted[0];
      if (!gone) {
        throw new ExecError('NOT_FOUND', 'версия не найдена', { id: input.id });
      }
      // Результат — wire-форма УДАЛЁННОЙ строки (как у entity_origin_delete): контракт
      // операции требует минимум { id }, а полная форма его содержит и не заводит в
      // закрытом union OpOutcome вырожденного типа ради одного поля.
      return { result: toWireEntityVersion(gone) };
    },
  };
}

// ---------------------------------------------------------------------------
// Операции реестра (§А10-2, §А2-7, §А3-2)
// ---------------------------------------------------------------------------

/**
 * Имена, при которых транзакция берёт замок реестра. Пять публичных тулов плюс две
 * ВНУТРЕННИЕ обратные операции — те же две, что перечислены ниже: их зовёт только undo.ts
 * через `execute` во внутреннем режиме, в `CORE_TOOLS` их нет, и `dispatchTool` их не
 * резолвит (реестр тулов не знает таких имён).
 */
const REGISTRY_OPS: ReadonlySet<string> = new Set([
  ...REGISTRY_TOOL_NAMES,
  'property_row_restore',
  'property_merge_undo',
]);

/**
 * ВНУТРЕННЯЯ обратная операция для `property_create` и `property_update` сразу (§7.8).
 * Живёт ЗДЕСЬ и в `CORE_TOOLS` не регистрируется — как origin- и version-операции выше:
 * снаружи она недостижима, а inverse журнала исполняется через тот же конвейер.
 *
 * `row: null` означает «строки не было» — то есть удалить. Форма строки разбирается здесь
 * нестрого (`record`), а по существу — строгой `propertyDefinitionSchema` уже внутри
 * `restorePropertyRow`: журнал append-only, и записи в нём старше любой сегодняшней схемы.
 */
const propertyRowRestoreInput = z
  .object({ id: z.string().min(1), row: z.record(z.unknown()).nullable() })
  .strict();

/** ВНУТРЕННЯЯ обратная операция слияния — ОДНА на всё, что слияние сделало (§А10-2). */
const propertyMergeUndoInput = z
  .object({
    source: z.string().min(1),
    into: z.string().min(1),
    sourceRow: z
      .object({
        status: z.enum(['active', 'proposed', 'deprecated']),
        mergedInto: z.string().nullable(),
      })
      .strict(),
    values: z.array(
      z
        .object({
          entityId: z.string().uuid(),
          source: z.unknown(),
          hadInto: z.boolean(),
          into: z.unknown(),
        })
        .strict(),
    ),
    compacted: z.array(z.string()),
    registry: z.array(z.object({ id: z.string(), scope: z.unknown(), type: z.unknown() }).strict()),
    progress: z.array(z.object({ entityId: z.string().uuid(), value: z.unknown() }).strict()),
    bodies: z.array(
      z
        .object({
          entityId: z.string().uuid(),
          body: z.string(),
          bodyDoc: z.unknown(),
          // Оба индекса ОПЦИОНАЛЬНЫ по той же причине, что `deltas` ниже: журнал
          // append-only, и слияния, записанные до того, как их начали возвращать откатом,
          // этих ключей не несут. `undoMerge` читает их защитно и пересчитывает из
          // восстановленного документа.
          bodyRefs: z.array(z.string()).optional(),
          queryRefs: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    // ОПЦИОНАЛЬНО, и это не небрежность: журнал append-only (§4.6), и действия, записанные
    // до появления четвёртого рода держателей (дельты), ключа `deltas` не несут вовсе.
    // Требовать его значило бы сделать неоткатываемыми вчерашние слияния владельца.
    deltas: z.array(z.object({ id: z.string().uuid(), delta: z.unknown() }).strict()).optional(),
  })
  .strict();

/**
 * ПОЧЕМУ ИНВЕРС ЭТИХ ОПЕРАЦИЙ ДОПИСЫВАЕТСЯ В `apply`, А НЕ СЧИТАЕТСЯ В `prepare`.
 *
 * У всех остальных операций конвейера обратная нагрузка известна заранее: прежнее состояние
 * читает стадия 3. У реестровых — нет, и это не лень: id заведённого свойства выбирает сама
 * операция, а карта «сущность → прежние значения» слияния снимается ТЕМ ЖЕ снапшотом, что
 * и UPDATE (CTE с `FOR UPDATE`, см. `mergeProperty`). Снять её отдельным SELECT'ом на стадии
 * 3 значило бы получить список, в который не попадёт запись, изменённая между чтением и
 * записью, — то есть inverse, откатывающий НЕ ВСЁ.
 *
 * Безопасно это потому, что журнал собирается ПОСЛЕ всех `apply` (`writeJournal` и
 * `aggregateInverse` зовутся из `execute`/`executeBatch` за последним применением), и между
 * prepare и этим моментом `journal.inverse` не читает никто.
 */
function registryPlan(type: ActionRecord['type'], tool: string, title: string): JournalPlan {
  return { type, entityId: null, tool, title, operations: [], inverse: [] };
}

async function preparePropertyCreate(_ctx: ExecCtx, rawInput: unknown): Promise<PreparedOp> {
  const input = parseEnvelope(propertyCreateInput, rawInput, 'property_create');
  const journal = registryPlan(
    'property_created',
    'property_create',
    `Заведено свойство «${effectiveLabel(input.label as Record<string, string>, OWNER_LOCALE)}»`,
  );
  return {
    journal,
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      const created = await createProperty(
        applyCtx.tx,
        applyCtx.req.actorUserId,
        input as unknown as CreatePropertyInput,
      );
      journal.operations.push({ op: 'property_create', payload: { ...input, id: created.id } });
      journal.inverse.push({
        op: 'property_row_restore',
        payload: { id: created.id, row: null },
      });
      return { result: { property: created.id, key: created.key } };
    },
  };
}

async function preparePropertyUpdate(_ctx: ExecCtx, rawInput: unknown): Promise<PreparedOp> {
  const input = parseEnvelope(propertyUpdateInput, rawInput, 'property_update');
  const journal = registryPlan(
    'property_updated',
    'property_update',
    `Правка свойства «${input.id}»`,
  );
  return {
    journal,
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      // АДРЕС РЕЗОЛВИТ САМА ОПЕРАЦИЯ, в своей транзакции (`readOwnProperty`: id ИЛИ key), а
      // не снимок реестра. Снимок снят ДО стадий, и свойство, заведённое предыдущей
      // операцией той же пачки, в нём отсутствует — резолв по нему отвечал бы `NOT_FOUND`
      // на ключ, который владелец только что и завёл.
      const before = await readOwnProperty(applyCtx.tx, applyCtx.req.actorUserId, input.id);
      const id = before?.id ?? input.id;
      journal.title = `Правка свойства «${id}»`;
      await updateProperty(applyCtx.tx, applyCtx.req.actorUserId, input.id, {
        ...(input.label !== undefined && { label: input.label }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.scope !== undefined && { scope: input.scope as never }),
        ...(input.rank !== undefined && { rank: input.rank }),
        ...(input.status !== undefined && { status: input.status }),
      });
      journal.operations.push({ op: 'property_update', payload: { ...input, id } });
      journal.inverse.push({
        op: 'property_row_restore',
        payload: { id, row: (before ?? null) as unknown as Record<string, unknown> | null },
      });
      return { result: { property: id } };
    },
  };
}

async function preparePropertyMerge(_ctx: ExecCtx, rawInput: unknown): Promise<PreparedOp> {
  const input = parseEnvelope(propertyMergeInput, rawInput, 'property_merge');
  const journal = registryPlan(
    'property_merged',
    'property_merge',
    `Свойства слиты: ${input.source} → ${input.into}`,
  );
  return {
    journal,
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      // Адрес резолвит сама операция, в своей транзакции (см. `preparePropertyUpdate`):
      // `resolveMergePair` принимает и id, и key, а снимок исполнителя пачку не видит.
      const merged = await mergeProperty(applyCtx.tx, applyCtx.req.actorUserId, input);
      const { source, into } = merged.inverse;
      journal.title = `Свойства слиты: ${source} → ${into}`;
      journal.operations.push({
        op: 'property_merge',
        payload: {
          source,
          into,
          rewritten_entities: merged.rewrittenEntities,
          rewritten_queries: merged.rewrittenQueries,
        },
      });
      // ОДИН inverse на всю операцию (§А10-2): значения, ссылки, компактация и сама строка
      // возвращаются одним шагом — частичного отката слияния не бывает.
      journal.inverse.push({
        op: 'property_merge_undo',
        payload: merged.inverse as unknown as Record<string, unknown>,
      });
      return {
        result: {
          source,
          into,
          rewrittenEntities: merged.rewrittenEntities,
          rewrittenQueries: merged.rewrittenQueries,
        },
      };
    },
  };
}

async function prepareAspectDeltaSet(_ctx: ExecCtx, rawInput: unknown): Promise<PreparedOp> {
  const input = parseEnvelope(aspectDeltaSetInput, rawInput, 'aspect_delta_set');
  const journal = registryPlan(
    'aspect_delta_set',
    'aspect_delta_set',
    `Настройка аспекта «${input.aspect}»`,
  );
  return {
    journal,
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      const before = await readAspectDelta(applyCtx.tx, applyCtx.req.actorUserId, input.aspect);
      await setAspectDelta(applyCtx.tx, applyCtx.req.actorUserId, input.aspect, input.delta);
      journal.operations.push({ op: 'aspect_delta_set', payload: { ...input } });
      // Отмена настройки — это ПРЕЖНЯЯ настройка, а если её не было — снятие. Обе формы
      // выражаются существующими операциями: своей обратной у дельты нет и не нужно.
      journal.inverse.push(
        before === null
          ? { op: 'aspect_delta_remove', payload: { aspect: input.aspect } }
          : { op: 'aspect_delta_set', payload: { aspect: input.aspect, delta: before } },
      );
      return { result: { aspect: input.aspect } };
    },
  };
}

async function prepareAspectDeltaRemove(_ctx: ExecCtx, rawInput: unknown): Promise<PreparedOp> {
  const input = parseEnvelope(aspectDeltaRemoveInput, rawInput, 'aspect_delta_remove');
  const journal = registryPlan(
    'aspect_delta_removed',
    'aspect_delta_remove',
    `Настройка аспекта «${input.aspect}» снята`,
  );
  return {
    journal,
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      const before = await readAspectDelta(applyCtx.tx, applyCtx.req.actorUserId, input.aspect);
      await removeAspectDelta(applyCtx.tx, applyCtx.req.actorUserId, input.aspect);
      journal.operations.push({ op: 'aspect_delta_remove', payload: { ...input } });
      if (before !== null) {
        journal.inverse.push({
          op: 'aspect_delta_set',
          payload: { aspect: input.aspect, delta: before },
        });
      }
      return { result: { aspect: input.aspect } };
    },
  };
}

async function preparePropertyRowRestore(_ctx: ExecCtx, rawInput: unknown): Promise<PreparedOp> {
  const input = parseEnvelope(propertyRowRestoreInput, rawInput, 'property_row_restore');
  const journal = registryPlan(
    'property_updated',
    'property_row_restore',
    `Возврат строки свойства «${input.id}»`,
  );
  return {
    journal,
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      await restorePropertyRow(
        applyCtx.tx,
        applyCtx.req.actorUserId,
        input.id,
        (input.row ?? null) as PropertyRow | null,
      );
      return { result: { property: input.id } };
    },
  };
}

async function preparePropertyMergeUndo(_ctx: ExecCtx, rawInput: unknown): Promise<PreparedOp> {
  const input = parseEnvelope(propertyMergeUndoInput, rawInput, 'property_merge_undo');
  const journal = registryPlan(
    'property_merged',
    'property_merge_undo',
    `Слияние ${input.source} → ${input.into} отменено`,
  );
  return {
    journal,
    async apply(applyCtx: ExecCtx): Promise<OpOutcome> {
      await undoMerge(applyCtx.tx, applyCtx.req.actorUserId, input as unknown as MergeInverse);
      return {
        result: {
          source: input.source,
          into: input.into,
          rewrittenEntities: input.values.length,
          rewrittenQueries:
            input.registry.length +
            input.progress.length +
            input.bodies.length +
            (input.deltas?.length ?? 0),
        },
      };
    },
  };
}
