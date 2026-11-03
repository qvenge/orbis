import { afterAll, expect, test } from 'bun:test';
import { SignJWT } from 'jose';
import { appDb, freshGraph, requireEnv } from '../../test/helpers';
import type { AiDeps } from '../ai/send-message';
import { createApp } from '../app';

requireEnv();
const { db, client } = appDb();
afterAll(() => client.end());

test.each([
  '/trpc/changes.watch',
  '/trpc/changes.watch/',
])('HTTP watch %s emits a tracked id and resumes from Last-Event-ID', async (path) => {
  const owner = await freshGraph();
  const env = process.env;
  const saved = {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_JWKS_URL: env.SUPABASE_JWKS_URL,
    SUPABASE_JWT_SECRET: env.SUPABASE_JWT_SECRET,
  };
  delete env.SUPABASE_URL;
  delete env.SUPABASE_JWKS_URL;
  env.SUPABASE_JWT_SECRET = 'orbis-local-watch-test-secret-32';
  const request = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const jwt = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(owner)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(env.SUPABASE_JWT_SECRET));
    const app = createApp({ db, ai: {} as AiDeps });
    const response = await app.request(`${path}?input=%7B%22from%22%3A%220%22%7D`, {
      headers: { Authorization: `Bearer ${jwt}`, 'Last-Event-ID': '18446744073709551615' },
      signal: request.signal,
    });
    expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = '';
    // Ignore the connected frame and wait for the first application data frame.
    while (
      text
        .split('\n\n')
        .slice(0, -1)
        .filter((frame) => frame.includes('data:')).length < 2
    ) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toContain('"reason":"future-cursor"');
    expect(text).toMatch(/\nid: [0-9]+\n/);
  } finally {
    request.abort();
    await reader?.cancel();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
});

test('disabled SSE replies unavailable before handshake and reconcile remains usable', async () => {
  const owner = await freshGraph();
  const env = process.env;
  const saved = {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_JWKS_URL: env.SUPABASE_JWKS_URL,
    SUPABASE_JWT_SECRET: env.SUPABASE_JWT_SECRET,
    ORBIS_CHANGE_STREAM: env.ORBIS_CHANGE_STREAM,
  };
  delete env.SUPABASE_URL;
  delete env.SUPABASE_JWKS_URL;
  env.SUPABASE_JWT_SECRET = 'orbis-local-watch-test-secret-32';
  env.ORBIS_CHANGE_STREAM = '0';
  try {
    const jwt = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(owner)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(env.SUPABASE_JWT_SECRET));
    const app = createApp({ db, ai: {} as AiDeps });
    const headers = { Authorization: `Bearer ${jwt}` };
    const response = await app.request('/trpc/changes.watch?input=%7B%22from%22%3A%220%22%7D', {
      headers,
    });
    expect(response.status).toBe(503);
    await response.body?.cancel();
    for (const alias of [
      '/trpc/changes.watch/',
      '/trpc/changes.watch//',
      '/trpc/%63hanges.watch/',
    ]) {
      const result = await app.request(`${alias}?input=%7B%22from%22%3A%220%22%7D`, { headers });
      const status = result.status;
      await result.body?.cancel();
      expect(status).toBe(503);
    }
    const fallback = await app.request('/trpc/changes.reconcile?input=%7B%22from%22%3A%220%22%7D', {
      headers,
    });
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toMatchObject({
      result: { data: { watermark: expect.any(String) } },
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
});
