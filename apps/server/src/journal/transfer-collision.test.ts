import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import { batchExecuteInput, type GraphId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { accountOf, adminDb, appDb, ensureGraphs, mintGraph, personal } from '../../test/helpers';
import { writeLegacyAction, writeLegacyUndo } from '../../test/legacy-journal';
import { ensureGlobalThread } from '../chat/threads';
import { applyMigrateSpeedA, reportMigrateSpeedA } from '../db/migrate-speed-a';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { isUndone } from '../executor/journal-read';
import type { ActionRecord } from '../executor/types';
import {
  legacyJournalReport,
  prospectiveJournalQuery,
  transferredLegacyMessageIds,
} from './transfer';

const { db, client } = appDb();
const { db: admin, client: adminClient } = adminDb();
const graphs: GraphId[] = [];
function recordFixture(g: GraphId) {
  graphs.push(g);
  const dir = process.env.ORBIS_TEST_AUDIT_DIR;
  if (dir) {
    fs.writeFileSync(`${dir}/transfer-active-graphs.json`, JSON.stringify(graphs));
    fs.appendFileSync(
      `${dir}/transfer-fixtures-${process.env.ORBIS_TEST_AUDIT_ATTEMPT ?? 'standalone'}.jsonl`,
      `${JSON.stringify({ id: g, beforeCreation: true })}\n`,
    );
  }
}
afterAll(async () => {
  try {
    await admin.transaction(async (cleanup) => {
      for (const g of graphs) {
        await cleanup.execute(
          sql`DELETE FROM chat_messages m USING chat_threads t WHERE m.thread_id=t.id AND t.graph_id=${g}::uuid`,
        );
        for (const table of [
          'chat_threads',
          'action_journal_entities',
          'action_journal',
          'entities',
          'graph_members',
        ])
          await cleanup.execute(sql`DELETE FROM ${sql.raw(table)} WHERE graph_id=${g}::uuid`);
        await cleanup.execute(sql`DELETE FROM graphs WHERE id=${g}::uuid`);
      }
    });
    const remaining = await admin.execute(
      sql`SELECT count(*)::int AS n FROM graphs WHERE id IN (${sql.join(
        graphs.map((g) => sql`${g}::uuid`),
        sql`, `,
      )})`,
    );
    expect(remaining[0]?.n).toBe(0);
    console.log(
      JSON.stringify({
        fixtureCleanup: graphs.length,
        ids: graphs,
        remainingGraphs: remaining[0]?.n,
      }),
    );
  } finally {
    await client.end();
    await adminClient.end();
  }
});

async function fixture(
  mode:
    | 'collision'
    | 'matching'
    | 'type'
    | 'target'
    | 'malformed'
    | 'clean'
    | 'action-occupied'
    | 'current-action',
) {
  const g = mintGraph(newId());
  recordFixture(g);
  await ensureGraphs([g]);
  const x = newId(),
    u = newId(),
    other = newId(),
    holder = newId();
  const seeded = await execute(db, {
    identity: personal(g),
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool: 'entity_create', input: { id: holder, title: 'after', tags: [] } }],
  });
  if (!seeded.ok) throw new Error(seeded.error.message);
  const packet = batchExecuteInput.parse({
    batch_id: x,
    operations: [{ tool: 'entity_update', input: { id: holder, title: 'after' } }],
  });
  await withIdentity(db, personal(g), async (tx) => {
    const thread = await ensureGlobalThread(tx, g);
    const action: ActionRecord = {
      id: x,
      entity_id: null,
      type: 'batch',
      actor_user_id: accountOf(g),
      actor_kind: 'owner',
      source: 'ui',
      mechanism: 'user',
      operations: packet.operations.map((op) => ({ op: op.tool, payload: op.input })),
      inverse: [{ op: 'entity_update', payload: { id: holder, title: 'before' } }],
    };
    const card = { tool: 'batch_execute', entity_id: null, title: 'legacy' };
    await writeLegacyAction(tx, { graphId: g, threadId: thread, action, card });
    await writeLegacyUndo(tx, {
      threadId: thread,
      undoes: mode === 'malformed' ? 'not-a-uuid' : x,
      messageId: u,
    });
    if (mode === 'collision')
      await writeLegacyAction(tx, {
        graphId: g,
        threadId: thread,
        action: { ...action, id: u },
        card,
      });
  });
  if (['matching', 'type', 'target', 'action-occupied', 'current-action'].includes(mode))
    await admin.execute(sql`INSERT INTO action_journal (graph_id,id,type,actor_user_id,actor_kind,source,mechanism,title,card_tool,operations,inverse,undoes)
 VALUES (${g}::uuid,${mode === 'action-occupied' || mode === 'current-action' ? x : u}::uuid,${mode === 'type' || mode === 'current-action' ? 'batch' : 'undo'},${g}::uuid,'owner','ui','user','occupied','undo','[]','[]',${mode === 'type' || mode === 'current-action' ? null : mode === 'target' ? other : mode === 'action-occupied' ? other : x}::uuid)`);
  return { g, x, u };
}
for (const mode of [
  'collision',
  'matching',
  'type',
  'target',
  'malformed',
  'clean',
  'action-occupied',
  'current-action',
] as const)
  test(`typed transfer representability ${mode}`, async () => {
    const { g, x, u } = await fixture(mode);
    const safe = mode === 'matching' || mode === 'clean' || mode === 'current-action';
    const before = await withIdentity(db, personal(g), (tx) => legacyJournalReport(tx, g));
    expect(before.untransferable).toBe(safe ? 0 : mode === 'action-occupied' ? 2 : 1);
    const report = await reportMigrateSpeedA(adminClient, g);
    expect(report.missingRequired).toBe(before.untransferable);
    const prospective = await withIdentity(db, personal(g), (tx) =>
      tx.execute(prospectiveJournalQuery(g)),
    );
    expect(
      prospective.filter((r) => r.id === u && r.type === 'undo' && r.undoes === x),
    ).toHaveLength(safe ? 1 : 0);
    if (!safe) {
      await expect(
        applyMigrateSpeedA(db, adminClient, personal(g), { sweepMessages: true }),
      ).rejects.toThrow('СТОП');
      const evidence = await admin.execute(
        sql`SELECT count(*)::int AS n FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE t.graph_id=${g}::uuid`,
      );
      expect(evidence[0]?.n).toBe(mode === 'collision' ? 3 : 2);
      expect(
        (await withIdentity(db, personal(g), (tx) => transferredLegacyMessageIds(tx, g))).includes(
          u,
        ),
      ).toBe(false);
    } else {
      await applyMigrateSpeedA(db, adminClient, personal(g), { sweepMessages: true });
      expect(await withIdentity(db, personal(g), (tx) => isUndone(tx, g, x))).toBe(true);
    }
  });

test('late namespace collision inside actual apply transaction stops and rolls back transferred actions', async () => {
  const { g, x, u } = await fixture('clean');
  const { client: late } = adminDb();
  let injected = false;
  const racing = new Proxy(adminClient, {
    get(target, key) {
      if (key === 'begin')
        return (callback: (tx: unknown) => Promise<unknown>) =>
          target.begin(async (transaction) =>
            callback(
              new Proxy(transaction, {
                get(tx, k) {
                  if (k === 'unsafe')
                    return async (query: string, params: never[]) => {
                      if (!injected && query.includes('INSERT INTO action_journal (graph_id')) {
                        injected = true;
                        await late.unsafe(
                          `INSERT INTO action_journal (graph_id,id,type,actor_user_id,actor_kind,source,mechanism,title,card_tool,operations,inverse) VALUES ($1::uuid,$2::uuid,'batch',$1::uuid,'owner','ui','user','occupied','batch_execute','[]','[]')`,
                          [g, u],
                        );
                      }
                      return tx.unsafe(query, params);
                    };
                  const value = Reflect.get(tx, k);
                  return typeof value === 'function' ? value.bind(tx) : value;
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as typeof adminClient;
  try {
    await expect(
      applyMigrateSpeedA(db, racing, personal(g), { sweepMessages: true }),
    ).rejects.toThrow('СТОП');
    expect(injected).toBe(true);
    const actions = await admin.execute(
      sql`SELECT id::text AS id FROM action_journal WHERE graph_id=${g}::uuid`,
    );
    expect(actions.map((r) => r.id)).toEqual([u]);
    expect(await withIdentity(db, personal(g), (tx) => isUndone(tx, g, x))).toBe(false);
  } finally {
    await late.end();
  }
});
test('beforeSweep changed Undo target retains unmatched old message evidence', async () => {
  const { g, u } = await fixture('clean');
  const target = newId();
  const { db: late, client: lateClient } = adminDb();
  try {
    const result = await applyMigrateSpeedA(db, adminClient, personal(g), {
      sweepMessages: true,
      beforeSweep: async () => {
        await late.execute(
          sql`UPDATE chat_messages SET metadata=jsonb_build_object('type','undo','undoes',${target}::text) WHERE id=${u}::uuid`,
        );
      },
    });
    expect(result.deletedMessages).toBe(1);
    const kept = await admin.execute(sql`SELECT metadata FROM chat_messages WHERE id=${u}::uuid`);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.metadata).toEqual({ type: 'undo', undoes: target });
  } finally {
    await lateClient.end();
  }
});
