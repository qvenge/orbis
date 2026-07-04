// Тесты сборки request-контекста (Task 14): Bearer → actorUserId через реальную
// HS256-верификацию (без моков jose), CLIENT_VERSION_HEADER → clientVersion.
// Герметичен по образцу auth.test.ts: JWKS-путь выключен, секрет локального стека задан явно.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import { SignJWT } from 'jose';
import { makeCreateContext } from './context';
import type { Context } from './trpc';

const LOCAL_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

const savedEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_JWKS_URL: process.env.SUPABASE_JWKS_URL,
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
};

beforeAll(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_JWKS_URL;
  process.env.SUPABASE_JWT_SECRET = LOCAL_JWT_SECRET;
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

test('Bearer с валидным токеном → actorUserId = sub; db кладётся ссылкой', async () => {
  const sub = crypto.randomUUID();
  const ctx = await createContext(makeReq({ authorization: `Bearer ${await signHs256(sub)}` }));
  expect(ctx.actorUserId).toBe(sub);
  expect(ctx.db).toBe(db);
});

test('без Authorization / не-Bearer → actorUserId = null', async () => {
  expect((await createContext(makeReq())).actorUserId).toBeNull();
  expect((await createContext(makeReq({ authorization: 'Basic abc' }))).actorUserId).toBeNull();
  expect(
    (await createContext(makeReq({ authorization: 'Bearer not-a-jwt' }))).actorUserId,
  ).toBeNull();
});

test('заголовок версии клиента пробрасывается; отсутствует → null', async () => {
  const withHeader = await createContext(makeReq({ [CLIENT_VERSION_HEADER]: '0.1.0' }));
  expect(withHeader.clientVersion).toBe('0.1.0');
  const without = await createContext(makeReq());
  expect(without.clientVersion).toBeNull();
});
