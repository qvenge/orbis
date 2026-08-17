// apps/server/src/agent-loop/test-helpers.ts
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
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { chatMessages, chatThreads, entities, relations } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { ActionRecord, WireEntity } from '../executor/types';
import { issuePatGrant, verifyBearer } from '../oauth/grants';
import type { ToolCallCtx } from '../tools/dispatch';

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

  return { seedEntity, link, aspectsOf, childrenOf, actionsOf, workerGrant, worker };
}
