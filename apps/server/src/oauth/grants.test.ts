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

test('код, выданный другому клиенту, не меняется', async () => {
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
  await expect(
    exchangeAuthorizationCode(db, {
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      clientId: other,
    }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
});

test('несовпадающий redirect_uri не меняет код', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
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
      codeVerifier: verifier,
      redirectUri: 'http://localhost:8080/подмена',
      clientId,
    }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
});

test('просроченный код не меняется', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner,
    clientId,
    label: 'Claude Code',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  // Состариваем срок прямым UPDATE — системное время не подменяем.
  await db
    .update(agentGrants)
    .set({ codeExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(agentGrants.codeHash, sha256hex(code)));
  await expect(
    exchangeAuthorizationCode(db, {
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      clientId,
    }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
});

test('грант, отозванный между выдачей кода и обменом, кода не меняет', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner,
    clientId,
    label: 'Claude Code',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  // Строка гранта видна владельцу сразу — значит кнопка «Отозвать» доступна в те
  // самые 60 секунд, пока код ещё не обменян.
  const pending = await listGrants(db, owner);
  expect(pending).toHaveLength(1);
  const pendingGrant = pending[0];
  if (!pendingGrant) throw new Error('грант по выданному коду в listGrants не виден');
  expect(await revokeGrant(db, { ownerId: owner, grantId: pendingGrant.id })).toBe(true);
  // Иначе клиент получил бы 200 с парой токенов, которая не работает нигде,
  // и считал бы себя подключённым.
  await expect(
    exchangeAuthorizationCode(db, {
      code,
      codeVerifier: verifier,
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

// С2: bearer несёт не только владельца — из той же строки едут область гранта (вход
// гейта Задачи 7) и подпись (атрибуция в журнале и на экране «Агенты»). Скоуп читается
// впервые: до этого колонка agent_grants.scope существовала, но никем не читалась.
test('verifyBearer отдаёт область и подпись гранта, а не только владельца', async () => {
  const pat = await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  const identity = await verifyBearer(db, pat);
  expect(identity).toMatchObject({ ownerId: owner, scope: 'full', label: 'CI' });
});

test('чужой владелец не отзывает грант', async () => {
  const pat = await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  const identity = await verifyBearer(db, pat);
  if (!identity) throw new Error('verifyBearer не вернул identity');
  expect(await revokeGrant(db, { ownerId: freshUserId(), grantId: identity.grantId })).toBe(false);
  expect(await verifyBearer(db, pat)).not.toBeNull();
});

test('listGrants отдаёт свои гранты и не отдаёт хеши', async () => {
  const pat = await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  await issuePatGrant(db, { ownerId: freshUserId(), label: 'чужой' });
  const grants = await listGrants(db, owner);
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ kind: 'pat', label: 'CI' });
  // Ищем САМО значение хеша, а не подстроку 'hash': ключи drizzle приходят в camelCase
  // (`accessHash`), а hex-значение букв за a–f не содержит — поиск слова 'hash' пропустил
  // бы утечку целиком и сторожил бы пустое место.
  expect(JSON.stringify(grants)).not.toContain(sha256hex(pat));
});

// Строка гранта появляется в момент согласия владельца — ДО того, как агент обменял код
// на токены. Агент, который так и не обменял его (упал, окно закрыли), оставляет строку
// навсегда, и без отдельного признака она в списке «Агенты» неотличима от подключённого
// агента: те же метка, вид и дата. Признак считается по хешам токенов, наружу они не идут.
test('listGrants отличает необменянный код от подключённого агента', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner,
    clientId,
    label: 'Claude Code',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  expect((await listGrants(db, owner))[0]).toMatchObject({
    label: 'Claude Code',
    connected: false,
  });
  await exchangeAuthorizationCode(db, {
    code,
    codeVerifier: verifier,
    redirectUri: REDIRECT,
    clientId,
  });
  expect((await listGrants(db, owner))[0]).toMatchObject({ connected: true });
});

// PAT кода не обменивает вовсе: у него есть access_hash и нет refresh_hash. Условие
// «нет ни того, ни другого» держит именно этот случай — проверка на один refresh
// выдала бы каждый headless-токен за незавершённое подключение.
test('PAT в списке — подключённый доступ, а не брошенная попытка', async () => {
  await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  expect((await listGrants(db, owner))[0]).toMatchObject({ kind: 'pat', connected: true });
});

// Отзыв идемпотентен: второй вызов не двигает дату. Иначе на экране настроек дата отзыва
// прыгала бы на «сейчас» от повторного нажатия (или гонки двух вкладок), и владелец терял
// бы единственную улику о том, когда доступ на самом деле погас.
test('повторный отзыв не двигает дату отзыва', async () => {
  await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  const grant = (await listGrants(db, owner))[0];
  if (!grant) throw new Error('грант не создан');
  expect(await revokeGrant(db, { ownerId: owner, grantId: grant.id })).toBe(true);
  const first = (await listGrants(db, owner))[0]?.revokedAt;
  if (!first) throw new Error('первый отзыв не проставил дату');
  // Пауза обязательна: без неё «сейчас» второго отзыва совпало бы с первым с точностью
  // до разрешения часов, и тест прошёл бы при любой реализации.
  await Bun.sleep(20);
  // true, а не false: доступ владельца отозван — это и есть результат, о котором просили.
  // Отличать «уже было отозвано» от «грант не ваш» одним и тем же false значило бы
  // сделать невозможным честное сообщение об отказе на экране.
  expect(await revokeGrant(db, { ownerId: owner, grantId: grant.id })).toBe(true);
  const second = (await listGrants(db, owner))[0]?.revokedAt;
  expect(second?.getTime()).toBe(first.getTime());
});

// Два теста ниже держат ту же неподвижность штампа на ОСТАЛЬНЫХ путях отзыва (финальное
// ревью слайса, M1). Раньше COALESCE стоял только в revokeGrant, а гашение по признаку
// перехвата писало голое `new Date()` — и тот, у кого на руках спетый код или ротированный
// refresh, мог двигать дату отзыва вперёд сколько угодно, повторяя запрос. Улику о том,
// когда доступ на самом деле погас, владелец видит на экране «Агенты» ровно в этом поле,
// и стирать её предъявителем краденого нельзя.
test('повторный код не двигает дату уже проставленного отзыва', async () => {
  const clientId = await seedClient();
  const { verifier, challenge } = pkce();
  const code = await createAuthorizationCode(db, {
    ownerId: owner,
    clientId,
    label: 'Claude Code',
    redirectUri: REDIRECT,
    codeChallenge: challenge,
  });
  await exchangeAuthorizationCode(db, {
    code,
    codeVerifier: verifier,
    redirectUri: REDIRECT,
    clientId,
  });
  const grant = (await listGrants(db, owner))[0];
  if (!grant) throw new Error('грант не создан');
  expect(await revokeGrant(db, { ownerId: owner, grantId: grant.id })).toBe(true);
  const first = (await listGrants(db, owner))[0]?.revokedAt;
  if (!first) throw new Error('отзыв не проставил дату');
  // Пауза — как в тесте идемпотентности выше: без неё «сейчас» второго отзыва совпало бы
  // с первым по разрешению часов, и тест был бы зелёным при любой реализации.
  await Bun.sleep(20);
  await expect(
    exchangeAuthorizationCode(db, {
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      clientId,
    }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
  expect((await listGrants(db, owner))[0]?.revokedAt?.getTime()).toBe(first.getTime());
});

test('реплей ротированного refresh не двигает дату уже проставленного отзыва', async () => {
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
  // Ротация уводит прежний хеш в prev_refresh_hash — именно по нему опознаётся реплей.
  await rotateRefresh(db, { refreshToken: first.refreshToken, clientId });
  const grant = (await listGrants(db, owner))[0];
  if (!grant) throw new Error('грант не создан');
  expect(await revokeGrant(db, { ownerId: owner, grantId: grant.id })).toBe(true);
  const revokedAt = (await listGrants(db, owner))[0]?.revokedAt;
  if (!revokedAt) throw new Error('отзыв не проставил дату');
  await Bun.sleep(20);
  await expect(
    rotateRefresh(db, { refreshToken: first.refreshToken, clientId }),
  ).rejects.toMatchObject({ code: 'invalid_grant' });
  expect((await listGrants(db, owner))[0]?.revokedAt?.getTime()).toBe(revokedAt.getTime());
});

test('мусорный токен и токен без префикса отвергаются', async () => {
  expect(await verifyBearer(db, `orbis_at_${'ff'.repeat(32)}`)).toBeNull();
  expect(await verifyBearer(db, 'eyJhbGciOiJIUzI1NiJ9.подделка')).toBeNull();
});
