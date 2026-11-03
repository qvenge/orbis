import { afterAll, expect, test } from 'bun:test';
import type postgres from 'postgres';
import { adminDb, freshGraph, requireEnv } from '../../test/helpers';

requireEnv();
const { client } = adminDb();
afterAll(() => client.end());

type Tx = postgres.TransactionSql;
type FeedRow = {
  graph_id: string;
  kind: string;
  row_key: string;
  operation: string;
  scope: string;
  entity_ids: string[];
  thread_id: string | null;
  graph_wide: boolean;
};
const id = () => crypto.randomUUID();
class Rollback extends Error {}

async function probe(run: (tx: Tx) => Promise<void>) {
  try {
    await client.begin(async (tx) => {
      await run(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

async function changes(tx: Tx, kind: string): Promise<FeedRow[]> {
  return [
    ...(await tx<FeedRow[]>`
      SELECT graph_id, kind, row_key, operation, scope, entity_ids, thread_id, graph_wide
      FROM public.change_feed WHERE tx_id = pg_current_xact_id() AND kind = ${kind} ORDER BY id`),
  ];
}

async function floor(tx: Tx): Promise<bigint> {
  const [row] = await tx<{ floor: string }[]>`SELECT floor::text FROM public.change_feed_floor`;
  if (!row) throw new Error('missing feed floor');
  return BigInt(row.floor);
}

test('entity writes report affected backlinks, distinguish body and skip empty statements', async () => {
  const graph = await freshGraph();
  const [entity, oldRef, kept, newRef, other] = Array.from({ length: 5 }, id) as [
    string,
    string,
    string,
    string,
    string,
  ];
  await probe(async (tx) => {
    await tx`INSERT INTO entities (id, graph_id, title) VALUES
      (${oldRef}, ${graph}, 'old backlink'), (${kept}, ${graph}, 'retained backlink'),
      (${newRef}, ${graph}, 'new backlink')`;
    await tx`INSERT INTO entities (id, graph_id, title, body_refs) VALUES
      (${entity}, ${graph}, 'one', ARRAY[${oldRef}, ${kept}, 'legacy-invalid']),
      (${other}, ${graph}, 'two', '{}')`;
    await tx`INSERT INTO entities (id, graph_id, title) VALUES (${entity}, ${graph}, 'conflict')
      ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO entities (id, graph_id, title) SELECT id, graph_id, title FROM entities WHERE false`;
    await tx`UPDATE entities SET title = title WHERE graph_id = ${graph}`;
    await tx`DELETE FROM entities WHERE id = ${id()}`;
    const inserts = (await changes(tx, 'entity')).filter((r) =>
      [entity, other].includes(r.row_key),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts.find((r) => r.row_key === entity)).toMatchObject({
      graph_id: graph,
      operation: 'insert',
      scope: 'other',
      entity_ids: [entity, oldRef, kept].sort(),
    });

    await tx`UPDATE entities SET body = 'new', body_refs = ARRAY[${kept}, ${newRef}],
      query_refs = ARRAY['orbis/date'], updated_at = clock_timestamp() WHERE id = ${entity}`;
    await tx`UPDATE entities SET body = 'again', title = 'also a title change' WHERE id = ${entity}`;
    await tx`DELETE FROM entities WHERE id = ${entity}`;
    expect((await changes(tx, 'entity')).filter((r) => r.row_key === entity).slice(1)).toEqual([
      expect.objectContaining({
        operation: 'update',
        scope: 'body',
        entity_ids: [entity, oldRef, newRef].sort(),
      }),
      expect.objectContaining({ operation: 'update', scope: 'other', entity_ids: [entity] }),
      expect.objectContaining({
        operation: 'delete',
        scope: 'other',
        entity_ids: [entity, kept, newRef].sort(),
      }),
    ]);
  });
});

test('entity key and graph changes address both old and new scopes', async () => {
  const [a, b] = await Promise.all([freshGraph(), freshGraph()]);
  const old = id();
  const next = id();
  await probe(async (tx) => {
    await tx`INSERT INTO entities (id, graph_id, title) VALUES (${old}, ${a}, 'moving')`;
    await tx`UPDATE entities SET id = ${next}, graph_id = ${b} WHERE id = ${old}`;
    expect((await changes(tx, 'entity')).slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          graph_id: a,
          row_key: old,
          operation: 'delete',
          entity_ids: [old],
        }),
        expect.objectContaining({
          graph_id: b,
          row_key: next,
          operation: 'insert',
          entity_ids: [next],
        }),
      ]),
    );
    expect(await changes(tx, 'entity')).toHaveLength(3);
  });
});

test('relation update affects both endpoint sets and cascade resolves the surviving target', async () => {
  const graph = await freshGraph();
  const [source, before, target, edge] = [id(), id(), id(), id()];
  await probe(async (tx) => {
    await tx`INSERT INTO entities (id, graph_id, title) VALUES
      (${source}, ${graph}, 'source'), (${before}, ${graph}, 'old'), (${target}, ${graph}, 'new')`;
    await tx`INSERT INTO relations (id, source_id, target_id, role) VALUES
      (${edge}, ${source}, ${before}, 'parent')`;
    await tx`UPDATE relations SET target_id = ${target} WHERE id = ${edge}`;
    await tx`DELETE FROM entities WHERE id = ${source}`;
    const events = await changes(tx, 'relation');
    expect(events.map((r) => [r.graph_id, r.row_key, r.operation, r.entity_ids])).toEqual([
      [graph, edge, 'insert', [source, before].sort()],
      [graph, edge, 'update', [source, before, target].sort()],
      [graph, edge, 'delete', [source, target].sort()],
    ]);
  });
});

test('deleting both relation endpoints in a single statement raises the global floor', async () => {
  const graph = await freshGraph();
  const [source, target, edge] = [id(), id(), id()];
  await probe(async (tx) => {
    const initial = await floor(tx);
    await tx`INSERT INTO entities (id, graph_id, title) VALUES
      (${source}, ${graph}, 'source'), (${target}, ${graph}, 'target')`;
    await tx`INSERT INTO relations (id, source_id, target_id, role) VALUES
      (${edge}, ${source}, ${target}, 'parent')`;
    await tx`DELETE FROM entities WHERE id IN (${source}, ${target})`;
    const [xid] = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
    expect(await floor(tx)).toBe(BigInt(xid?.xid ?? '0') + 1n);
    expect(await floor(tx)).toBeGreaterThan(initial);
    expect((await changes(tx, 'relation')).map((r) => r.operation)).toEqual(['insert']);
  });
});

test('version, thread and message metadata retain old and new anchors', async () => {
  const graph = await freshGraph();
  const [a, b, version, first, second, message] = [id(), id(), id(), id(), id(), id()];
  await probe(async (tx) => {
    await tx`INSERT INTO entities (id, graph_id, title) VALUES
      (${a}, ${graph}, 'a'), (${b}, ${graph}, 'b')`;
    await tx`INSERT INTO entity_versions (id, graph_id, entity_id, label, body, actor_user_id, actor_kind)
      VALUES (${version}, ${graph}, ${a}, 'before', 'secret', ${graph}, 'owner')`;
    await tx`UPDATE entity_versions SET entity_id = ${b} WHERE id = ${version}`;
    await tx`DELETE FROM entity_versions WHERE id = ${version}`;
    expect((await changes(tx, 'version')).map((r) => [r.operation, r.entity_ids])).toEqual([
      ['insert', [a]],
      ['update', [a, b].sort()],
      ['delete', [b]],
    ]);

    await tx`INSERT INTO chat_threads (id, graph_id, entity_id) VALUES
      (${first}, ${graph}, ${a}), (${second}, ${graph}, ${b})`;
    await tx`INSERT INTO chat_messages (id, thread_id, role, content) VALUES
      (${message}, ${first}, 'user', 'secret')`;
    await tx`UPDATE chat_messages SET thread_id = ${second} WHERE id = ${message}`;
    await tx`DELETE FROM chat_messages WHERE id = ${message}`;
    expect(await changes(tx, 'message')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          graph_id: graph,
          thread_id: first,
          operation: 'insert',
          entity_ids: [a],
        }),
        expect.objectContaining({
          graph_id: graph,
          thread_id: first,
          operation: 'delete',
          entity_ids: [a],
        }),
        expect.objectContaining({
          graph_id: graph,
          thread_id: second,
          operation: 'insert',
          entity_ids: [b],
        }),
        expect.objectContaining({
          graph_id: graph,
          thread_id: second,
          operation: 'delete',
          entity_ids: [b],
        }),
      ]),
    );
    expect(await changes(tx, 'message')).toHaveLength(4);
    await tx`DELETE FROM chat_threads WHERE id = ${second}`;
    await tx`UPDATE chat_threads SET entity_id = ${b} WHERE id = ${first}`;
    expect(await changes(tx, 'thread')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          thread_id: first,
          operation: 'update',
          entity_ids: [a, b].sort(),
        }),
        expect.objectContaining({ thread_id: second, operation: 'delete', entity_ids: [b] }),
      ]),
    );
  });
});

test('journal resolves living and deleted edge IDs without exposing them as entity IDs', async () => {
  const graph = await freshGraph();
  const [a, b, c, edge, removed, thread, action, unknown, incomplete] = [
    id(),
    id(),
    id(),
    id(),
    id(),
    id(),
    id(),
    id(),
    id(),
  ];
  await probe(async (tx) => {
    await tx`INSERT INTO entities (id, graph_id, title) VALUES
      (${a}, ${graph}, 'a'), (${b}, ${graph}, 'b'), (${c}, ${graph}, 'c')`;
    await tx`INSERT INTO chat_threads (id, graph_id, entity_id) VALUES (${thread}, ${graph}, ${c})`;
    await tx`INSERT INTO relations (id, source_id, target_id, role) VALUES
      (${edge}, ${a}, ${c}, 'parent'), (${removed}, ${b}, ${c}, 'parent')`;
    await tx`DELETE FROM entities WHERE id = ${b}`;
    await tx`INSERT INTO action_journal
      (graph_id, id, type, actor_user_id, actor_kind, source, mechanism, thread_id, title, card_tool, entity_ids, operations, inverse)
      VALUES
      (${graph}, ${action}, 'mutation', ${graph}, 'owner', 'test', 'test', ${thread}, 'test', 'test',
        ARRAY[${edge}::uuid, ${removed}::uuid], '[]', '[]'),
      (${graph}, ${incomplete}, 'mutation', ${graph}, 'owner', 'test', 'test', NULL, 'test', 'test',
        ARRAY[${unknown}::uuid], '[]', '[]')`;
    expect(await changes(tx, 'journal')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row_key: action,
          thread_id: thread,
          entity_ids: [a, b, c].sort(),
          graph_wide: false,
        }),
        expect.objectContaining({
          row_key: incomplete,
          thread_id: null,
          entity_ids: [],
          graph_wide: true,
        }),
      ]),
    );
    await tx`UPDATE action_journal SET title = 'changed' WHERE id = ${action}`;
    await tx`DELETE FROM action_journal WHERE id = ${action}`;
    expect((await changes(tx, 'journal')).slice(2).map((r) => [r.operation, r.entity_ids])).toEqual(
      [
        ['update', [a, b, c].sort()],
        ['delete', [a, b, c].sort()],
      ],
    );
  });
});

test('registry changes use NULL-safe graph keys and invalidate global data without scoped rows', async () => {
  const [a, b] = await Promise.all([freshGraph(), freshGraph()]);
  const key = `test/${id()}`;
  await probe(async (tx) => {
    await tx`INSERT INTO subscription_definitions (id, graph_id, surface, definition, rank) VALUES
      (${key}, ${a}, 'test', '{}', 900), (${key}, NULL, 'test', '{}', 900)`;
    const [xid] = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
    expect(await floor(tx)).toBe(BigInt(xid?.xid ?? '0') + 1n);
    const scoped = await changes(tx, 'registry');
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({ graph_id: a, operation: 'insert' });
    await tx`UPDATE subscription_definitions SET definition = definition WHERE id = ${key}`;
    expect(await changes(tx, 'registry')).toEqual(scoped);
    await tx`UPDATE subscription_definitions SET graph_id = ${b} WHERE id = ${key} AND graph_id = ${a}`;
    const moved = (await changes(tx, 'registry')).slice(1);
    expect(moved.map((r) => [r.graph_id, r.operation]).sort()).toEqual(
      [
        [a, 'delete'],
        [b, 'insert'],
      ].sort(),
    );
    await tx`UPDATE registry_system SET version = version + 1`;
    expect(await changes(tx, 'registry')).toHaveLength(3);
  });
});

test('settings and registry deltas report the actual changed graph and natural key', async () => {
  const graph = await freshGraph();
  const delta = id();
  await probe(async (tx) => {
    await tx`INSERT INTO user_settings (graph_id) VALUES (${graph})`;
    await tx`UPDATE user_settings SET timezone = 'UTC' WHERE graph_id = ${graph}`;
    await tx`DELETE FROM user_settings WHERE graph_id = ${graph}`;
    expect(
      (await changes(tx, 'settings')).map((r) => [r.graph_id, r.row_key, r.operation]),
    ).toEqual([
      [graph, graph, 'insert'],
      [graph, graph, 'update'],
      [graph, graph, 'delete'],
    ]);

    await tx`INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
      VALUES (${delta}, ${graph}, 'property', 'test/old', 1, '{}')`;
    await tx`UPDATE registry_deltas SET target_id = 'test/new' WHERE id = ${delta}`;
    const events = await changes(tx, 'registry');
    expect(events).toHaveLength(3);
    expect(events.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          graph_id: graph,
          row_key: events[0]?.row_key,
          operation: 'delete',
        }),
        expect.objectContaining({ graph_id: graph, operation: 'insert' }),
      ]),
    );
    expect(events.slice(1).find((r) => r.operation === 'insert')?.row_key).not.toBe(
      events[0]?.row_key,
    );
    await tx`DELETE FROM registry_deltas WHERE id = ${delta}`;
    expect((await changes(tx, 'registry')).at(-1)).toMatchObject({
      graph_id: graph,
      operation: 'delete',
    });
  });
});

test('an unchanged system row and an unchanged NULL-key definition do not reset', async () => {
  await probe(async (tx) => {
    const before = await floor(tx);
    await tx`UPDATE registry_system SET version = version`;
    await tx`UPDATE aspect_definitions SET label = label WHERE graph_id IS NULL`;
    expect(await floor(tx)).toBe(before);
    expect(await changes(tx, 'registry')).toEqual([]);
  });
});

test('deleting a thread with its messages resets and preserves the old journal thread key', async () => {
  const graph = await freshGraph();
  const [thread, message, journal] = [id(), id(), id()];
  await probe(async (tx) => {
    await tx`INSERT INTO chat_threads (id, graph_id) VALUES (${thread}, ${graph})`;
    await tx`INSERT INTO chat_messages (id, thread_id, role, content)
      VALUES (${message}, ${thread}, 'user', 'fixture')`;
    await tx`INSERT INTO action_journal
      (graph_id, id, type, actor_user_id, actor_kind, source, mechanism, thread_id, title, card_tool, operations, inverse)
      VALUES (${graph}, ${journal}, 'mutation', ${graph}, 'owner', 'test', 'test', ${thread}, 'test', 'test', '[]', '[]')`;
    await tx`WITH removed AS (DELETE FROM chat_messages WHERE id = ${message} RETURNING id)
      DELETE FROM chat_threads WHERE id = ${thread} AND EXISTS (SELECT FROM removed)`;
    const [xid] = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
    expect(await floor(tx)).toBe(BigInt(xid?.xid ?? '0') + 1n);
    expect((await changes(tx, 'message')).map((r) => r.operation)).toEqual(['insert']);
    expect((await changes(tx, 'journal')).slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          graph_id: graph,
          row_key: journal,
          thread_id: thread,
          operation: 'delete',
        }),
        expect.objectContaining({
          graph_id: graph,
          row_key: journal,
          thread_id: null,
          operation: 'insert',
        }),
      ]),
    );
  });
});

async function asGraph(tx: Tx, graph: string, run: () => Promise<void>) {
  await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: graph, graph })}, true)`;
  await tx`SET LOCAL ROLE authenticated`;
  try {
    await run();
  } finally {
    await tx`RESET ROLE`;
  }
}

test('authenticated feed exposes only proved backlinks and treats foreign and absent refs alike', async () => {
  const [a, b] = await Promise.all([freshGraph(), freshGraph()]);
  const [row, same, foreign, absent] = [id(), id(), id(), id()];
  await probe(async (tx) => {
    await tx`INSERT INTO entities (id, graph_id, title) VALUES
      (${row}, ${a}, 'source'), (${same}, ${a}, 'same'), (${foreign}, ${b}, 'foreign')`;
    await tx`UPDATE entities SET body_refs = ARRAY[${same}, ${foreign}] WHERE id = ${row}`;
    await tx`UPDATE entities SET body_refs = ARRAY[${same}, ${absent}] WHERE id = ${row}`;
    await asGraph(tx, a, async () => {
      const updates = (await changes(tx, 'entity')).filter(
        (r) => r.row_key === row && r.operation === 'update',
      );
      expect(
        updates.map(({ entity_ids, graph_wide, scope }) => [entity_ids, graph_wide, scope]),
      ).toEqual([
        [[row, same].sort(), true, 'body'],
        [[row], true, 'body'],
      ]);
    });
  });
});

test('authenticated version, message and thread events omit an anchor moved to another graph', async () => {
  const [a, b] = await Promise.all([freshGraph(), freshGraph()]);
  const [anchor, thread, version, message] = [id(), id(), id(), id()];
  await probe(async (tx) => {
    await tx`INSERT INTO entities (id, graph_id, title) VALUES (${anchor}, ${a}, 'anchor')`;
    await tx`INSERT INTO chat_threads (id, graph_id, entity_id) VALUES (${thread}, ${a}, ${anchor})`;
    await tx`INSERT INTO entity_versions (id, graph_id, entity_id, label, body, actor_user_id, actor_kind)
      VALUES (${version}, ${a}, ${anchor}, 'before', '', ${a}, 'owner')`;
    await tx`UPDATE entities SET graph_id = ${b} WHERE id = ${anchor}`;
    await tx`UPDATE entity_versions SET label = 'after' WHERE id = ${version}`;
    await tx`INSERT INTO chat_messages (id, thread_id, role, content)
      VALUES (${message}, ${thread}, 'user', 'message')`;
    await tx`DELETE FROM chat_messages WHERE id = ${message}`;
    await tx`DELETE FROM chat_threads WHERE id = ${thread}`;
    await asGraph(tx, a, async () => {
      expect((await changes(tx, 'version')).at(-1)).toMatchObject({
        row_key: version,
        operation: 'update',
        entity_ids: [],
        graph_wide: true,
      });
      expect((await changes(tx, 'message')).at(-1)).toMatchObject({
        row_key: message,
        operation: 'delete',
        thread_id: thread,
        entity_ids: [],
        graph_wide: true,
      });
      expect((await changes(tx, 'thread')).at(-1)).toMatchObject({
        row_key: thread,
        operation: 'delete',
        thread_id: thread,
        entity_ids: [],
        graph_wide: true,
      });
    });
  });
});

test('authenticated journal preserves a same-graph deleted thread and hides foreign or moved parents', async () => {
  const [a, b] = await Promise.all([freshGraph(), freshGraph()]);
  const [same, foreign, moved, anchor, sameAction, foreignAction, movedAction] = [
    id(),
    id(),
    id(),
    id(),
    id(),
    id(),
    id(),
  ];
  await probe(async (tx) => {
    await tx`INSERT INTO entities (id, graph_id, title) VALUES (${anchor}, ${a}, 'anchor')`;
    await tx`INSERT INTO chat_threads (id, graph_id, entity_id) VALUES
      (${same}, ${a}, NULL), (${foreign}, ${b}, NULL), (${moved}, ${a}, ${anchor})`;
    await tx`INSERT INTO action_journal
      (graph_id, id, type, actor_user_id, actor_kind, source, mechanism, thread_id, title, card_tool, operations, inverse)
      VALUES
      (${a}, ${sameAction}, 'mutation', ${a}, 'owner', 'test', 'test', ${same}, 'test', 'test', '[]', '[]'),
      (${a}, ${foreignAction}, 'mutation', ${a}, 'owner', 'test', 'test', ${foreign}, 'test', 'test', '[]', '[]'),
      (${a}, ${movedAction}, 'mutation', ${a}, 'owner', 'test', 'test', ${moved}, 'test', 'test', '[]', '[]')`;
    const [cut] = await tx<{ id: string }[]>`SELECT max(id)::text AS id FROM public.change_feed`;
    if (!cut) throw new Error('missing feed boundary');
    await tx`UPDATE chat_threads SET graph_id = ${b} WHERE id = ${moved}`;
    await tx`DELETE FROM chat_threads WHERE id IN (${same}, ${foreign}, ${moved})`;
    await asGraph(tx, a, async () => {
      const rows = await tx<
        Pick<FeedRow, 'row_key' | 'operation' | 'thread_id' | 'graph_wide'>[]
      >`SELECT row_key, operation, thread_id, graph_wide FROM public.change_feed
        WHERE kind = 'journal' AND id > ${cut.id}::bigint ORDER BY id`;
      expect(rows.filter((r) => r.row_key === sameAction)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: 'delete', thread_id: same, graph_wide: false }),
          expect.objectContaining({ operation: 'insert', thread_id: null, graph_wide: false }),
        ]),
      );
      for (const action of [foreignAction, movedAction]) {
        expect(rows.filter((r) => r.row_key === action)).toEqual([
          { row_key: action, operation: 'update', thread_id: null, graph_wide: true },
        ]);
      }
    });
  });
});

test.each([
  false,
  true,
])('relation cascade uses the latest actual parent graph (move back: %s)', async (moveBack) => {
  const [a, b] = await Promise.all([freshGraph(), freshGraph()]);
  const [source, target, edge] = [id(), id(), id()];
  await probe(async (tx) => {
    const before = await floor(tx);
    await tx`INSERT INTO entities (id, graph_id, title) VALUES
      (${source}, ${a}, 'source'), (${target}, ${a}, 'target')`;
    await tx`INSERT INTO relations (id, source_id, target_id, role) VALUES
      (${edge}, ${source}, ${target}, 'parent')`;
    await tx`UPDATE entities SET graph_id = ${b} WHERE id = ${source}`;
    if (moveBack) await tx`UPDATE entities SET graph_id = ${a} WHERE id = ${source}`;
    await tx`DELETE FROM entities WHERE id = ${source}`;
    await asGraph(tx, a, async () => {
      const deleted = (await changes(tx, 'relation')).filter((r) => r.operation === 'delete');
      if (moveBack) {
        expect(deleted).toEqual([
          expect.objectContaining({ row_key: edge, entity_ids: [source, target].sort() }),
        ]);
        expect(await floor(tx)).toBe(before);
      } else {
        expect(deleted).toEqual([]);
        expect(await floor(tx)).toBeGreaterThan(before);
      }
    });
  });
});

test('journal does not reuse entity or edge events from before a cross-graph move', async () => {
  const [a, b] = await Promise.all([freshGraph(), freshGraph()]);
  const [source, target, edge, action] = [id(), id(), id(), id()];
  await probe(async (tx) => {
    await tx`INSERT INTO entities (id, graph_id, title) VALUES
      (${source}, ${a}, 'source'), (${target}, ${a}, 'target')`;
    await tx`INSERT INTO relations (id, source_id, target_id, role) VALUES
      (${edge}, ${source}, ${target}, 'parent')`;
    await tx`UPDATE entities SET graph_id = ${b} WHERE id = ${source}`;
    await tx`INSERT INTO action_journal
      (graph_id, id, type, actor_user_id, actor_kind, source, mechanism, entity_ids, title, card_tool, operations, inverse)
      VALUES (${a}, ${action}, 'mutation', ${a}, 'owner', 'test', 'test', ARRAY[${source}::uuid, ${edge}::uuid],
        'test', 'test', '[]', '[]')`;
    await asGraph(tx, a, async () => {
      expect(await changes(tx, 'journal')).toEqual([
        expect.objectContaining({ row_key: action, entity_ids: [], graph_wide: true }),
      ]);
    });
  });
});
