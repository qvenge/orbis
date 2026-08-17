// apps/server/src/routers/oauth.test.ts
// Владельческая половина OAuth (§9.3) — интеграционно: живая БД под ролью orbis_app и
// НАСТОЯЩИЙ appRouter через createCallerFactory (манера entity.test.ts/mcp.test.ts).
// Именно сюда ходит экран согласия: проверить запрос агента ДО показа кнопки, выдать код
// по нажатию «Разрешить», показать владельцу выданные доступы и отозвать любой.
//
// Публичная база фиксируется ЗДЕСЬ, а не берётся из окружения прогона: канонический
// ресурс считается от ORBIS_PUBLIC_URL, и сьют, полагающийся на её отсутствие, покраснел
// бы ровно в тот день, когда переменную добавят в apps/server/.env (мина, найденная
// пере-ревью Task 5 в token-endpoint.test.ts).
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { agentGrants, oauthClients } from '../db/schema';
import { exchangeAuthorizationCode, issuePatGrant, verifyBearer } from '../oauth/grants';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();
const { db, client: dbClient } = appDb();

const ORIGIN = 'https://orbis.example.com';
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = 'http://localhost:33418/callback';
/** PKCE-verifier в разрешённых RFC 7636 §4.1 пределах 43..128 и его S256-challenge. */
const VERIFIER = 'a'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

const savedOrigin = process.env.ORBIS_PUBLIC_URL;

const owner = freshUserId();
const stranger = freshUserId();

const createCaller = createCallerFactory(appRouter);
const ownerCaller = createCaller({
  actorUserId: owner,
  actorKind: 'owner',
  db,
  clientVersion: null,
});
const strangerCaller = createCaller({
  actorUserId: stranger,
  actorKind: 'owner',
  db,
  clientVersion: null,
});

beforeEach(async () => {
  process.env.ORBIS_PUBLIC_URL = ORIGIN;
  await truncateAll();
});
afterAll(async () => {
  if (savedOrigin === undefined) delete process.env.ORBIS_PUBLIC_URL;
  else process.env.ORBIS_PUBLIC_URL = savedOrigin;
  await dbClient.end();
});

/** Зарегистрированный клиент — ровно то, что оставляет за собой /oauth/register. */
async function seedClient(opts: { name?: string; redirectUris?: string[] } = {}): Promise<string> {
  const clientId = randomBytes(16).toString('hex');
  await db.insert(oauthClients).values({
    clientId,
    clientName: opts.name ?? 'Claude Code',
    redirectUris: opts.redirectUris ?? [REDIRECT],
  });
  return clientId;
}

/**
 * Код отказа, а не факт броска: `rejects.toThrow()` зелен и когда процедура отказала по
 * своей причине, и когда она упала на разборе входа или на опечатке в тесте.
 */
async function rejectCode(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (e) {
    return e instanceof TRPCError ? e.code : `не TRPCError: ${String(e)}`;
  }
  throw new Error('ожидался отказ, но вызов прошёл');
}

const consentInput = (clientId: string, over: Record<string, unknown> = {}) => ({
  clientId,
  redirectUri: REDIRECT,
  resource: RESOURCE,
  codeChallenge: CHALLENGE,
  codeChallengeMethod: 'S256' as const,
  ...over,
});

// ---------------------------------------------------------------------------
// Проверка запроса ДО показа кнопки
// ---------------------------------------------------------------------------

test('описание запроса отдаёт имя клиента', async () => {
  const clientId = await seedClient();
  const out = await ownerCaller.oauth.describeRequest({
    clientId,
    redirectUri: REDIRECT,
    resource: RESOURCE,
  });
  expect(out.clientName).toBe('Claude Code');
});

test('незарегистрированный redirect_uri отвергается до показа кнопки', async () => {
  const clientId = await seedClient();
  expect(
    await rejectCode(
      ownerCaller.oauth.describeRequest({
        clientId,
        redirectUri: 'http://localhost:9999/callback',
        resource: RESOURCE,
      }),
    ),
  ).toBe('BAD_REQUEST');
});

test('неизвестный клиент отвергается до показа кнопки', async () => {
  expect(
    await rejectCode(
      ownerCaller.oauth.describeRequest({
        clientId: 'нет такого',
        redirectUri: REDIRECT,
        resource: RESOURCE,
      }),
    ),
  ).toBe('BAD_REQUEST');
});

test('чужой resource отвергается', async () => {
  const clientId = await seedClient();
  expect(
    await rejectCode(
      ownerCaller.oauth.describeRequest({
        clientId,
        redirectUri: REDIRECT,
        resource: 'https://evil.example.com/mcp',
      }),
    ),
  ).toBe('BAD_REQUEST');
});

// Хвостовой слэш и отсутствие resource терпит /oauth/token (RFC 8707 §2, Task 6);
// экран согласия обязан быть не строже — иначе законный клиент упрётся в него раньше.
test('resource с хвостовым слэшем — тот же ресурс', async () => {
  const clientId = await seedClient();
  const out = await ownerCaller.oauth.describeRequest({
    clientId,
    redirectUri: REDIRECT,
    resource: `${RESOURCE}/`,
  });
  expect(out.clientName).toBe('Claude Code');
});

test('без resource запрос проходит', async () => {
  const clientId = await seedClient();
  const out = await ownerCaller.oauth.describeRequest({ clientId, redirectUri: REDIRECT });
  expect(out.clientName).toBe('Claude Code');
});

// Канонический ресурс берётся из ORBIS_PUBLIC_URL — той же правды, что у метаданных и
// /oauth/token: своё чтение переменной в роутере завело бы вторую. Проверяется сменой
// базы: годным становится ДРУГОЙ resource, а прежний перестаёт им быть.
test('канонический ресурс следует за публичной базой, а не за адресом запроса', async () => {
  process.env.ORBIS_PUBLIC_URL = 'https://other-base.example';
  const clientId = await seedClient();
  expect(
    await rejectCode(
      ownerCaller.oauth.describeRequest({ clientId, redirectUri: REDIRECT, resource: RESOURCE }),
    ),
  ).toBe('BAD_REQUEST');
  const out = await ownerCaller.oauth.describeRequest({
    clientId,
    redirectUri: REDIRECT,
    resource: 'https://other-base.example/mcp',
  });
  expect(out.clientName).toBe('Claude Code');
});

// Локальный стенд: переменной нет, сверять не с чем — запрос проходит, а не падает.
// В production такой ветки не бывает: без ORBIS_PUBLIC_URL процесс не поднимается
// (стартовый гейт assertPublicOriginConfigured, Task 3).
test('без публичной базы ресурс не сверяется, но и не роняет запрос', async () => {
  delete process.env.ORBIS_PUBLIC_URL;
  const clientId = await seedClient();
  const out = await ownerCaller.oauth.describeRequest({
    clientId,
    redirectUri: REDIRECT,
    resource: 'https://whatever.example/mcp',
  });
  expect(out.clientName).toBe('Claude Code');
});

// client_name полностью подконтролен тому, кто регистрируется, и ограничен только
// потолком тела в 16 КиБ: имя почти в 16 КиБ доехало бы до экрана согласия.
test('длинное имя клиента обрезается на сервере', async () => {
  const clientId = await seedClient({ name: 'ы'.repeat(5000) });
  const out = await ownerCaller.oauth.describeRequest({ clientId, redirectUri: REDIRECT });
  expect(out.clientName.length).toBeLessThanOrEqual(64);
  expect(out.clientName.endsWith('…')).toBe(true);
});

// Набивка пробелами — способ сделать обрезку бесполезной: имя `Claude<500 пробелов>Code`
// обрезалось бы в «Claude…», а `A<500 пробелов>B` — в почти пустую подпись.
test('набивка пробелами не съедает подпись при обрезке', async () => {
  const clientId = await seedClient({ name: `Claude${' '.repeat(500)}Code` });
  const out = await ownerCaller.oauth.describeRequest({ clientId, redirectUri: REDIRECT });
  expect(out.clientName).toBe('Claude Code');
});

// Обрезка по код-юнитам UTF-16 рубит суррогатную пару пополам, и это не теория: проба на
// живой базе показала, что оставшаяся половина пары ВМЕСТЕ со следующим за ней «…» уезжает
// в Postgres одним U+FFFD (хвост `1f642 d83d 2026` возвращается как `1f642 fffd`). Итог —
// метка гранта перестаёт совпадать с подписью, которую владелец видел на кнопке, а маркер
// обрезки исчезает. Прежний тест этого не ловил: «ы» — символ основной плоскости.
test('эмодзи в имени не рубится пополам при обрезке', async () => {
  const clientId = await seedClient({ name: '🙂'.repeat(200) });
  const shown = await ownerCaller.oauth.describeRequest({ clientId, redirectUri: REDIRECT });
  expect([...shown.clientName].length).toBeLessThanOrEqual(64);
  expect(shown.clientName.endsWith('…')).toBe(true);
  // Битой половины пары в строке быть не должно — иначе U+FFFD появится при первой же
  // записи в БД, а не на экране, и найдётся он много позже
  expect(shown.clientName).not.toContain('�');

  // Половина проверки — за поездку через Postgres: в JS оборванная пара ещё выглядит
  // целой строкой, и без этой части инвариант остался бы недоказанным.
  await ownerCaller.oauth.consent(consentInput(clientId));
  const [grant] = await ownerCaller.oauth.listGrants();
  expect(grant?.label).toBe(shown.clientName);
  expect(grant?.label.endsWith('…')).toBe(true);
});

// ---------------------------------------------------------------------------
// Согласие: выдача кода
// ---------------------------------------------------------------------------

test('согласие выдаёт код и возвращает адрес с state', async () => {
  const clientId = await seedClient();
  const { redirectTo } = await ownerCaller.oauth.consent(consentInput(clientId, { state: 'st-1' }));
  const url = new URL(redirectTo);
  expect(url.origin + url.pathname).toBe(REDIRECT);
  expect(url.searchParams.get('state')).toBe('st-1');
  expect(url.searchParams.get('code')?.startsWith('orbis_ac_')).toBe(true);
});

// state необязателен (RFC 6749 §4.1.1): не пришёл — в адрес возврата его класть нечего.
// Пустой `state=` клиент, сверяющий его строкой, счёл бы чужим ответом.
test('без state параметра state в адресе возврата нет', async () => {
  const clientId = await seedClient();
  const { redirectTo } = await ownerCaller.oauth.consent(consentInput(clientId));
  expect(new URL(redirectTo).searchParams.has('state')).toBe(false);
});

// Форма адреса — ещё не доказательство: процедура, вернувшая случайную строку нужного
// вида, прошла бы проверки выше целиком. Код обязан обмениваться на токены — то есть в
// строку гранта легли ИМЕННО тот redirect_uri, тот client_id и тот challenge.
test('выданный код обменивается на токены', async () => {
  const clientId = await seedClient();
  const { redirectTo } = await ownerCaller.oauth.consent(consentInput(clientId));
  const code = new URL(redirectTo).searchParams.get('code') ?? '';
  const pair = await exchangeAuthorizationCode(db, {
    code,
    codeVerifier: VERIFIER,
    redirectUri: REDIRECT,
    clientId,
  });
  const identity = await verifyBearer(db, pair.accessToken);
  expect(identity?.ownerId).toBe(owner);
});

// Задача 8, §4.14: радио на экране согласия обязано доехать до строки гранта. Без записи
// область осталась бы на DEFAULT 'full' — владелец выбрал бы «только исполнитель», а агент
// получил бы полный доступ, и молча.
test('согласие пишет выбранную область в грант', async () => {
  const clientId = await seedClient();
  await ownerCaller.oauth.consent(consentInput(clientId, { scope: 'worker' }));
  expect((await ownerCaller.oauth.listGrants())[0]).toMatchObject({ scope: 'worker' });
});

// Умолчание — полный доступ: экран согласия старого клиента (и любой вызов без поля)
// обязан вести себя ровно как до среза, а не терять доступ молча.
test('согласие без области выдаёт полный доступ', async () => {
  const clientId = await seedClient();
  await ownerCaller.oauth.consent(consentInput(clientId));
  expect((await ownerCaller.oauth.listGrants())[0]).toMatchObject({ scope: 'full' });
});

// Незнакомая область отвергается схемой, а не приводится к 'full': приведение молча
// расширяло бы доступ на опечатке в клиенте.
test('незнакомая область не принимается', async () => {
  const clientId = await seedClient();
  const call = ownerCaller.oauth.consent(consentInput(clientId, { scope: 'admin' }));
  expect(await rejectCode(call)).toBe('BAD_REQUEST');
});

// Подпись в списке «Агенты» — то же имя, что владелец видел на экране согласия, и та же
// обрезка: иначе в список уедет строка на 16 КиБ.
test('метка гранта — та же обрезанная подпись', async () => {
  const clientId = await seedClient({ name: 'ы'.repeat(5000) });
  const shown = await ownerCaller.oauth.describeRequest({ clientId, redirectUri: REDIRECT });
  await ownerCaller.oauth.consent(consentInput(clientId));
  const [grant] = await ownerCaller.oauth.listGrants();
  // Дословно то, что владелец видел на кнопке, а не что-нибудь ещё короткое: метка,
  // собранная из client_id, тоже уложилась бы в потолок и прошла проверку на длину.
  expect(grant?.label).toBe(shown.clientName);
  expect(grant?.label.length).toBeLessThanOrEqual(64);
});

// Границы 43..128 (RFC 7636 §4.1) — написанное правило, которое до этих тестов ничего не
// держало: замена схемы на голый z.string() сьют не роняла. Дыры в безопасности нет (PKCE
// не сойдётся при обмене), но правило либо проверяется, либо его не должно быть в коде.
const challengeBounds: Array<[number, boolean]> = [
  [42, false],
  [43, true],
  [128, true],
  [129, false],
];
for (const [len, accepted] of challengeBounds) {
  test(`code_challenge длиной ${len} ${accepted ? 'принимается' : 'отвергается'}`, async () => {
    const clientId = await seedClient();
    const call = ownerCaller.oauth.consent(
      consentInput(clientId, { codeChallenge: 'x'.repeat(len) }),
    );
    if (accepted) {
      const { redirectTo } = await call;
      expect(new URL(redirectTo).searchParams.get('code')?.startsWith('orbis_ac_')).toBe(true);
    } else {
      expect(await rejectCode(call)).toBe('BAD_REQUEST');
      expect(await db.select().from(agentGrants)).toHaveLength(0);
    }
  });
}

test('метод plain отвергается', async () => {
  const clientId = await seedClient();
  expect(
    await rejectCode(
      ownerCaller.oauth.consent(consentInput(clientId, { codeChallengeMethod: 'plain' })),
    ),
  ).toBe('BAD_REQUEST');
  expect(await db.select().from(agentGrants)).toHaveLength(0);
});

// Проверка запроса обязана стоять и на самом согласии, а не только в describeRequest:
// процедуру зовут по HTTP, и экран согласия её не охраняет — незарегистрированный
// адрес иначе увёл бы код куда угодно.
test('согласие не выдаёт код на незарегистрированный redirect_uri', async () => {
  const clientId = await seedClient();
  expect(
    await rejectCode(
      ownerCaller.oauth.consent(consentInput(clientId, { redirectUri: 'https://evil.example/cb' })),
    ),
  ).toBe('BAD_REQUEST');
  expect(await db.select().from(agentGrants)).toHaveLength(0);
});

test('согласие не выдаёт код неизвестному клиенту', async () => {
  expect(await rejectCode(ownerCaller.oauth.consent(consentInput('нет такого')))).toBe(
    'BAD_REQUEST',
  );
  expect(await db.select().from(agentGrants)).toHaveLength(0);
});

// Адрес возврата с УЖЕ имеющимся query законен (RFC 6749 §3.1.2), реальный пример —
// `https://claude.ai/api/mcp/auth_callback?tenant=acme`. Склейка `${uri}?code=…` приклеила
// бы код значением к чужому параметру: `searchParams.get('code')` дал бы null, клиент кода
// не увидел бы, и вход молча не состоялся бы.
test('адрес возврата с существующим query не теряет ни код, ни чужой параметр', async () => {
  const withQuery = 'https://claude.ai/api/mcp/auth_callback?tenant=acme';
  const clientId = await seedClient({ redirectUris: [withQuery] });
  const { redirectTo } = await ownerCaller.oauth.consent(
    consentInput(clientId, { redirectUri: withQuery, state: 'st-2' }),
  );
  const url = new URL(redirectTo);
  expect(url.searchParams.get('tenant')).toBe('acme');
  expect(url.searchParams.get('code')?.startsWith('orbis_ac_')).toBe(true);
  expect(url.searchParams.get('state')).toBe('st-2');
});

// Не-ASCII в адресе возврата регистрацию проходит (кириллица не пробел и не управляющий
// символ), а СЫРАЯ строка в заголовке Location бросает «invalid value» — это 500 вместо
// возврата кода владельцу. `.href` процентно кодирует и снимает это.
test('не-ASCII в адресе возврата даёт годный Location', async () => {
  const cyrillic = 'http://localhost:33418/cb?next=привет';
  const clientId = await seedClient({ redirectUris: [cyrillic] });
  const { redirectTo } = await ownerCaller.oauth.consent(
    consentInput(clientId, { redirectUri: cyrillic }),
  );
  expect(() => new Headers({ Location: redirectTo })).not.toThrow();
  const url = new URL(redirectTo);
  expect(url.searchParams.get('next')).toBe('привет');
  expect(url.searchParams.get('code')?.startsWith('orbis_ac_')).toBe(true);
});

// ---------------------------------------------------------------------------
// Список и отзыв доступов
// ---------------------------------------------------------------------------

test('агент не управляет доступами через tRPC', async () => {
  const clientId = await seedClient();
  const agentCaller = createCaller({
    actorUserId: owner,
    actorKind: 'agent',
    db,
    clientVersion: null,
  });
  expect(
    await rejectCode(
      agentCaller.oauth.describeRequest({ clientId, redirectUri: REDIRECT, resource: RESOURCE }),
    ),
  ).toBe('FORBIDDEN');
  expect(await rejectCode(agentCaller.oauth.consent(consentInput(clientId)))).toBe('FORBIDDEN');
  expect(await rejectCode(agentCaller.oauth.listGrants())).toBe('FORBIDDEN');
  expect(await rejectCode(agentCaller.oauth.revokeGrant({ grantId: crypto.randomUUID() }))).toBe(
    'FORBIDDEN',
  );
  // Отказ обязан быть настоящим: строки гранта после него быть не должно
  expect(await db.select().from(agentGrants)).toHaveLength(0);
});

// Таймстампы наружу — ISO-строками, как у всех wire-форм (wire.ts): по HTTP Date всё равно
// уезжает строкой (проверено пробой), и форма обязана говорить это прямо. Тест пинит
// РАНТАЙМ-форму, а не защиту от падения: типом клиент не обманулся бы и на доменной форме —
// tRPC 11 сам сводит Date к string через Serialize<> (ревью Task 7 проверило компилятором,
// прежнее обоснование про TypeError на экране было неверным).
test('таймстампы доступов уезжают ISO-строками, а не Date', async () => {
  await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  const [grant] = await ownerCaller.oauth.listGrants();
  expect(typeof grant?.createdAt).toBe('string');
  // UTC с суффиксом 'Z', а не '+00:00' — соглашение wire.ts
  expect(grant?.createdAt).toMatch(/Z$/);
  // Пустые отметки остаются null, а не превращаются в «Invalid Date»
  expect(grant?.lastUsedAt).toBeNull();
  expect(grant?.revokedAt).toBeNull();
});

// Признак «агент забрал токены» обязан доехать до экрана: строка гранта создаётся в
// момент согласия, и без него экран настроек выдаёт брошенную попытку авторизации за
// подключённого агента.
test('брошенная попытка авторизации доезжает до экрана неподключённой', async () => {
  const clientId = await seedClient();
  await ownerCaller.oauth.consent(consentInput(clientId));
  expect((await ownerCaller.oauth.listGrants())[0]).toMatchObject({ connected: false });
  await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  const pat = (await ownerCaller.oauth.listGrants()).find((g) => g.kind === 'pat');
  expect(pat).toMatchObject({ connected: true });
});

// Область — часть wire-формы гранта (WireAgentGrant.scope): по ней экран «Агенты» рисует
// бейдж, и без поля владелец не отличает полный доступ от исполнителя.
test('область доступа доезжает до экрана', async () => {
  await issuePatGrant(db, { ownerId: owner, label: 'исполнитель', scope: 'worker' });
  const [grant] = await ownerCaller.oauth.listGrants();
  expect(grant?.scope).toBe('worker');
});

test('список доступов скоупится владельцем', async () => {
  await issuePatGrant(db, { ownerId: owner, label: 'мой CI' });
  await issuePatGrant(db, { ownerId: stranger, label: 'чужой CI' });
  const mine = await ownerCaller.oauth.listGrants();
  expect(mine).toHaveLength(1);
  expect(mine[0]?.label).toBe('мой CI');
});

test('отзыв гасит грант владельца', async () => {
  const token = await issuePatGrant(db, { ownerId: owner, label: 'CI' });
  const [grant] = await ownerCaller.oauth.listGrants();
  if (!grant) throw new Error('список доступов пуст');
  expect(await ownerCaller.oauth.revokeGrant({ grantId: grant.id })).toEqual({ revoked: true });
  expect(await verifyBearer(db, token)).toBeNull();
});

// Идентификатор гранта угадывать не нужно — он приезжает снаружи: отзыв обязан скоупиться
// владельцем, иначе один аккаунт гасит доступы другого.
test('чужой грант не отзывается', async () => {
  const token = await issuePatGrant(db, { ownerId: stranger, label: 'чужой CI' });
  const [grant] = await strangerCaller.oauth.listGrants();
  if (!grant) throw new Error('список доступов чужого владельца пуст');
  expect(await ownerCaller.oauth.revokeGrant({ grantId: grant.id })).toEqual({ revoked: false });
  expect(await verifyBearer(db, token)).not.toBeNull();
});
