import { expect, test } from 'bun:test';
import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import { SignJWT } from 'jose';
import type { AiDeps } from '../../../apps/server/src/ai/send-message';
import { createApp } from '../../../apps/server/src/app';
import { appRouter } from '../../../apps/server/src/router';
import { appDb, freshGraph, personal } from '../../../apps/server/test/helpers';

test('the same HTTP 500 may precede any write or hide an actual committed Undo', async () => {
  for (const key of ['DATABASE_URL', 'DATABASE_URL_ADMIN']) {
    const url = new URL(process.env[key] ?? '');
    expect([url.hostname, url.port]).toEqual(['127.0.0.1', '54339']);
  }
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error('Missing test JWT key');
  const { db, client } = appDb();
  const app = createApp({ db, ai: {} as AiDeps });
  let mode: 'abort' | 'committed' = 'abort';
  let upstream: { actionId: string } | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (new URL(request.url).pathname !== '/trpc/ai.undo') return new Response(null, { status: 404 });
      if (mode === 'committed') {
        const real = await app.fetch(request);
        expect(real.status).toBe(200);
        upstream = (await real.json() as { result: { data: { actionId: string } } }).result.data;
      }
      return Response.json({
        error: {
          message: 'Отмена недоступна',
          code: -32603,
          data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'ai.undo' },
        },
      }, { status: 500 });
    },
  });
  try {
    const graph = await freshGraph();
    const caller = appRouter.createCaller({
      identity: personal(graph), db, actorKind: 'owner', clientVersion: '0.7.0',
    });
    const jwt = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(graph)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret));
    const record = await caller.entity.create({ input: { title: 'После отказа', tags: [] }, source: 'ui' });
    const action = await caller.entity.update({ id: record.id, title: 'До', expectedTitle: 'После отказа' });
    const post = () => fetch(new URL('/trpc/ai.undo', server.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', [CLIENT_VERSION_HEADER]: '0.7.0' },
      body: JSON.stringify({ actionId: action.actionId }),
    });
    let cursor = (await caller.changes.reconcile({ from: '0' })).watermark;
    const aborted = await post();
    expect(aborted.status).toBe(500);
    const abortFeed = await caller.changes.reconcile({ from: cursor });
    expect(abortFeed.reset).toBeNull();
    expect(abortFeed.transactions).toEqual([]);
    expect((await caller.entity.get({ id: record.id })).entity.title).toBe('До');
    console.log(JSON.stringify({ lane: 'abort', status: aborted.status, from: cursor, watermark: abortFeed.watermark, transactions: [] }));

    cursor = abortFeed.watermark;
    mode = 'committed';
    const lost = await post();
    expect(lost.status).toBe(500);
    expect(await lost.json()).toMatchObject({ error: { data: { code: 'INTERNAL_SERVER_ERROR' } } });
    if (!upstream) throw new Error('Missing successful origin response');
    const committedFeed = await caller.changes.reconcile({ from: cursor });
    expect(committedFeed.reset).toBeNull();
    const tx = committedFeed.transactions.find((transaction) =>
      transaction.changes.some((change) => change.kind === 'journal' && change.rowKey === upstream?.actionId));
    if (!tx) throw new Error('Missing committed Undo transaction');
    expect(tx.changes).toContainEqual(expect.objectContaining({
      kind: 'entity', rowKey: record.id, entityIds: [record.id], operation: 'update', scope: 'other',
    }));
    expect((await caller.entity.get({ id: record.id })).entity.title).toBe('После отказа');
    console.log(JSON.stringify({ lane: 'committed-with-lost-response', status: lost.status, from: cursor, watermark: committedFeed.watermark, tx }));
  } finally {
    server.stop(true);
    await client.end();
  }
}, 15_000);
