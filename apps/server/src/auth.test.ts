// Юнит-тест jose-верификации (отклонение от брифа: локальная проверка вместо auth.getUser).
// Герметичен: SUPABASE_URL убирается, чтобы путь JWKS не трогал сеть; HS256-секрет задаётся
// явно (это публичный дефолт локального стека Supabase, не секрет).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
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

// JWKS hardening (Task 14): реальный локальный сервер ключей (Bun.serve) + RS256-пара
// из jose — без моков. Проверяем allowlist алгоритмов и pinning issuer'а.
describe('JWKS: allowlist RS256/ES256 + issuer', () => {
  const SUPABASE_BASE = 'http://supabase.test.local';
  const ISSUER = `${SUPABASE_BASE}/auth/v1`;

  let server: ReturnType<typeof Bun.serve>;
  let privateKey: CryptoKey;
  let baseUrl: string;
  // Пути запросов к серверу ключей — для ассерта «HS256 не доходит до ключей»
  const jwksHits: string[] = [];

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey as CryptoKey;
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = 'test-key';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    server = Bun.serve({
      port: 0,
      fetch(req) {
        jwksHits.push(new URL(req.url).pathname);
        return Response.json({ keys: [jwk] });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    process.env.SUPABASE_URL = SUPABASE_BASE; // задаёт ожидаемый issuer
    process.env.SUPABASE_JWKS_URL = `${baseUrl}/rs256/jwks.json`;
  });

  afterAll(async () => {
    await server.stop();
    // env восстанавливает file-level afterAll
  });

  function signRs256(sub: string, iss: string): Promise<string> {
    return new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(sub)
      .setAudience('authenticated')
      .setIssuer(iss)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  test('валидный RS256 с верным iss: actorUserId = sub', async () => {
    const sub = crypto.randomUUID();
    const token = await signRs256(sub, ISSUER);
    expect(await verifyAccessToken(token)).toBe(sub);
  });

  test('верная подпись, но чужой iss → null', async () => {
    const token = await signRs256(crypto.randomUUID(), 'https://evil.example.com/auth/v1');
    expect(await verifyAccessToken(token)).toBeNull();
  });

  test('HS256-токен в JWKS-пути отвергается allowlist-ом, не доходя до ключей', async () => {
    // Уникальный путь + выключенный fallback: единственный источник — JWKS-путь
    const probePath = '/hs256-probe/jwks.json';
    process.env.SUPABASE_JWKS_URL = `${baseUrl}${probePath}`;
    const savedSecret = process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_JWT_SECRET;
    try {
      const token = await signHs256(LOCAL_JWT_SECRET, crypto.randomUUID());
      expect(await verifyAccessToken(token)).toBeNull();
      // allowlist срабатывает до резолва ключей — запрос к JWKS не уходит
      expect(jwksHits).not.toContain(probePath);
    } finally {
      process.env.SUPABASE_JWT_SECRET = savedSecret;
      process.env.SUPABASE_JWKS_URL = `${baseUrl}/rs256/jwks.json`;
    }
  });

  test('легитимный HS256-fallback жив при настроенном JWKS', async () => {
    const sub = crypto.randomUUID();
    const token = await signHs256(LOCAL_JWT_SECRET, sub);
    expect(await verifyAccessToken(token)).toBe(sub);
  });
});
