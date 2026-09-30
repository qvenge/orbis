// `Server-Timing` (спека скорости §3.1, РП-3): время приложения и сумма транзакций `withIdentity` запроса.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import type { AiDeps } from '../ai/send-message';
import { createApp } from '../app';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import { addDbTime, serverTiming, serverTimingHeader } from './server-timing';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});

test('db — сумма транзакций withIdentity; app ≥ db; desc ASCII', async () => {
  const g = await freshGraph();
  const app = new Hono();
  app.use('*', serverTiming());
  app.get('/x', async (c) => {
    await withIdentity(db, personal(g), (tx) => tx.execute(sql`SELECT pg_sleep(0.02)`));
    return c.text('ok');
  });
  const h = (await app.request('/x')).headers.get('server-timing') ?? '';
  const m = /^app;dur=([\d.]+), db;dur=([\d.]+);desc="transactions"$/.exec(h);
  expect(m).not.toBeNull();
  expect(Number(m?.[2])).toBeGreaterThanOrEqual(20);
  expect(Number(m?.[1])).toBeGreaterThanOrEqual(Number(m?.[2]));
});

test('вне запроса счётчика нет', () => {
  addDbTime(5);
  expect(serverTimingHeader()).toBeNull();
});

test('сервис: /trpc/ping несёт Server-Timing', async () => {
  const app = createApp({
    db: {} as Db,
    ai: {} as AiDeps,
    webDistDir: mkdtempSync(join(tmpdir(), 'orbis-dist-')),
  });
  expect((await app.request('/trpc/ping')).headers.get('server-timing')).toMatch(
    /^app;dur=[\d.]+, db;dur=0\.0;desc="transactions"$/,
  );
});

test('сервис: /mcp несёт Server-Timing, и запрос verifyBearer вне транзакции входит в db (РП-3)', async () => {
  const app = createApp({
    db,
    ai: {} as AiDeps,
    webDistDir: mkdtempSync(join(tmpdir(), 'orbis-dist-')),
  });
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer orbis_pat_unknown' },
  });
  expect(res.status).toBe(401);
  const m = /^app;dur=([\d.]+), db;dur=([\d.]+);desc="transactions"$/.exec(
    res.headers.get('server-timing') ?? '',
  );
  expect(m).not.toBeNull();
  expect(Number(m?.[2])).toBeGreaterThan(0);
});
