// Тесты сборки request-контекста (Task 14): Bearer → actorUserId через реальную
// HS256-верификацию (без моков jose), CLIENT_VERSION_HEADER → clientVersion.
// Task 3 (1b): PAT-путь §9.3 — Bearer с префиксом orbis_pat_ → verifyPat, actorKind 'agent'.
// Герметичен по образцу auth.test.ts: JWKS-путь выключен, секрет локального стека
// и PAT-env заданы явно.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import { SignJWT } from 'jose';
import { makeCreateContext } from './context';
import { appRouter } from './router';
import type { Context } from './trpc';

const LOCAL_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

const PAT_OWNER = crypto.randomUUID();
const PAT_TOKEN = `orbis_pat_${'cd'.repeat(32)}`;

const savedEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_JWKS_URL: process.env.SUPABASE_JWKS_URL,
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
  ORBIS_PAT_HASH: process.env.ORBIS_PAT_HASH,
  ORBIS_PAT_OWNER_ID: process.env.ORBIS_PAT_OWNER_ID,
};

beforeAll(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_JWKS_URL;
  process.env.SUPABASE_JWT_SECRET = LOCAL_JWT_SECRET;
  process.env.ORBIS_PAT_HASH = createHash('sha256').update(PAT_TOKEN).digest('hex');
  process.env.ORBIS_PAT_OWNER_ID = PAT_OWNER;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// createContext БД не трогает — стаб-ссылка вместо пула
const db = null as unknown as Context['db'];
const createContext = makeCreateContext(db);

function makeReq(headers: Record<string, string> = {}): { req: Request } {
  return { req: new Request('http://localhost/trpc/ping', { headers }) };
}

function signHs256(sub: string): Promise<string> {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(LOCAL_JWT_SECRET));
}

test('Bearer с валидным токеном → actorUserId = sub, actorKind owner; db кладётся ссылкой', async () => {
  const sub = crypto.randomUUID();
  const ctx = await createContext(makeReq({ authorization: `Bearer ${await signHs256(sub)}` }));
  expect(ctx.actorUserId).toBe(sub);
  expect(ctx.actorKind).toBe('owner'); // JWT-путь не регрессировал (Task 3)
  expect(ctx.db).toBe(db);
});

test('без Authorization / не-Bearer → actorUserId = null, actorKind owner', async () => {
  expect((await createContext(makeReq())).actorUserId).toBeNull();
  expect((await createContext(makeReq())).actorKind).toBe('owner');
  expect((await createContext(makeReq({ authorization: 'Basic abc' }))).actorUserId).toBeNull();
  expect(
    (await createContext(makeReq({ authorization: 'Bearer not-a-jwt' }))).actorUserId,
  ).toBeNull();
});

// §9.3: PAT-путь — префикс orbis_pat_ уводит в verifyPat, JWT-путь не пробуется
test('Bearer с валидным PAT → { actorUserId: owner из env, actorKind: agent }', async () => {
  const ctx = await createContext(makeReq({ authorization: `Bearer ${PAT_TOKEN}` }));
  expect(ctx.actorUserId).toBe(PAT_OWNER);
  expect(ctx.actorKind).toBe('agent');
});

test('Bearer с битым PAT → actorUserId null (fail-closed, без JWT-fallback)', async () => {
  const broken = `Bearer ${PAT_TOKEN.slice(0, -1)}e`;
  const ctx = await createContext(makeReq({ authorization: broken }));
  expect(ctx.actorUserId).toBeNull();
  expect(ctx.actorKind).toBe('agent'); // префикс детектирован — путь агентский, не owner
});

test('PAT без env (hash удалён) → actorUserId null даже для «валидного» токена', async () => {
  const saved = process.env.ORBIS_PAT_HASH;
  delete process.env.ORBIS_PAT_HASH;
  try {
    const ctx = await createContext(makeReq({ authorization: `Bearer ${PAT_TOKEN}` }));
    expect(ctx.actorUserId).toBeNull();
  } finally {
    process.env.ORBIS_PAT_HASH = saved;
  }
});

// Агент не шлёт CLIENT_VERSION_HEADER → clientVersion null → version-гейт пропускает:
// полный путь createContext → appRouter, whoami отвечает владельцем PAT
test('PAT-запрос без заголовка версии проходит version-гейт (whoami через appRouter)', async () => {
  const ctx = await createContext(makeReq({ authorization: `Bearer ${PAT_TOKEN}` }));
  expect(ctx.clientVersion).toBeNull();
  const caller = appRouter.createCaller(ctx);
  expect(await caller.whoami()).toEqual({ actorUserId: PAT_OWNER });
});

test('заголовок версии клиента пробрасывается; отсутствует → null', async () => {
  const withHeader = await createContext(makeReq({ [CLIENT_VERSION_HEADER]: '0.1.0' }));
  expect(withHeader.clientVersion).toBe('0.1.0');
  const without = await createContext(makeReq());
  expect(without.clientVersion).toBeNull();
});
