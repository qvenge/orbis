// Прод-форма после 1в: старый журнал сообщениями; тела без колонок владения действиями плана А.
import { type GraphId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { ensureEntityThread, ensureGlobalThread } from '../src/chat/threads';
import { chatMessages, entities } from '../src/db/schema';
import { withIdentity } from '../src/db/with-identity';
import { execute } from '../src/executor/executor';
import type { ActionRecord, JournalSink } from '../src/executor/types';
import { createPending } from '../src/policy/pending';
import { effectiveRegistry } from '../src/registry/cache';
import { supplyCreateOps } from '../src/supply/records';
import { agentLoopHelpers } from '../src/test/agent-loop-helpers';
import { accountOf, adminDb, appDb, personal } from './helpers';
import { writeLegacyAction, writeLegacyUndo } from './legacy-journal';

export function legacyAction(graph: GraphId, patch: Partial<ActionRecord> = {}): ActionRecord {
  return {
    id: newId(),
    type: 'entity_updated',
    entity_id: null,
    actor_user_id: accountOf(graph),
    actor_kind: 'owner',
    source: 'ui',
    mechanism: 'user',
    operations: [],
    inverse: [],
    ...patch,
  };
}

export async function seedJournal1v(graph: GraphId) {
  const { db, client } = appDb();
  const { db: admin, client: adminClient } = adminDb();
  const equal = newId();
  const foreign = newId();
  const fastEntity = newId();
  const at = (n: number) => new Date(Date.UTC(2026, 8, 28, 12, 0, n));
  try {
    await admin.insert(entities).values([
      { id: equal, graphId: graph, title: 'Первая', body: 'после', tags: [] },
      { id: foreign, graphId: graph, title: 'Вторая', body: 'после', tags: [] },
      { id: fastEntity, graphId: graph, title: 'Быстрый ввод', tags: [] },
    ]);
    // Правка вне старого журнала не должна получить право на отмену чужого текста.
    await admin.execute(sql`UPDATE entities SET body = 'чужой текст' WHERE id = ${foreign}::uuid`);
    const bodyAction = (id: string) =>
      legacyAction(graph, {
        entity_id: id,
        operations: [{ op: 'entity_update', payload: { id, body: 'после' } }],
        inverse: [{ op: 'entity_update', payload: { id, body: 'до' } }],
      });
    const { seedRoutine, seedRoutineRun } = agentLoopHelpers(db);
    const routineId = await seedRoutine(graph);
    const { runId } = await seedRoutineRun(graph, {
      routineId,
      bucket: '2026-09-28T12:00',
      startedAt: at(0),
    });
    const a = {
      equal: bodyAction(equal),
      foreign: bodyAction(foreign),
      system: legacyAction(graph, {
        type: 'batch',
        source: 'system',
        mechanism: 'supply',
        operations: [{ op: 'entity_update', payload: { id: equal, title: 'Первая' } }],
        inverse: [],
      }),
      fast: legacyAction(graph, {
        type: 'entity_created',
        source: 'fast_path',
        entity_id: fastEntity,
        operations: [{ op: 'entity_create', payload: { id: fastEntity, title: 'Быстрый ввод' } }],
        inverse: [{ op: 'entity_update', payload: { id: fastEntity, archived: true } }],
      }),
      undone: legacyAction(graph, {
        entity_id: fastEntity,
        operations: [{ op: 'entity_update', payload: { id: fastEntity, title: 'Временно' } }],
        inverse: [{ op: 'entity_update', payload: { id: fastEntity, title: 'Быстрый ввод' } }],
      }),
      routine: legacyAction(graph, {
        source: 'routine',
        actor_kind: 'ai',
        run_id: runId,
        entity_id: equal,
        operations: [{ op: 'entity_update', payload: { id: equal, title: 'Первая' } }],
        inverse: [{ op: 'entity_update', payload: { id: equal, title: 'Прежняя' } }],
      }),
    };
    const threads = await withIdentity(db, personal(graph), async (tx) => ({
      global: await ensureGlobalThread(tx, graph),
      run: await ensureEntityThread(tx, graph, runId),
    }));
    const messages: string[] = [];
    for (const [i, name] of (['equal', 'foreign', 'system', 'fast', 'undone'] as const).entries()) {
      const action = a[name];
      messages.push(
        await withIdentity(db, personal(graph), (tx) =>
          writeLegacyAction(tx, {
            graphId: graph,
            threadId: threads.global,
            action,
            card: {
              tool: action.type === 'batch' ? 'batch_execute' : 'entity_update',
              entity_id: action.entity_id,
              title: name === 'fast' ? 'Быстрый ввод' : name,
            },
            createdAt: at(i + 1),
          }),
        ),
      );
    }
    const undoMessage = await withIdentity(db, personal(graph), (tx) =>
      writeLegacyUndo(tx, {
        threadId: threads.global,
        undoes: a.undone.id,
        createdAt: at(6),
      }),
    );
    messages.push(undoMessage);
    // Настоящие операции поставки и inverse исполнителя, но писатель журнала — прежний.
    let supply!: ActionRecord;
    const sink: JournalSink = {
      async write(tx, entry) {
        const { body_before: _body, text_session: _session, ...old } = entry.action;
        supply = old;
        messages.push(
          await writeLegacyAction(tx, {
            graphId: graph,
            action: old,
            card: entry.card,
            results: entry.results,
            createdAt: at(7),
          }),
        );
      },
      async writeUndo() {
        throw new Error('фикстура не отменяет поставку');
      },
      async findBatchWrite() {
        return undefined;
      },
    };
    const reg = await withIdentity(db, personal(graph), (tx) => effectiveRegistry(tx, graph));
    const created = await execute(
      db,
      {
        identity: personal(graph),
        actorKind: 'owner',
        source: 'ui',
        mechanism: 'supply',
        batchId: newId(),
        operations: supplyCreateOps(graph, ['records'], () => null, reg),
      },
      { sink },
    );
    if (!created.ok) throw new Error(created.error.message);
    // До плана А создание не имело body_action_id; INSERT нынешней схемы воспроизвёл бы новый контракт.
    await admin.execute(
      sql`UPDATE entities SET body_action_id = NULL WHERE graph_id = ${graph}::uuid`,
    );
    messages.push(
      await withIdentity(db, personal(graph), (tx) =>
        writeLegacyAction(tx, {
          graphId: graph,
          threadId: threads.run,
          action: a.routine,
          card: { tool: 'entity_update', entity_id: equal, title: 'Рутина' },
          createdAt: at(8),
        }),
      ),
    );
    const pending = await withIdentity(db, personal(graph), (tx) =>
      createPending(tx, {
        actor: { graphId: graph, kind: 'ai', source: 'routine', runId: a.routine.run_id },
        threadId: threads.run,
        tool: 'entity_update',
        input: { id: equal, body: 'предложение', expectedUpdatedAt: at(1).toISOString() },
        level: 'explicit-confirmation',
        clock: () => at(9),
      }),
    );
    const conversation = newId();
    await withIdentity(db, personal(graph), (tx) =>
      tx.insert(chatMessages).values({
        id: conversation,
        threadId: threads.global,
        role: 'user',
        content: 'Разговор остаётся',
        metadata: {},
      }),
    );
    return {
      equal,
      foreign,
      fastEntity,
      actions: { ...a, supply },
      messages,
      undoMessage,
      pending: pending.pendingId,
      conversation,
      threads,
    };
  } finally {
    await client.end();
    await adminClient.end();
  }
}
