// Тесты сборки request-контекста (Task 14): Bearer → actorUserId через реальную
// HS256-верификацию (без моков jose), CLIENT_VERSION_HEADER → clientVersion.
// §9.3: агентский путь — Bearer с префиксом orbis_pat_/orbis_at_ идёт в таблицу грантов
// (verifyBearer), actorKind 'agent'. Env-путь PAT снят вместе с apps/server/src/pat.ts:
// у токена агента один источник правды, и он в базе — поэтому файл стал интеграционным
// (DATABASE_URL) вместо герметичного. JWT-часть по-прежнему герметична: JWKS-путь
// выключен, секрет локального стека задан явно.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import { SignJWT } from 'jose';
import { appDb, freshUserId, requireEnv } from '../test/helpers';
import { makeCreateContext } from './context';
import { issuePatGrant, revokeGrant, verifyBearer } from './oauth/grants';
import { appRouter } from './router';

requireEnv();

const LOCAL_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

const { db, client: dbClient } = appDb();
const PAT_OWNER = freshUserId();
/** Живой headless-грант владельца PAT_OWNER; выдаётся в базу в beforeAll. */
let PAT_TOKEN: string;

const savedEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_JWKS_URL: process.env.SUPABASE_JWKS_URL,
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
};

beforeAll(async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_JWKS_URL;
  process.env.SUPABASE_JWT_SECRET = LOCAL_JWT_SECRET;
  // truncateAll здесь не нужен: владелец случайный (freshUserId), чужие строки этому
  // сьюту не мешают, а лишняя зачистка связывала бы файл с остальными сьютами.
  PAT_TOKEN = await issuePatGrant(db, { ownerId: PAT_OWNER, label: 'тестовый агент' });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await dbClient.end();
});

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

// §9.3: агентский путь — префикс orbis_pat_ уводит в таблицу грантов, JWT не пробуется
test('Bearer с валидным PAT → { actorUserId: владелец гранта, actorKind: agent }', async () => {
  const ctx = await createContext(makeReq({ authorization: `Bearer ${PAT_TOKEN}` }));
  expect(ctx.actorUserId).toBe(PAT_OWNER);
  expect(ctx.actorKind).toBe('agent');
});

// Access-токен OAuth — второй вид агентского Bearer; для tRPC он ровно то же, что PAT
test('Bearer с access-токеном OAuth → тот же агентский путь', async () => {
  const ctx = await createContext(makeReq({ authorization: `Bearer orbis_at_${'11'.repeat(32)}` }));
  expect(ctx.actorUserId).toBeNull(); // такого гранта в таблице нет
  expect(ctx.actorKind).toBe('agent'); // но путь агентский — на JWT не откатываемся
});

test('Bearer с битым PAT → actorUserId null (fail-closed, без JWT-fallback)', async () => {
  // Последний символ подменяется НА ЗАВЕДОМО ДРУГОЙ, а не на константу 'e': токен —
  // это hex (tokens.ts, randomBytes.toString('hex')), поэтому его последний символ сам
  // оказывается 'e' примерно в одном прогоне из шестнадцати, и «битый» токен совпадал с
  // настоящим — тест падал на ровном месте с 6% вероятностью. Поймано на полном прогоне
  // при закрытии находок финального ревью слайса 4b.
  const last = PAT_TOKEN.slice(-1);
  const broken = `Bearer ${PAT_TOKEN.slice(0, -1)}${last === 'e' ? 'f' : 'e'}`;
  const ctx = await createContext(makeReq({ authorization: broken }));
  expect(ctx.actorUserId).toBeNull();
  expect(ctx.actorKind).toBe('agent'); // префикс детектирован — путь агентский, не owner
});

// Отзыв обязан гасить доступ на ОБЕИХ поверхностях, не только на /mcp: иначе отозванный
// агент продолжал бы читать граф владельца через tRPC.
test('отозванный грант → actorUserId null, actorKind остаётся agent', async () => {
  const token = await issuePatGrant(db, { ownerId: PAT_OWNER, label: 'на отзыв' });
  const identity = await verifyBearer(db, token);
  if (identity === null) throw new Error('выданный токен не прошёл verifyBearer');
  expect((await createContext(makeReq({ authorization: `Bearer ${token}` }))).actorUserId).toBe(
    PAT_OWNER,
  );

  await revokeGrant(db, { ownerId: PAT_OWNER, grantId: identity.grantId });

  const ctx = await createContext(makeReq({ authorization: `Bearer ${token}` }));
  expect(ctx.actorUserId).toBeNull();
  expect(ctx.actorKind).toBe('agent');
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
