// apps/server/src/routers/perf.test.ts
// `perf.report` (спека скорости §3.2, §13.1): пачка полевых замеров владельца — без содержимого, по аккаунту, с
// потолками. Против живой БД через createCallerFactory, как в бою.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { GraphId, PerfSample } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const admin = adminDb();
const createCaller = createCallerFactory(appRouter);
const S: PerfSample = { metric: 'inp', durMs: 42, device: 'desktop', appVersion: '0.6.0' };

function callerFor(g: GraphId, actorKind: 'owner' | 'agent' = 'owner') {
  return createCaller({ identity: personal(g), actorKind, db, clientVersion: null });
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

async function rowsOf(g: GraphId): Promise<Array<{ account_id: string; metric: string }>> {
  return (await admin.db.execute(
    sql`SELECT account_id::text, metric FROM perf_samples WHERE account_id = ${g} ORDER BY id`,
  )) as unknown as Array<{ account_id: string; metric: string }>;
}

beforeAll(truncateAll);
afterAll(async () => {
  await truncateAll();
  await client.end();
  await admin.client.end();
});

describe('perf.report', () => {
  test('пачка из двух принята; строки — под аккаунтом актора', async () => {
    const g = await freshGraph();
    const res = await callerFor(g).perf.report({
      samples: [S, { ...S, metric: 'lcp', durMs: 900, screen: 'record', cached: false }],
    });
    expect(res).toEqual({ accepted: 2, dropped: 0 });
    const rows = await rowsOf(g);
    expect(rows.map((r) => [r.account_id, r.metric])).toEqual([
      [g, 'inp'],
      [g, 'lcp'],
    ]);
  });

  test('содержимого нет (§13.1): заголовок, id записи, текст, вход процедуры — BAD_REQUEST', async () => {
    const g = await freshGraph();
    const report = (input: unknown) =>
      trpcError(callerFor(g).perf.report(input as { samples: PerfSample[] }));
    for (const extra of [
      { title: 'Купить молоко' },
      { entityId: '00000000-0000-7000-8000-000000000001' },
      { text: 'тело записи' },
      { procedure: 'entity.get?input={"id":"00000000-0000-7000-8000-000000000001"}' },
    ]) {
      expect((await report({ samples: [{ ...S, ...extra }] })).code).toBe('BAD_REQUEST');
    }
    // Лишний ключ и на уровне пачки — не место для содержимого.
    expect((await report({ samples: [S], title: 'x' })).code).toBe('BAD_REQUEST');
    expect(await rowsOf(g)).toEqual([]);
  });

  test('больше 100 замеров в пачке — BAD_REQUEST', async () => {
    const g = await freshGraph();
    const err = await trpcError(
      callerFor(g).perf.report({ samples: Array.from({ length: 101 }, () => S) }),
    );
    expect(err.code).toBe('BAD_REQUEST');
  });

  test('седьмая пачка в минуту отбрасывается с ответом, а не отказом', async () => {
    const g = await freshGraph();
    for (let i = 0; i < 6; i++) {
      expect(await callerFor(g).perf.report({ samples: [S] })).toEqual({ accepted: 1, dropped: 0 });
    }
    expect(await callerFor(g).perf.report({ samples: [S, S, S] })).toEqual({
      accepted: 0,
      dropped: 3,
    });
    expect(await rowsOf(g)).toHaveLength(6);
  });

  test('суточный потолок: при 4999 замерах за сутки из пачки в три принят один', async () => {
    const g = await freshGraph();
    await admin.db.execute(sql`
      INSERT INTO perf_samples (account_id, metric, dur_ms, device, app_version)
      SELECT ${g}, 'inp', 1, 'desktop', '0.6.0' FROM generate_series(1, 4999)`);
    expect(await callerFor(g).perf.report({ samples: [S, S, S] })).toEqual({
      accepted: 1,
      dropped: 2,
    });
    expect(await rowsOf(g)).toHaveLength(5000);
  });

  test('агент — FORBIDDEN: замеры пишет только владелец из своего клиента', async () => {
    const g = await freshGraph();
    expect((await trpcError(callerFor(g, 'agent').perf.report({ samples: [S] }))).code).toBe(
      'FORBIDDEN',
    );
  });

  test('чужой аккаунт замеров не видит', async () => {
    const g = await freshGraph();
    const g2 = await freshGraph();
    await callerFor(g).perf.report({ samples: [S] });
    expect(await rowsOf(g)).toHaveLength(1);
    const seen = await withIdentity(db, personal(g2), async (tx) => {
      const r = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM perf_samples`,
      )) as unknown as Array<{
        n: number;
      }>;
      return r[0]?.n;
    });
    expect(seen).toBe(0);
  });
});
