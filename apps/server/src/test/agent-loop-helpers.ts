// apps/server/src/test/agent-loop-helpers.ts
// Обвязка интеграционных тестов круга исполнителя (verbs.test.ts, sweep.test.ts).
// Не тест сам по себе — библиотека (bun test берёт только *.test.ts), прецедент —
// src/test/perf.ts.
//
// Вынесена из двух сьютов, потому что сид и чтение графа у них обязаны совпадать: если
// один файл сидирует через executor, а другой прямыми вставками, расхождение в поведении
// глаголов начнёт читаться как разница фикстур, а не кода.
//
// Фабрика, а не свободные функции: каждый сьют держит СВОЙ пул (`appDb()` + `client.end()`
// в afterAll), и передавать `db` первым аргументом в каждый вызов значило бы повторять его
// в каждой строке теста.
import { newId, routineRunBatchId, routineRunId } from '@orbis/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { chatMessages, chatThreads, entities, relations } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { ActionRecord, WireEntity } from '../executor/types';
import { issuePatGrant, verifyBearer } from '../oauth/grants';
import type { ToolCallCtx } from '../tools/dispatch';
import type { RoutineRef } from '../tools/registry';

/** Опорный момент времени сьютов круга: всё время в тестах отсчитывается от него. */
export const T0 = new Date('2026-08-17T12:00:00.000Z');

export function iso(d: Date): string {
  return d.toISOString();
}

export type AnyRecord = Record<string, unknown>;

export interface AgentLoopHelpers {
  seedEntity: (owner: string, input: Record<string, unknown>) => Promise<WireEntity>;
  link: (owner: string, parentId: string, childId: string) => Promise<void>;
  aspectsOf: (owner: string, id: string) => Promise<Record<string, AnyRecord>>;
  childrenOf: (owner: string, parentId: string) => Promise<string[]>;
  actionsOf: (owner: string) => Promise<ActionRecord[]>;
  workerGrant: (owner: string, label: string) => Promise<string>;
  worker: (owner: string, grantId: string, over?: Partial<ToolCallCtx>) => ToolCallCtx;
  routineCtx: (
    owner: string,
    mode: RoutineRef['mode'],
    allowedTools?: Iterable<string>,
    over?: Partial<ToolCallCtx>,
  ) => ToolCallCtx & { routine: RoutineRef };
  seedRoutine: (owner: string, over?: SeedRoutineOver) => Promise<string>;
  seedRoutineRun: (owner: string, args: SeedRoutineRunArgs) => Promise<SeededRoutineRun>;
}

/** Чем отличается сидируемая рутина от умолчания: тело — инструкция, аспект — права. */
export interface SeedRoutineOver {
  title?: string;
  /** Инструкция прогону: у рутины «что делать» лежит в ТЕЛЕ (V1.1), как у проекта. */
  body?: string;
  routine?: AnyRecord;
}

export interface SeedRoutineRunArgs {
  routineId: string;
  bucket?: string;
  attempt?: number;
  startedAt?: Date;
  /** Отметка живости: ею подметание (С6, V1.12) отличает брошенный прогон от идущего. */
  lastStepAt?: Date;
  /** Поля аспекта прогона поверх умолчаний (исход, шаги, fail_note, proposal). */
  run?: AnyRecord;
}

export interface SeededRoutineRun {
  runId: string;
  bucket: string;
  attempt: number;
}

export function agentLoopHelpers(db: Db): AgentLoopHelpers {
  /** Сид-сущность через executor без синка — без audit-шума в тредах. */
  async function seedEntity(owner: string, input: Record<string, unknown>): Promise<WireEntity> {
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_create', input }],
    });
    if (!r.ok) throw new Error(`seedEntity: ${r.error.code} ${r.error.message}`);
    return r.results[0] as WireEntity;
  }

  async function link(owner: string, parentId: string, childId: string): Promise<void> {
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'relation_create',
          input: { source_id: parentId, target_id: childId, relation_type: 'parent' },
        },
      ],
    });
    if (!r.ok) throw new Error(`link: ${r.error.code} ${r.error.message}`);
  }

  async function aspectsOf(owner: string, id: string): Promise<Record<string, AnyRecord>> {
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select({ aspects: entities.aspects }).from(entities).where(eq(entities.id, id)),
    );
    const row = rows[0];
    if (!row) throw new Error(`сущность ${id} не найдена`);
    return row.aspects as Record<string, AnyRecord>;
  }

  /** Дети сущности по связи parent (прогоны тикета). */
  async function childrenOf(owner: string, parentId: string): Promise<string[]> {
    const rows = await withIdentity(db, owner, (tx) =>
      tx
        .select({ id: relations.targetId })
        .from(relations)
        .where(and(eq(relations.sourceId, parentId), eq(relations.relationType, 'parent'))),
    );
    return rows.map((r) => r.id);
  }

  /** Все action'ы журнала §7.8 владельца — по всем его тредам. */
  async function actionsOf(owner: string): Promise<ActionRecord[]> {
    const rows = await withIdentity(db, owner, (tx) =>
      tx
        .select({ metadata: chatMessages.metadata })
        .from(chatMessages)
        .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
        .where(eq(chatThreads.ownerId, owner)),
    );
    return rows.flatMap((r) => (r.metadata as { actions?: ActionRecord[] }).actions ?? []);
  }

  /**
   * Грант выдаётся штатным путём: инвариант assertAssignment требует ЖИВОГО гранта
   * владельца, а вставка строки руками обходила бы ровно тот код, которым скоуп пишется.
   */
  async function workerGrant(owner: string, label: string): Promise<string> {
    const token = await issuePatGrant(db, { ownerId: owner, label, scope: 'worker' });
    const identity = await verifyBearer(db, token);
    if (identity === null) throw new Error('выданный worker-PAT не прошёл verifyBearer');
    return identity.grantId;
  }

  /** Контекст вызова от имени фонового исполнителя (MCP + грант скоупа worker). */
  function worker(owner: string, grantId: string, over: Partial<ToolCallCtx> = {}): ToolCallCtx {
    return {
      db,
      actorUserId: owner,
      actorKind: 'agent',
      source: 'mcp',
      explicitCommand: false,
      clock: () => T0,
      grant: { id: grantId, scope: 'worker', label: 'w' },
      ...over,
    };
  }

  /**
   * Контекст вызова из прогона рутины (V1.10) — то же место, что `worker` занимает у
   * внешнего исполнителя: субъект вызова плюс поверхность. id рутины и прогона минтятся
   * прямо здесь: гейт режима смотрит ТОЛЬКО на контекст, живые сущности ему не нужны;
   * тесту, которому нужны настоящие (прогон в БД), их подменяет `over.routine`.
   */
  function routineCtx(
    owner: string,
    mode: RoutineRef['mode'],
    allowedTools: Iterable<string> = [],
    over: Partial<ToolCallCtx> = {},
  ): ToolCallCtx & { routine: RoutineRef } {
    const runId = newId();
    const routine: RoutineRef = { id: newId(), runId, mode, allowedTools: new Set(allowedTools) };
    return {
      db,
      actorUserId: owner,
      actorKind: 'ai', // за прогоном рутины стоит внутренний AI, а не внешний агент
      source: 'routine',
      explicitCommand: false, // прямой команды владельца за фоновым прогоном нет
      clock: () => T0,
      ...over,
      // runId по умолчанию берётся у РУТИНЫ, а не у локально сминченного прогона:
      // подменяя рутину через `over`, тест подменяет и прогон, и разъехавшийся ctx.runId
      // всплыл бы только в глаголах Задач 7–9. Явный `over.runId` уважается — он и есть
      // способ проверить расхождение нарочно.
      routine: over.routine ?? routine,
      runId: over.runId ?? (over.routine ?? routine).runId,
    };
  }

  /**
   * Рутина владельца. Заводится ЕГО же рукой (`owner`/`ui`): инвариант запрета по объекту
   * (V1.10) молчит только для источников владельца, и сид от имени рутины упирался бы в
   * него — то есть проверял бы не то, что нужно сьюту.
   */
  async function seedRoutine(owner: string, over: SeedRoutineOver = {}): Promise<string> {
    const e = await seedEntity(owner, {
      title: over.title ?? 'Утренний обзор',
      body: over.body ?? 'Пройди по задачам дня и предложи, что сделать.',
      tags: [],
      aspects: {
        'orbis/routine': { stage: 'active', at: '07:00', mode: 'propose', ...over.routine },
      },
    });
    return e.id;
  }

  /**
   * Прогон рутины — ровно тем батчем, которым его заведёт раннер (V1.3): детерминированные
   * id прогона и batch'а плюс связь `parent` рутина→прогон, всё одним `execute` от актора
   * `ai` с источником `system` (бухгалтерия прогона, рулинг Р-7). Сид прямыми вставками
   * разошёлся бы с боевым путём ровно в том, что проверяют глаголы: субъекте и связи.
   */
  async function seedRoutineRun(
    owner: string,
    args: SeedRoutineRunArgs,
  ): Promise<SeededRoutineRun> {
    const bucket = args.bucket ?? '2026-08-17T07:00';
    const attempt = args.attempt ?? 1;
    const runId = routineRunId(args.routineId, bucket, attempt);
    // Часы батча = момент старта прогона: `created_at` сущности берётся из них, а порядок
    // прогонов бакета (`runsForBucket`, история рутины) читается именно по нему — сид с
    // общим T0 давал бы двум попыткам одинаковый ключ сортировки.
    const startedAt = args.startedAt ?? T0;
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'ai',
      source: 'system',
      runId,
      batchId: routineRunBatchId(args.routineId, bucket, attempt),
      clock: () => startedAt,
      operations: [
        {
          tool: 'entity_create',
          input: {
            id: runId,
            title: `Прогон рутины ${bucket}`,
            tags: [],
            aspects: {
              'orbis/agent-run': {
                routine_id: args.routineId,
                bucket,
                attempt,
                outcome: 'running',
                started_at: iso(startedAt),
                last_step_at: iso(args.lastStepAt ?? startedAt),
                step_count: 0,
                steps: [],
                ...args.run,
              },
            },
          },
        },
        {
          tool: 'relation_create',
          input: { source_id: args.routineId, target_id: runId, relation_type: 'parent' },
        },
      ],
    });
    if (!r.ok) throw new Error(`seedRoutineRun: ${r.error.code} ${r.error.message}`);
    return { runId, bucket, attempt };
  }

  return {
    seedEntity,
    link,
    aspectsOf,
    childrenOf,
    actionsOf,
    workerGrant,
    worker,
    routineCtx,
    seedRoutine,
    seedRoutineRun,
  };
}
