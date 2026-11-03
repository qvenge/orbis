import { afterAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { adminDb, appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import type { AiDeps } from '../ai/send-message';
import { createApp } from '../app';
import type { Db } from '../db/client';
import { issuePatGrant } from '../oauth/grants';

requireEnv();
const { db, client } = appDb();
const admin = adminDb().client;
afterAll(() => Promise.all([client.end(), admin.end()]));

async function withOwnerJwt<T>(subject: string, fn: (jwt: string) => Promise<T>) {
  const env = process.env;
  const settings = {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_JWKS_URL: env.SUPABASE_JWKS_URL,
    SUPABASE_JWT_SECRET: env.SUPABASE_JWT_SECRET,
  };
  delete env.SUPABASE_URL;
  delete env.SUPABASE_JWKS_URL;
  const secret = 'local-test-secret-with-at-least-32-characters';
  env.SUPABASE_JWT_SECRET = secret;
  try {
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));
    return await fn(token);
  } finally {
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

test('HTTP responseMeta сохраняет Server-Timing и отдаёт минимум разных границ в пачке', async () => {
  const graph = await freshGraph();
  const entity = crypto.randomUUID();
  await admin`INSERT INTO entities (id, graph_id, title) VALUES (${entity}, ${graph}, 'watermark')`;
  const ready = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const finished = admin.begin(async (tx) => {
    const [row] = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
    if (!row) throw new Error('отсутствует xid');
    ready.resolve(row.xid);
    await release.promise;
  });
  void finished.catch(ready.reject);

  let first = true;
  const boundaries: string[] = [];
  const firstFinished = Promise.withResolvers<void>();
  const transaction: Db['transaction'] = async (fn, config) => {
    const run = () =>
      db.transaction(async (tx) => {
        const result = await fn(tx);
        const [row] = await tx.execute<{ watermark: string }>(sql`
        SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS watermark
      `);
        if (!row) throw new Error('отсутствует граница снимка');
        boundaries.push(row.watermark);
        return result;
      }, config);

    if (!first) {
      await firstFinished.promise;
      return run();
    }
    first = false;
    try {
      return await run();
    } finally {
      release.resolve();
      try {
        await finished;
      } finally {
        firstFinished.resolve();
      }
    }
  };
  const batchDb = new Proxy(db, {
    get: (target, key, receiver) =>
      key === 'transaction' ? transaction : Reflect.get(target, key, receiver),
  });
  const app = createApp({ db: batchDb, ai: {} as AiDeps });

  try {
    const held = await ready.promise;
    await withOwnerJwt(graph, async (token) => {
      const input = encodeURIComponent(JSON.stringify({ 0: { id: entity }, 1: { ids: [entity] } }));
      const response = await app.request(
        `/trpc/entity.get,entity.resolveRefs?batch=1&input=${input}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([
        { result: { data: { entity: { id: entity } } } },
        { result: { data: [{ id: entity }] } },
      ]);
      expect(boundaries).toHaveLength(2);
      expect(boundaries[0]).toBe(held);
      expect(BigInt(boundaries[1] ?? '0')).toBeGreaterThan(BigInt(held));
      expect(response.headers.get('X-Orbis-Read-Watermark')).toBe(held);
      expect(response.headers.get('Server-Timing')).toMatch(/app;dur=.*db;dur=/);
      expect((await app.request('/trpc/ping')).headers.has('X-Orbis-Read-Watermark')).toBe(false);
    });
  } finally {
    release.resolve();
    await finished;
  }
});

test('reconcile допускает только владельца читаемого графа', async () => {
  const graph = await freshGraph();
  const app = createApp({ db, ai: {} as AiDeps });
  const path = `/trpc/changes.reconcile?input=${encodeURIComponent('{"from":"0"}')}`;
  await withOwnerJwt(graph, async (token) => {
    const response = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('result.data.watermark');
    expect(body).not.toHaveProperty('result.data.targetXid');
  });
  const pat = await issuePatGrant(db, { identity: personal(graph), label: 'reconcile test' });
  expect((await app.request(path, { headers: { authorization: `Bearer ${pat}` } })).status).toBe(
    403,
  );
  await withOwnerJwt(crypto.randomUUID(), async (token) => {
    expect(
      (await app.request(path, { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(403);
  });
});
