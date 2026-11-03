import { afterAll, expect, test } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import type { TransactionSql } from 'postgres';
import { adminDb, appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { appRouter } from '../router';
import { readChanges } from './feed';

requireEnv();
const app = appDb();
const admin = adminDb().client;
const holder = adminDb().client;
const lateHolder = adminDb().client;
afterAll(() => Promise.all([app.client.end(), admin.end(), holder.end(), lateHolder.end()]));

function reconcile(graph: GraphId, from: string) {
  return appRouter
    .createCaller({
      db: app.db,
      identity: personal(graph),
      actorKind: 'owner',
      clientVersion: null,
    })
    .changes.reconcile({ from });
}

async function checkpoint(graph: GraphId) {
  return (await reconcile(graph, '0')).watermark;
}

async function xidOf(tx: TransactionSql) {
  const [row] = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
  if (!row) throw new Error('отсутствует xid');
  return row.xid;
}

async function insertEntity(tx: TransactionSql, graph: GraphId, id: string) {
  await tx`INSERT INTO entities (id, graph_id, title) VALUES (${id}, ${graph}, 'reconcile')`;
}

async function reset(tx: TransactionSql) {
  await tx`UPDATE registry_system SET version = version + 1 WHERE id = 1`;
}

function hold(
  client: typeof holder,
  before: (tx: TransactionSql) => Promise<void>,
  after?: (tx: TransactionSql) => Promise<void>,
) {
  const ready = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const finished = client.begin(async (tx) => {
    const xid = await xidOf(tx);
    await before(tx);
    ready.resolve(xid);
    await release.promise;
    await after?.(tx);
  });
  void finished.catch(ready.reject);
  return { xid: ready.promise, release: release.resolve, finished };
}

test('ранний xid держит поздний commit, обе транзакции приходят один раз', async () => {
  const graph = await freshGraph();
  const from = await checkpoint(graph);
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const a = hold(holder, (tx) => insertEntity(tx, graph, first));
  let b: string;
  try {
    const aId = await a.xid;
    b = await admin.begin(async (tx) => {
      await insertEntity(tx, graph, second);
      return xidOf(tx);
    });
    expect(BigInt(b)).toBeGreaterThan(BigInt(aId));
    const { page: held, targetXid } = await withIdentity(app.db, personal(graph), (tx) =>
      readChanges(tx, { from }),
    );
    expect(held.watermark).toBe(aId);
    expect(BigInt(targetXid)).toBeGreaterThanOrEqual(BigInt(b));
    expect(held.transactions).toEqual([]);
    expect(held.reset).toBeNull();
  } finally {
    a.release();
    await a.finished;
  }

  const page = await reconcile(graph, from);
  expect(page.reset).toBeNull();
  expect(page.transactions).toEqual([
    { txId: await a.xid, changes: [expect.objectContaining({ kind: 'entity', rowKey: first })] },
    { txId: b, changes: [expect.objectContaining({ kind: 'entity', rowKey: second })] },
  ]);
  expect((await reconcile(graph, page.watermark)).transactions).toEqual([]);
});

test('другой граф держит xmin, откат и чужой feed не попадают в диапазон', async () => {
  const [graph, foreign] = await Promise.all([freshGraph(), freshGraph()]);
  const from = await checkpoint(graph);
  const rollback = new Error('fixture rollback');
  const a = hold(
    holder,
    (tx) => insertEntity(tx, foreign, crypto.randomUUID()),
    async () => {
      throw rollback;
    },
  );
  let b: string;
  try {
    const aId = await a.xid;
    await admin.begin((tx) => insertEntity(tx, foreign, crypto.randomUUID()));
    b = await admin.begin(async (tx) => {
      await insertEntity(tx, graph, crypto.randomUUID());
      return xidOf(tx);
    });
    const held = await reconcile(graph, from);
    expect(held.watermark).toBe(aId);
    expect(held.transactions).toEqual([]);
  } finally {
    a.release();
    await expect(a.finished).rejects.toBe(rollback);
  }
  expect((await reconcile(graph, from)).transactions.map((t) => t.txId)).toEqual([b]);
});

test('оба provisional floor и поздний reset с меньшим xid покрываются complete refresh', async () => {
  const graph = await freshGraph();
  const from = await checkpoint(graph);
  const entity = crypto.randomUUID();
  const a = hold(holder, (tx) => insertEntity(tx, graph, entity));
  const caller = appRouter.createCaller({
    db: app.db,
    identity: personal(graph),
    actorKind: 'owner',
    clientVersion: null,
  });
  let late: ReturnType<typeof hold> | undefined;
  let lastFloor: string;
  let heldWatermark: string;
  try {
    const aId = await a.xid;
    late = hold(lateHolder, async () => {}, reset);
    const lateId = await late.xid;
    await admin.begin(reset);
    const f1 = await reconcile(graph, from);
    expect(f1.watermark).toBe(aId);
    heldWatermark = f1.watermark;
    expect(f1.reset).toEqual({
      reason: 'floor',
      token: `floor:${f1.floor}:provisional`,
      phase: 'provisional',
    });
    expect(f1.transactions).toEqual([]);
    expect(await reconcile(graph, heldWatermark)).toEqual(f1);
    await expect(caller.entity.get({ id: entity })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await admin.begin(reset);
    const f2 = await reconcile(graph, heldWatermark);
    lastFloor = f2.floor;
    expect(f2.watermark).toBe(heldWatermark);
    expect(BigInt(lastFloor)).toBeGreaterThan(BigInt(f1.floor));
    expect(BigInt(lastFloor)).toBeGreaterThan(BigInt(lateId));
    expect(f2.reset).toEqual({
      reason: 'floor',
      token: `floor:${lastFloor}:provisional`,
      phase: 'provisional',
    });
    late.release();
    await late.finished;
    expect(await reconcile(graph, heldWatermark)).toEqual(f2);
  } finally {
    late?.release();
    a.release();
    await Promise.all([late?.finished, a.finished]);
  }

  const complete = await reconcile(graph, heldWatermark);
  expect(BigInt(complete.watermark)).toBeGreaterThanOrEqual(BigInt(lastFloor));
  expect(complete.reset).toEqual({
    reason: 'floor',
    token: `floor:${lastFloor}:complete`,
    phase: 'complete',
  });
  expect(complete.transactions).toEqual([]);
  expect(await reconcile(graph, heldWatermark)).toEqual(complete);
  expect((await caller.entity.get({ id: entity })).entity.id).toBe(entity);

  const next = crypto.randomUUID();
  await admin.begin((tx) => insertEntity(tx, graph, next));
  const deltas = await reconcile(graph, complete.watermark);
  expect(deltas.reset).toBeNull();
  expect(deltas.transactions.flatMap((t) => t.changes.map((c) => c.rowKey))).toEqual([next]);
});

test('предел считает строки, не разрезая транзакцию, и reset воспроизводим', async () => {
  const graph = await freshGraph();
  const from = await checkpoint(graph);
  const first = await admin.begin(async (tx) => {
    await tx`INSERT INTO entities (id, graph_id, title)
      SELECT gen_random_uuid(), ${graph}, 'range' FROM generate_series(1, 1000)`;
    return xidOf(tx);
  });
  const full = await reconcile(graph, from);
  expect(full.reset).toBeNull();
  expect(full.transactions.map((t) => [t.txId, t.changes.length])).toEqual([[first, 1000]]);
  await admin.begin((tx) => insertEntity(tx, graph, crypto.randomUUID()));
  const overflow = await reconcile(graph, from);
  expect(overflow.transactions).toEqual([]);
  expect(overflow.reset).toEqual({
    reason: 'overflow',
    token: `overflow:${from}:${overflow.floor}:${overflow.watermark}`,
    phase: 'complete',
  });
  expect(await reconcile(graph, from)).toEqual(overflow);
  expect((await reconcile(graph, overflow.watermark)).reset).toBeNull();
});

test('будущий uint64 cursor сбрасывается, некорректный формат отклоняется до SQL', async () => {
  const graph = await freshGraph();
  const future = '18446744073709551615';
  const page = await reconcile(graph, future);
  expect(page.reset).toEqual({
    reason: 'future-cursor',
    token: `future-cursor:${future}:${page.floor}:${page.watermark}`,
    phase: 'complete',
  });
  expect(page.transactions).toEqual([]);
  expect(BigInt(page.watermark)).toBeLessThan(BigInt(future));
  for (const invalid of ['18446744073709551616', '01', '+1', '1e3', ' 1', '1\n', '-1', '']) {
    await expect(reconcile(graph, invalid)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  }
});
