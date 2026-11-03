import { afterAll, expect, test } from 'bun:test';
import { adminDb, appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { changeFeedStatus } from '../db/perf-report';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();
const { client } = adminDb();
const app = appDb();
afterAll(async () => {
  await Promise.all([client.end(), app.client.end()]);
});

test('committed feed storage and singleton floor are installed', async () => {
  const [row] = await client`SELECT to_regclass('public.change_feed')::text AS feed,
    to_regclass('public.change_feed_floor')::text AS floor`;
  expect(row).toEqual({ feed: 'change_feed', floor: 'change_feed_floor' });
});

test('NOTIFY folds multiple rows per graph, stays quiet on empty updates and rollback, and sends a global wake', async () => {
  const [a, b] = await Promise.all([freshGraph(), freshGraph()]);
  const listener = adminDb().client;
  const seen: Array<{ graphId?: string; txId?: string; marker?: string }> = [];
  const a1 = crypto.randomUUID();
  const a2 = crypto.randomUUID();
  const b1 = crypto.randomUUID();
  const definition = `test/${crypto.randomUUID()}`;
  const marker = crypto.randomUUID();
  let finish: () => void = () => {};
  const delivered = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    await listener.listen('orbis_changes', (payload) => {
      const message = JSON.parse(payload);
      if (message.marker === marker) finish();
      else seen.push(message);
    });
    const insertXid = await client.begin(async (tx) => {
      const [row] = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
      await tx`INSERT INTO entities (id, graph_id, title) VALUES
        (${a1}, ${a}, 'a1'), (${a2}, ${a}, 'a2'), (${b1}, ${b}, 'b1')`;
      return row?.xid;
    });
    const noOpXid = await client.begin(async (tx) => {
      const [row] = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
      await tx`UPDATE entities SET title = title WHERE graph_id IN (${a}, ${b})`;
      await tx`INSERT INTO entities (id, graph_id, title) VALUES (${a1}, ${a}, 'conflict')
        ON CONFLICT DO NOTHING`;
      return row?.xid;
    });
    let rollbackXid: string | undefined;
    const rollback = new Error('rollback');
    await expect(
      client.begin(async (tx) => {
        const [row] = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
        rollbackXid = row?.xid;
        await tx`UPDATE entities SET title = 'discarded' WHERE id = ${a1}`;
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const resetXid = await client.begin(async (tx) => {
      const [row] = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
      await tx`INSERT INTO subscription_definitions (id, surface, definition, rank) VALUES (${definition}, 'test', '{}', 900)`;
      return row?.xid;
    });
    await client`SELECT pg_notify('orbis_changes', ${JSON.stringify({ marker })})`;
    await delivered;
    expect(
      seen
        .filter((m) => m.txId === insertXid)
        .sort((x, y) => (x.graphId ?? '').localeCompare(y.graphId ?? '')),
    ).toEqual([a, b].sort().map((graphId) => ({ graphId, txId: insertXid })));
    expect(seen.filter((m) => m.txId === noOpXid || m.txId === rollbackXid)).toEqual([]);
    expect(seen.filter((m) => m.txId === resetXid)).toEqual([{ txId: resetXid }]);
    if (!rollbackXid) throw new Error('missing xid for rolled back transaction');
    const [rolledBack] =
      await client`SELECT count(*)::int AS n FROM public.change_feed WHERE tx_id = ${rollbackXid}::xid8`;
    expect(rolledBack?.n).toBe(0);
  } finally {
    await listener.end();
    await client`DELETE FROM subscription_definitions WHERE id = ${definition}`;
    await client`DELETE FROM entities WHERE id IN (${a1}, ${a2}, ${b1})`;
  }
});

test('the registered cron job atomically expires old rows and never lowers the floor', async () => {
  const graph = await freshGraph();
  const rollback = new Error('rollback');
  await expect(
    client.begin(async (tx) => {
      const jobs = await tx<
        { active: boolean; command: string }[]
      >`SELECT active, command FROM cron.job
      WHERE jobname = 'orbis_change_feed_cleanup'`;
      expect(jobs).toHaveLength(1);
      const [job] = jobs;
      if (!job) throw new Error('missing cleanup job');
      expect(job.active).toBe(true);
      await tx`TRUNCATE public.change_feed`;
      await tx`UPDATE public.change_feed_floor SET floor = '8'::xid8`;
      await tx`INSERT INTO public.change_feed (tx_id, graph_id, kind, row_key, entity_ids, operation, scope, at, graph_wide)
      VALUES ('11'::xid8, ${graph}, 'settings', 'old1', '{}', 'update', 'other', now() - interval '8 days', false),
      ('19'::xid8, ${graph}, 'settings', 'old2', '{}', 'update', 'other', now() - interval '7 days 1 hour', false),
      ('20'::xid8, ${graph}, 'settings', 'boundary', '{}', 'update', 'other', now() - interval '7 days', false),
      ('21'::xid8, ${graph}, 'settings', 'recent', '{}', 'update', 'other', now(), false)`;
      await tx.unsafe(job.command);
      expect([...(await tx`SELECT row_key FROM public.change_feed ORDER BY id`)]).toEqual([
        { row_key: 'boundary' },
        { row_key: 'recent' },
      ]);
      expect([...(await tx`SELECT floor::text FROM public.change_feed_floor`)]).toEqual([
        { floor: '20' },
      ]);
      await tx`UPDATE public.change_feed_floor SET floor = '30'::xid8`;
      await tx`UPDATE public.change_feed SET at = now() - interval '9 days' WHERE row_key = 'boundary'`;
      await tx.unsafe(job.command);
      await tx.unsafe(job.command);
      expect([...(await tx`SELECT floor::text FROM public.change_feed_floor`)]).toEqual([
        { floor: '30' },
      ]);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});

test('TRUNCATE raises the floor above its own transaction without adding scoped rows', async () => {
  const rollback = new Error('rollback');
  await expect(
    client.begin(async (tx) => {
      await tx`TRUNCATE registry_deltas`;
      const [row] = await tx<{ floor: string; xid: string; n: number }[]>`SELECT floor::text,
      pg_current_xact_id()::text AS xid,
      (SELECT count(*)::int FROM public.change_feed WHERE tx_id = pg_current_xact_id()) AS n
      FROM public.change_feed_floor`;
      expect(BigInt(row?.floor ?? '0')).toBe(BigInt(row?.xid ?? '0') + 1n);
      expect(row?.n).toBe(0);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});

test('real Undo of creation feeds both the archived entity and its journal action in one transaction', async () => {
  const graph = await freshGraph();
  const caller = createCallerFactory(appRouter)({
    identity: personal(graph),
    actorKind: 'owner',
    db: app.db,
    clientVersion: null,
  });
  const made = await caller.entity.create({
    input: { title: 'undo feed fixture', tags: [] },
    source: 'ui',
  });
  if (!made.actionId) throw new Error('entity creation did not return actionId');
  await caller.ai.undo({ actionId: made.actionId });
  expect((await caller.entity.get({ id: made.id })).entity.archived).toBe(true);
  const rows =
    await client`SELECT kind, operation, scope, entity_ids, graph_wide, tx_id::text FROM public.change_feed
    WHERE graph_id = ${graph} AND tx_id = (
      SELECT tx_id FROM public.change_feed WHERE graph_id = ${graph} AND row_key = ${made.id}
      AND kind = 'entity' AND operation = 'update' ORDER BY id DESC LIMIT 1
    ) ORDER BY id`;
  expect([...rows]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'entity',
        operation: 'update',
        scope: 'other',
        entity_ids: [made.id],
      }),
      expect.objectContaining({
        kind: 'journal',
        operation: 'insert',
        entity_ids: [made.id],
        graph_wide: false,
      }),
    ]),
  );
});

test('ops diagnostics observe a writing transaction and the scheduled cleanup in a read-only transaction', async () => {
  const writer = appDb().client;
  try {
    await writer.begin(async (tx) => {
      await tx`SELECT pg_current_xact_id()`;
      const lines = await client.begin('read only', changeFeedStatus);
      expect(lines[0]).toMatch(/старая пишущая транзакция: [0-9]+ с/);
      expect(lines[1]).toMatch(/orbis_change_feed_cleanup: активна/);
    });
  } finally {
    await writer.end();
  }
});
