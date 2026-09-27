// apps/server/src/routers/supply.test.ts
// Ручки поставки (срез 1б §9.1, С1б-6): все — только владельцу; каждая пишущая — ОДНА запись журнала.
// Против живой БД через createCallerFactory, как в бою. Эталоны у ручек — эталоны кода; «прежний релиз»
// фикстура кладёт в записи сама (подменённый эталон «Домой»), чтобы обновление было что принимать.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type GraphId, newId } from '@orbis/shared';
import {
  SUPPLY_ETALONS,
  SUPPLY_KEYS,
  type SupplyEtalon,
  type SupplyKey,
} from '@orbis/shared/supply';
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { effectiveRegistry } from '../registry/cache';
import { appRouter } from '../router';
import { supplyCreateOps, supplyRecordId } from '../supply/records';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);
const sink = makeChatJournalSink();

beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

function callerFor(graph: GraphId, actorKind: 'owner' | 'agent' = 'owner') {
  return createCaller({ identity: personal(graph), actorKind, db, clientVersion: null });
}

async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

/** Записи поставки «прежнего релиза»: эталоны `home` и `records` — старые, прочие — нынешние. */
const OLD: readonly SupplyEtalon[] = SUPPLY_ETALONS.map((e) =>
  e.key === 'home' || e.key === 'records'
    ? ({ ...e, text: `Прежний эталон.\n\n${(e as { text: string }).text}` } as SupplyEtalon)
    : e,
);

async function seedOld(graph: GraphId, keys: readonly SupplyKey[] = SUPPLY_KEYS): Promise<void> {
  const reg = await withIdentity(db, personal(graph), (tx) => effectiveRegistry(tx, graph));
  const r = await execute(
    db,
    {
      identity: personal(graph),
      actorKind: 'owner',
      source: 'ui',
      mechanism: 'supply',
      batchId: newId(),
      operations: supplyCreateOps(
        graph,
        keys,
        (k) => (keys.includes(k) ? supplyRecordId(graph, k) : null),
        reg,
        OLD,
      ),
    },
    { sink },
  );
  if (!r.ok) throw new Error(`сев записей поставки: ${JSON.stringify(r.error)}`);
}

async function journalCount(graph: GraphId, actionId: string): Promise<number> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.execute(sql`SELECT 1 FROM chat_messages WHERE metadata @> ${probe}::jsonb`),
  );
  return rows.length;
}

describe('supply.* — только владельцу', () => {
  test('агент получает FORBIDDEN на каждой ручке, и ничего не записано', async () => {
    const graph = await freshGraph();
    await seedOld(graph);
    const agent = callerFor(graph, 'agent');
    const calls: Array<() => Promise<unknown>> = [
      () => agent.supply.updates(),
      () => agent.supply.accept({ key: 'home' }),
      () => agent.supply.acceptAll(),
      () => agent.supply.decline({ key: 'home' }),
      () => agent.supply.revert({ key: 'home' }),
      () => agent.supply.add({ key: 'home' }),
    ];
    for (const call of calls) expect((await trpcError(call())).code).toBe('FORBIDDEN');
    expect(await callerFor(graph).supply.updates()).toHaveLength(2);
  });

  test('ключ вне десяти — отказ разбора входа', async () => {
    const graph = await freshGraph();
    const owner = callerFor(graph);
    expect(
      (await trpcError(owner.supply.accept({ key: 'budget' as unknown as SupplyKey }))).code,
    ).toBe('BAD_REQUEST');
  });
});

describe('supply.* — каждая пишущая ручка — одна запись журнала', () => {
  test('updates → accept, decline, acceptAll, revert, add', async () => {
    const graph = await freshGraph();
    await seedOld(
      graph,
      SUPPLY_KEYS.filter((k) => k !== 'all-tasks'),
    );
    const owner = callerFor(graph);
    const updates = await owner.supply.updates();
    expect(updates.map((u) => [u.key, u.kind])).toEqual([
      ['home', 'update'],
      ['records', 'update'],
      ['all-tasks', 'new'],
    ]);

    const declined = await owner.supply.decline({ key: 'records' });
    expect(await journalCount(graph, declined.actionId)).toBe(1);

    const accepted = await owner.supply.accept({ key: 'home' });
    expect(await journalCount(graph, accepted.actionId)).toBe(1);

    const added = await owner.supply.add({ key: 'all-tasks' });
    expect(await journalCount(graph, added.actionId)).toBe(1);
    expect(await owner.supply.updates()).toEqual([]);

    // «Вернуть как было» после «принять»: правка владельца, затем возврат — одна запись.
    const id = supplyRecordId(graph, 'home');
    await owner.entity.update({ id, title: 'Главная' });
    const reverted = await owner.supply.revert({ key: 'home' });
    expect(await journalCount(graph, reverted.actionId)).toBe(1);

    // «Принять все» — одна запись на все принятые.
    const graph2 = await freshGraph();
    await seedOld(graph2);
    const all = await callerFor(graph2).supply.acceptAll();
    expect(all.accepted).toEqual(['home', 'records']);
    if (all.actionId === null) throw new Error('ожидался action');
    expect(await journalCount(graph2, all.actionId)).toBe(1);
  });
});
