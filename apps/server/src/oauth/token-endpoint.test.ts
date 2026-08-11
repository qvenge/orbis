// apps/server/src/oauth/token-endpoint.test.ts
// POST /oauth/token — интеграционно: живая БД под ролью orbis_app и НАСТОЯЩЕЕ приложение
// (createApp), а не голая Hono с примонтированным хендлером. Причина та же, что у
// register.test.ts: половина контракта этого эндпоинта — сам факт монтирования по адресу
// из `token_endpoint` метаданных, и незарегистрированный роут отдал бы клиенту 404 при
// полностью исправном модуле.
//
// Публичная база фиксируется ЗДЕСЬ, а не берётся из окружения прогона: `canonicalResource`
// читает ORBIS_PUBLIC_URL, и сьют, полагающийся на её отсутствие, покраснел бы ровно в тот
// день, когда переменную добавят в apps/server/.env (мина, найденная пере-ревью Task 5).
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import type { AiDeps } from '../ai/send-message';
import { createApp } from '../app';
import type { Db } from '../db/client';
import { agentGrants, oauthClients } from '../db/schema';
import { createAuthorizationCode, verifyBearer } from './grants';
// Потолок тела импортируется (манера register.test.ts), чтобы строить сверхлимитное тело
// ОТ него; само значение отдельно пинится числом ниже.
import { makeTokenHandler, TOKEN_MAX_BODY_BYTES } from './token-endpoint';

requireEnv();
const { db, client: dbClient } = appDb();

const ORIGIN = 'https://orbis.example.com';
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = 'http://localhost:33418/callback';
/** PKCE-verifier: длина в разрешённых RFC 7636 пределах 43..128. */
const VERIFIER = 'a'.repeat(64);
const FORM = 'application/x-www-form-urlencoded';

const savedOrigin = process.env.ORBIS_PUBLIC_URL;

// Статики на этом пути нет и быть не может: каталог заведомо отсутствует, чтобы
// serveStatic ничего не подменил, а роут проверялся сам по себе.
const app = createApp({ db, ai: {} as AiDeps, webDistDir: '/nonexistent-orbis-dist' });

beforeEach(async () => {
  process.env.ORBIS_PUBLIC_URL = ORIGIN;
  await truncateAll();
});
afterAll(async () => {
  if (savedOrigin === undefined) delete process.env.ORBIS_PUBLIC_URL;
  else process.env.ORBIS_PUBLIC_URL = savedOrigin;
  await dbClient.end();
});

function postRaw(body: BodyInit, contentType: string | null = FORM): Promise<Response> {
  const headers: Record<string, string> = {};
  if (contentType !== null) headers['content-type'] = contentType;
  return Promise.resolve(app.request('/oauth/token', { method: 'POST', headers, body }));
}

const postForm = (fields: Record<string, string>, contentType?: string | null): Promise<Response> =>
  postRaw(new URLSearchParams(fields).toString(), contentType === undefined ? FORM : contentType);

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

const json = async (res: Response): Promise<TokenBody> => (await res.json()) as TokenBody;

const challengeFor = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

let seq = 0;

/**
 * Строка гранта с живым кодом — ровно то, что оставляет за собой экран согласия.
 * Клиент регистрируется прежде: `agent_grants.client_id` — внешний ключ на `oauth_clients`,
 * и грант без зарегистрированного клиента база просто не примет.
 */
async function seedCode(): Promise<{ code: string; verifier: string; clientId: string }> {
  const clientId = `клиент-${++seq}`;
  await db
    .insert(oauthClients)
    .values({ clientId, clientName: 'Claude Code', redirectUris: [REDIRECT] })
    .onConflictDoNothing();
  const code = await createAuthorizationCode(db, {
    ownerId: freshUserId(),
    clientId,
    label: 'проба',
    redirectUri: REDIRECT,
    codeChallenge: challengeFor(VERIFIER),
  });
  return { code, verifier: VERIFIER, clientId };
}

const exchangeFields = (seeded: { code: string; verifier: string; clientId: string }) => ({
  grant_type: 'authorization_code',
  code: seeded.code,
  code_verifier: seeded.verifier,
  redirect_uri: REDIRECT,
  client_id: seeded.clientId,
  resource: RESOURCE,
});

/** Полный успешный обмен: то, с чего начинается любая проверка ротации. */
async function exchangeSeeded(): Promise<TokenBody & { clientId: string }> {
  const seeded = await seedCode();
  const res = await postForm(exchangeFields(seeded));
  expect(res.status).toBe(200);
  return { ...(await json(res)), clientId: seeded.clientId };
}

/** Единственная строка грантов в базе — сьют сеет ровно одну и чистит перед каждым тестом. */
async function onlyGrant() {
  const rows = await db.select().from(agentGrants);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error('строка гранта пропала');
  return row;
}

// ---------------------------------------------------------------------------
// Обмен кода
// ---------------------------------------------------------------------------

test('authorization_code отдаёт пару токенов в форме OAuth', async () => {
  const seeded = await seedCode();
  const res = await postForm(exchangeFields(seeded));
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.token_type).toBe('Bearer');
  expect(body.expires_in).toBe(3600);
  // Префиксы, а не `typeof === 'string'`: перепутанные местами поля пары прошли бы
  // проверку на тип и оставили клиента с refresh'ом в заголовке Authorization.
  expect(body.access_token).toMatch(/^orbis_at_[0-9a-f]{64}$/);
  expect(body.refresh_token).toMatch(/^orbis_rt_[0-9a-f]{64}$/);
  // Область объявлена в метаданных (`scopes_supported: ['full']`) — молчаливая пропажа
  // поля всплыла бы только на строгом клиенте.
  expect(body.scope).toBe('full');
  expect(res.headers.get('cache-control')).toBe('no-store');
});

// Форма ответа — ещё не доказательство: хендлер, вернувший две случайные строки нужного
// вида, прошёл бы проверку выше целиком.
test('выданный access-токен действительно открывает доступ', async () => {
  const body = await exchangeSeeded();
  const token = body.access_token;
  if (!token) throw new Error('обмен не вернул access_token');
  const identity = await verifyBearer(db, token);
  expect(identity).not.toBeNull();
  expect(identity?.ownerId).toBe((await onlyGrant()).ownerId);
});

// Требование, вытекающее из Task 2: повторное предъявление кода наш модуль трактует как
// перехват и гасит грант целиком. Значит автоматического повтора на этом эндпоинте быть
// не должно — успешный обмен обязан оставлять грант ЖИВЫМ.
test('успешный обмен не отзывает грант: автоматического повтора нет', async () => {
  await exchangeSeeded();
  const row = await onlyGrant();
  expect(row.codeUsedAt).not.toBeNull();
  expect(row.revokedAt).toBeNull();
});

// Обратная сторона того же требования: клиент, повторивший запрос сам, теряет доступ.
// Это и есть цена, которую платит ретрай — поэтому его здесь нет.
test('повторный обмен того же кода отвергается и гасит грант', async () => {
  const seeded = await seedCode();
  expect((await postForm(exchangeFields(seeded))).status).toBe(200);
  const second = await postForm(exchangeFields(seeded));
  expect(second.status).toBe(400);
  expect((await json(second)).error).toBe('invalid_grant');
  expect((await onlyGrant()).revokedAt).not.toBeNull();
});

// ---------------------------------------------------------------------------
// resource (RFC 8707)
// ---------------------------------------------------------------------------

test('чужой resource отвергается как invalid_target', async () => {
  const seeded = await seedCode();
  const res = await postForm({
    ...exchangeFields(seeded),
    resource: 'https://evil.example.com/mcp',
  });
  expect(res.status).toBe(400);
  expect((await json(res)).error).toBe('invalid_target');
  // Отказ обязан случиться ДО обмена: сожжённый код оставил бы законного клиента без
  // доступа из-за чужой строки в его же запросе.
  expect((await onlyGrant()).codeUsedAt).toBeNull();
});

test('resource с хвостовым слэшем — тот же ресурс', async () => {
  const seeded = await seedCode();
  const res = await postForm({ ...exchangeFields(seeded), resource: `${RESOURCE}/` });
  expect(res.status).toBe(200);
});

// Не все клиенты шлют resource, и отказ им закрыл бы вход вовсе.
test('без resource обмен проходит', async () => {
  const seeded = await seedCode();
  const { resource: _drop, ...fields } = exchangeFields(seeded);
  expect((await postForm(fields)).status).toBe(200);
});

// Канонический URI берётся из ORBIS_PUBLIC_URL, а не из адреса запроса (у которого под
// `app.request` origin вообще `http://localhost`): своё чтение переменной в модуле развело
// бы две правды об одном и том же ресурсе. Проверяется сменой базы: годным становится
// ДРУГОЙ resource, а прежний перестаёт им быть.
test('канонический ресурс следует за публичной базой, а не за адресом запроса', async () => {
  process.env.ORBIS_PUBLIC_URL = 'https://other-base.example';
  const seeded = await seedCode();
  const stale = await postForm({ ...exchangeFields(seeded), resource: RESOURCE });
  expect(stale.status).toBe(400);
  expect((await json(stale)).error).toBe('invalid_target');
  const fresh = await postForm({
    ...exchangeFields(seeded),
    resource: 'https://other-base.example/mcp',
  });
  expect(fresh.status).toBe(200);
});

// ---------------------------------------------------------------------------
// grant_type и client_id
// ---------------------------------------------------------------------------

test('неизвестный grant_type отвергается', async () => {
  const res = await postForm({ grant_type: 'password', username: 'a', password: 'b' });
  expect(res.status).toBe(400);
  expect((await json(res)).error).toBe('unsupported_grant_type');
});

// Отсутствующий обязательный параметр — это invalid_request, а не «тип не поддержан»
// (RFC 6749 §5.2): разработчику чужого агента иначе не отличить опечатку от пропажи.
test('grant_type не назван вовсе — invalid_request', async () => {
  const res = await postForm({ client_id: 'x' });
  expect(res.status).toBe(400);
  expect((await json(res)).error).toBe('invalid_request');
});

// invalid_client отдаётся кодом 400, а не 401: клиенты у нас публичные
// (`token_endpoint_auth_method: 'none'`), Authorization они не шлют, и 401 обязал бы нас
// выдать WWW-Authenticate со схемой, которой у этого эндпоинта нет (RFC 9110 §15.5.2).
test('без client_id — invalid_client кодом 400 и без WWW-Authenticate', async () => {
  const seeded = await seedCode();
  const { client_id: _drop, ...fields } = exchangeFields(seeded);
  const res = await postForm(fields);
  expect(res.status).toBe(400);
  expect((await json(res)).error).toBe('invalid_client');
  expect(res.headers.get('www-authenticate')).toBeNull();
});

// ---------------------------------------------------------------------------
// Ротация refresh
// ---------------------------------------------------------------------------

test('refresh_token выдаёт новую пару', async () => {
  const first = await exchangeSeeded();
  const refreshToken = first.refresh_token;
  if (!refreshToken) throw new Error('обмен не вернул refresh_token');
  const res = await postForm({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: first.clientId,
  });
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.access_token).not.toBe(first.access_token);
  // Ротация обязана менять и refresh: неизменный означал бы, что старый токен остался
  // действительным, а вся защита от реплея держится на его смене (OAuth 2.1 §7.5).
  expect(body.refresh_token).not.toBe(first.refresh_token);
  expect(res.headers.get('cache-control')).toBe('no-store');
});

// ---------------------------------------------------------------------------
// Форма отказов
// ---------------------------------------------------------------------------

test('ошибка домена не течёт стеком — только форма OAuth', async () => {
  const res = await postForm({
    grant_type: 'authorization_code',
    code: `orbis_ac_${'ab'.repeat(32)}`,
    code_verifier: 'x',
    redirect_uri: REDIRECT,
    client_id: 'нет такого',
  });
  expect(res.status).toBe(400);
  const body = await json(res);
  expect(body.error).toBe('invalid_grant');
  expect(typeof body.error_description).toBe('string');
  expect(JSON.stringify(body)).not.toContain('at ');
});

// no-store — свойство эндпоинта, а не одной удачной ветки: кэшу нечего держать ни от
// успеха, ни от отказа.
test('ответ на отказ тоже не кэшируется', async () => {
  const res = await postForm({ grant_type: 'password' });
  expect(res.status).toBe(400);
  expect(res.headers.get('cache-control')).toBe('no-store');
});

// Единственная ветка, до которой живая база не доводит: инфраструктурный сбой. Наружу
// обязана уйти обезличенная ошибка, а оригинал — в серверный лог; хендлер, вернувший
// `String(e)`, отдал бы клиенту текст запроса с хешем кода и трейс драйвера.
test('инфраструктурный сбой — 500 без подробностей, оригинал в лог', async () => {
  const broken = new Hono();
  const boom = new Error('пул соединений мёртв: connect ECONNREFUSED 127.0.0.1:54322');
  broken.post(
    '/oauth/token',
    makeTokenHandler({
      db: {
        select() {
          throw boom;
        },
      } as unknown as Db,
    }),
  );

  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  let res: Response;
  try {
    res = await broken.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': FORM },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'orbis_ac_нет',
        code_verifier: 'x',
        redirect_uri: REDIRECT,
        client_id: 'x',
      }).toString(),
    });
  } finally {
    console.error = realError;
  }

  expect(res.status).toBe(500);
  const body = await json(res);
  expect(body.error).toBe('server_error');
  expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  // Молча глотать сбой тоже нельзя: без записи в лог отказ некому расследовать.
  expect(logged.flat()).toContain(boom);
});

// ---------------------------------------------------------------------------
// Разбор тела: почему не c.req.parseBody()
// ---------------------------------------------------------------------------

// Живая проба Hono 4.12.27: `parseBody()` зовёт `request.formData()` и на битом multipart
// БРОСАЕТ TypeError («FormData parse error missing final boundary»). В хендлере этот бросок
// поймал бы общий catch и превратил в 500 с записью в серверный лог — то есть любой
// неаутентифицированный отправитель дёргал бы нам пятисотки двумя строками тела.
const notForm: Array<[string, string, string]> = [
  [
    'multipart/form-data; boundary=XX',
    '--XX\r\nContent-Disposition: form-data; name="grant_type"',
    'битый multipart — parseBody на нём бросает',
  ],
  ['multipart/form-data', 'мусор', 'multipart без boundary — parseBody тоже бросает'],
  [
    'multipart/form-data; boundary=XX',
    '--XX\r\nContent-Disposition: form-data; name="grant_type"\r\n\r\nauthorization_code\r\n--XX--\r\n',
    'корректный multipart — спекой на token endpoint не разрешён',
  ],
  ['application/json', '{"grant_type":"authorization_code"}', 'JSON вместо формы'],
  ['text/plain;charset=UTF-8', 'grant_type=authorization_code', 'text/plain'],
];
for (const [contentType, body, why] of notForm) {
  test(`тело не в форме (${why}) — отказ по спеке, а не 500`, async () => {
    const res = await postRaw(body, contentType);
    expect(res.status).toBe(400);
    const parsed = await json(res);
    expect(parsed.error).toBe('invalid_request');
    expect(parsed.error_description).toContain('x-www-form-urlencoded');
  });
}

// Медиатип регистронезависим (RFC 9110 §8.3), а `parseBody()` сверяет его через
// case-sensitive startsWith: клиент, поступающий строго по спеке, получал бы от него
// пустую форму и невнятный отказ.
test('Content-Type в верхнем регистре — тот же тип', async () => {
  const seeded = await seedCode();
  const res = await postRaw(
    new URLSearchParams(exchangeFields(seeded)).toString(),
    'APPLICATION/X-WWW-FORM-URLENCODED; CHARSET=UTF-8',
  );
  expect(res.status).toBe(200);
});

test('Content-Type с параметрами и пробелами принимается', async () => {
  const seeded = await seedCode();
  const res = await postRaw(
    new URLSearchParams(exchangeFields(seeded)).toString(),
    'application/x-www-form-urlencoded ;charset=utf-8',
  );
  expect(res.status).toBe(200);
});

test('пустое тело — отказ формой OAuth, а не 500', async () => {
  const res = await postRaw('', FORM);
  expect(res.status).toBe(400);
  expect((await json(res)).error).toBe('invalid_request');
});

// Параметр, названный дважды, спекой запрещён (OAuth 2.1 §1.5). Разбор через
// URLSearchParams.get берёт ПЕРВОЕ вхождение — то есть дописанное следом значение
// исходный запрос не переопределяет.
test('дубль параметра не переопределяет первое значение', async () => {
  const seeded = await seedCode();
  const res = await postRaw(
    `${new URLSearchParams(exchangeFields(seeded)).toString()}&grant_type=password`,
  );
  expect(res.status).toBe(200);
});

// ---------------------------------------------------------------------------
// Потолок тела
// ---------------------------------------------------------------------------
//
// Эндпоинт публичный и неаутентифицированный, как /oauth/register: без потолка тело на
// любое число мегабайт принималось бы и разбиралось целиком.
test('потолок тела — размер пинится числом, а не импортом', () => {
  // Замер законного тела (проба): обмен кода — 402 байта, с размещённым клиентом и его
  // длинным redirect_uri — 473, ротация refresh — 208. Значение держится числом:
  // молчаливое разрастание потолка вернуло бы ровно ту дыру, ради которой он появился.
  expect(TOKEN_MAX_BODY_BYTES).toBe(4 * 1024);
});

test('тело сверх потолка — 413 формой OAuth, до разбора', async () => {
  const seeded = await seedCode();
  const oversized = new URLSearchParams({
    ...exchangeFields(seeded),
    padding: 'x'.repeat(TOKEN_MAX_BODY_BYTES),
  }).toString();
  const res = await postRaw(oversized);
  expect(res.status).toBe(413);
  const body = await json(res);
  // Форма — спецификационная { error, error_description }, а не структурная { error: { code } }
  expect(body.error).toBe('invalid_request');
  expect(typeof body.error_description).toBe('string');
  // Гейт стоит ДО обмена: код обязан остаться неиспользованным
  expect((await onlyGrant()).codeUsedAt).toBeNull();
});

test('тело под потолком проходит гейт', async () => {
  const seeded = await seedCode();
  const padded = new URLSearchParams({
    ...exchangeFields(seeded),
    padding: 'x'.repeat(TOKEN_MAX_BODY_BYTES - 900),
  }).toString();
  expect(padded.length).toBeLessThan(TOKEN_MAX_BODY_BYTES);
  expect((await postRaw(padded)).status).toBe(200);
});

// Chunked-тело без content-length: заголовочный пред-чек тут не срабатывает вовсе, и
// потолок обязан считаться по фактически прочитанным байтам (та же дыра, что закрывалась
// на /mcp и на /oauth/register).
test('сверхбольшое тело без content-length тоже режется', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('grant_type=authorization_code&padding='));
      for (let i = 0; i < 4; i++) controller.enqueue(enc.encode('x'.repeat(4096)));
      controller.close();
    },
  });
  const res = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': FORM },
    body: stream,
    // @ts-expect-error duplex — обязателен для стримового тела в fetch-совместимом Request
    duplex: 'half',
  });
  expect(res.status).toBe(413);
});
