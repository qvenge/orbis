// Юнит-тест jose-верификации (отклонение от брифа: локальная проверка вместо auth.getUser).
// Герметичен: SUPABASE_URL убирается, чтобы путь JWKS не трогал сеть; HS256-секрет задаётся
// явно (это публичный дефолт локального стека Supabase, не секрет).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SignJWT } from 'jose';
import { verifyAccessToken } from './auth';

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

function signHs256(secret: string, sub: string): Promise<string> {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

test('валидный HS256-токен: actorUserId = sub', async () => {
  const sub = crypto.randomUUID();
  const token = await signHs256(LOCAL_JWT_SECRET, sub);
  expect(await verifyAccessToken(token)).toBe(sub);
});

test('невалидный токен: null', async () => {
  expect(await verifyAccessToken('not-a-jwt')).toBeNull();
  const forged = await signHs256(
    'wrong-secret-that-is-also-32-characters-long!!',
    crypto.randomUUID(),
  );
  expect(await verifyAccessToken(forged)).toBeNull();
});
