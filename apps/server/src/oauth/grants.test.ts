// Интеграционные тесты модуля грантов (§9.3, D34): живая БД под ролью orbis_app,
// без моков. Хеши токенов тесты считают сами (createHash), а не через hashToken —
// иначе сьют проверял бы согласованность модуля с самим собой, а не контракт хранения.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { agentGrants, oauthClients } from '../db/schema';
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  issuePatGrant,
  listGrants,
  revokeGrant,
  rotateRefresh,
  verifyBearer,
} from './grants';

requireEnv();
const { db, client: dbClient } = appDb();
const owner = freshUserId();
const REDIRECT = 'http://localhost:8080/callback';

/** PKCE-пара по RFC 7636: challenge = base64url(sha256(verifier)). */
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

async function seedClient(clientId = 'test-client'): Promise<string> {
  await db
    .insert(oauthClients)
    .values({
      clientId,
      clientName: 'Claude Code',
      redirectUris: [REDIRECT],
    })
    .onConflictDoNothing();
  return clientId;
}

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await dbClient.end();
});

test('код меняется на пару токенов, access пускает', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner,
    clientId,
    label: 'Claude Code',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  const pair = await exchangeAuthorizationCode(db, {
    code,
    codeVerifier: verifier,
    redirectUri: REDIRECT,
    clientId,
  });
  expect(pair.accessToken.startsWith('orbis_at_')).toBe(true);
  expect(pair.expiresIn).toBe(3600);
  expect(await verifyBearer(db, pair.accessToken)).toMatchObject({ ownerId: owner });
});

test('код одноразовый: повторный обмен отвергнут и грант отозван', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner,
    clientId,
    label: 'Claude Code',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  const pair = await exchangeAuthorizationCode(db, {
    code,
    codeVerifier: verifier,
    redirectUri: REDIRECT,
    clientId,
  });
  await expect(
    exchangeAuthorizationCode(db, {
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      clientId,
    }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
  // Повторный код — признак перехвата: выданный по нему доступ обязан умереть
  expect(await verifyBearer(db, pair.accessToken)).toBeNull();
});

test('неверный verifier не проходит', async () => {
  const clientId = await seedClient();
  const { challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner,
    clientId,
    label: 'Claude Code',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  await expect(
    exchangeAuthorizationCode(db, {
      code,
      codeVerifier: 'не тот verifier',
      redirectUri: REDIRECT,
      clientId,
    }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
});

test('refresh ротируется, старый больше не работает', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner,
    clientId,
    label: 'Claude Code',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  const first = await exchangeAuthorizationCode(db, {
    code,
    codeVerifier: verifier,
    redirectUri: REDIRECT,
    clientId,
  });
  const second = await rotateRefresh(db, { refreshToken: first.refreshToken, clientId });
  expect(second.refreshToken).not.toBe(first.refreshToken);
  expect(await verifyBearer(db, second.accessToken)).toMatchObject({ ownerId: owner });
  expect(await verifyBearer(db, first.accessToken)).toBeNull();
  await expect(
    rotateRefresh(db, { refreshToken: first.refreshToken, clientId }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
});

test('реплей ротированного refresh гасит цепочку целиком (OAuth 2.1 §7.5)', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner,
    clientId,
    label: 'Claude Code',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  const first = await exchangeAuthorizationCode(db, {
    code,
    codeVerifier: verifier,
    redirectUri: REDIRECT,
    clientId,
  });
  const second = await rotateRefresh(db, { refreshToken: first.refreshToken, clientId });
  expect(await verifyBearer(db, second.accessToken)).toMatchObject({ ownerId: owner });
  // Перехватчик предъявляет ПЕРВЫЙ refresh уже после легитимной ротации: сам по себе
  // отказ ничего не решает, потому что у перехватчика на руках может быть и второй.
  await expect(
    rotateRefresh(db, { refreshToken: first.refreshToken, clientId }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
  // Поэтому §7.5 требует убить всю цепочку: и текущий access, и текущий refresh.
  expect(await verifyBearer(db, second.accessToken)).toBeNull();
  await expect(
    rotateRefresh(db, { refreshToken: second.refreshToken, clientId }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
});

test('чужой client_id не ротирует и НЕ гасит грант', async () => {
  const clientId = await seedClient();
  const other = await seedClient('other-client');
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner,
    clientId,
    label: 'Claude Code',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  const pair = await exchangeAuthorizationCode(db, {
    code,
    codeVerifier: verifier,
    redirectUri: REDIRECT,
    clientId,
  });
  await expect(
    rotateRefresh(db, { refreshToken: pair.refreshToken, clientId: other }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
  // Сбитый конфиг чужого клиента не должен стоить владельцу доступа: грант жив,
  // и законный клиент по-прежнему ротируется.
  expect(await verifyBearer(db, pair.accessToken)).toMatchObject({ ownerId: owner });
  const rotated = await rotateRefresh(db, { refreshToken: pair.refreshToken, clientId });
  expect(await verifyBearer(db, rotated.accessToken)).toMatchObject({ ownerId: owner });
});

test('мёртвый refresh при предъявлении гасит грант целиком, access перестаёт пускать', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner,
    clientId,
    label: 'Claude Code',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  const pair = await exchangeAuthorizationCode(db, {
    code,
    codeVerifier: verifier,
    redirectUri: REDIRECT,
    clientId,
  });
  // Состариваем refresh, не трогая access: строка перестаёт быть «живой» для ротации,
  // но хеш в ней остаётся — это и есть след, по которому предъявление гасит грант.
  await db
    .update(agentGrants)
    .set({ refreshExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(agentGrants.refreshHash, sha256hex(pair.refreshToken)));
  expect(await verifyBearer(db, pair.accessToken)).toMatchObject({ ownerId: owner });
  await expect(
    rotateRefresh(db, { refreshToken: pair.refreshToken, clientId }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
  expect(await verifyBearer(db, pair.accessToken)).toBeNull();
});

test('PAT пускает бессрочно и отзывается', async () => {
  const pat = await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  expect(pat.startsWith('orbis_pat_')).toBe(true);
  const identity = await verifyBearer(db, pat);
  expect(identity).toMatchObject({ ownerId: owner });
  if (!identity) throw new Error('verifyBearer не вернул identity');
  expect(await revokeGrant(db, { ownerId: owner, grantId: identity.grantId })).toBe(true);
  expect(await verifyBearer(db, pat)).toBeNull();
});

test('чужой владелец не отзывает грант', async () => {
  const pat = await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  const identity = await verifyBearer(db, pat);
  if (!identity) throw new Error('verifyBearer не вернул identity');
  expect(await revokeGrant(db, { ownerId: freshUserId(), grantId: identity.grantId })).toBe(false);
  expect(await verifyBearer(db, pat)).not.toBeNull();
});

test('listGrants отдаёт свои гранты и не отдаёт хеши', async () => {
  await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  await issuePatGrant(db, { ownerId: freshUserId(), label: 'чужой' });
  const grants = await listGrants(db, owner);
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ kind: 'pat', label: 'CI' });
  expect(JSON.stringify(grants)).not.toContain('hash');
});

test('мусорный токен и токен без префикса отвергаются', async () => {
  expect(await verifyBearer(db, `orbis_at_${'ff'.repeat(32)}`)).toBeNull();
  expect(await verifyBearer(db, 'eyJhbGciOiJIUzI1NiJ9.подделка')).toBeNull();
});
