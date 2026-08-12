// apps/server/src/oauth/oauth.e2e.test.ts
// Сквозная приёмка слайса 4b (§9.3): путь внешнего агента ЦЕЛИКОМ — от первого запроса
// без токена до отозванного доступа. Восемь модулей слайса (метаданные, DCR, согласие,
// обмен кода, транспорт /mcp, журнал, список «Агенты», отзыв) написаны и отревьюены
// ПОРОЗНЬ; здесь единственная проверка того, что они СТЫКУЮТСЯ.
//
// Подменён ровно один шаг — браузерный: вместо человека, жмущего «Разрешить» на
// /oauth/authorize, согласие даёт tRPC-caller владельца (та же процедура oauth.consent,
// в которую ходит экран). Всё остальное проходит настоящий MCP-клиент из SDK и обычный
// fetch по адресам, ВЫЧИТАННЫМ ИЗ МЕТАДАННЫХ.
//
// Тест НЕ ЗНАЕТ ни одного адреса, кроме того, который агенту даёт человек: `<origin>/mcp`.
// Каждый следующий шаг берёт адрес из ответа предыдущего: 401 → resource_metadata из
// WWW-Authenticate → authorization_servers из метаданных ресурса → registration_endpoint
// и token_endpoint из метаданных AS → resource оттуда же и в согласие, и в тело обмена, и
// в транспорт SDK. Разъедься любая пара (роут переехал, метаданные назвали чужой origin,
// канонический resource разошёлся между metadata.ts, routers/oauth.ts и token-endpoint.ts)
// — краснеет именно этот тест, а не «всё зелено, а агент не подключается». Проверено
// пробой: подмена registration_endpoint и адреса в WWW-Authenticate валит файл.
//
// Приложение собирается настоящим createApp: половина контракта слайса — сам факт
// монтирования роутов и ПОРЯДОК их регистрации (SPA-fallback не должен съедать
// /.well-known/*). Изолированный Hono с примонтированным хендлером это пропустил бы.
//
// Прогон: bun test --env-file apps/server/.env apps/server/src/oauth/oauth.e2e.test.ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { globalThreadId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import type { AiDeps } from '../ai/send-message';
import { createApp } from '../app';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import type { ActionRecord, WireEntity } from '../executor/types';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client: dbClient } = appDb();
const owner = freshUserId();

/** Адрес возврата в манере Claude Code — локальная петля (register.ts: RFC 8252 §7.3). */
const REDIRECT = 'http://localhost:8080/callback';
/** Подпись клиента при регистрации: она же обязана стать меткой гранта в «Агентах». */
const CLIENT_NAME = 'Claude Code';

const ownerCaller = createCallerFactory(appRouter)({
  actorUserId: owner,
  actorKind: 'owner',
  db,
  clientVersion: null,
});

let server: ReturnType<typeof Bun.serve>;
let origin: string;
const savedPublicUrl = process.env.ORBIS_PUBLIC_URL;

/** Сущность, созданную агентом по OAuth-токену, второй тест ищет в журнале по id. */
let createdByAgentId: string;

// --- документы обнаружения (описаны ровно теми полями, которые тест читает) ---

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  resource_name: string;
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
}

interface RegistrationResponse {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/**
 * Первый элемент с внятным сообщением вместо `!`: при noUncheckedIndexedAccess индекс —
 * это `T | undefined`, а пустой список в любом из документов обнаружения означает
 * оборванную цепочку, и падать надо с названием оборванного места, а не «undefined».
 */
function first<T>(list: readonly T[] | undefined, what: string): T {
  const value = list?.[0];
  if (value === undefined) throw new Error(`${what}: список пуст — цепочка обнаружения оборвана`);
  return value;
}

/** PKCE (RFC 7636): challenge = base64url(sha256(verifier)), метод S256. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * Адрес метаданных authorization server из его issuer по RFC 8414 §3: well-known-сегмент
 * вставляется МЕЖДУ хостом и путём issuer'а. Наш issuer — чистый origin, и склейка дала
 * бы то же самое, но вывод честнее: появись у issuer путь, тест пойдёт туда, куда пошёл
 * бы настоящий клиент, а не туда, где документ лежал раньше.
 */
function asMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

/** JSON-ответ с проверкой кода: 404 от переехавшего роута иначе всплыл бы как SyntaxError. */
async function getJson<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url);
  expect(res.status, `${what} (${url})`).toBe(200);
  expect(res.headers.get('content-type'), `${what}: content-type`).toContain('json');
  return (await res.json()) as T;
}

/**
 * JSON-RPC-запрос к /mcp сырым fetch — для проверок ДО и ПОСЛЕ жизни токена. Запрос
 * ПОЛНОЦЕННЫЙ, с accept обоих медиатипов, как шлёт SDK: без него транспорт отвечает 406,
 * и «после отзыва не пускает» осталось бы зелёным даже на сломанной проверке отзыва —
 * красный был бы просто другого цвета. С accept единственная причина не-200 здесь —
 * аутентификация (проверено пробой: снимаешь условие revoked_at в verifyBearer — ответ
 * становится 200).
 */
function postMcp(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

beforeAll(async () => {
  await truncateAll();
  // webDistDir — заведомо несуществующий каталог: статика этому тесту не нужна, а
  // SPA-fallback не должен перехватывать /.well-known/* (приём static.test.ts:42).
  // ai: {} as AiDeps — AI-слоя на проверяемых путях нет; при случайном обращении упадёт
  // громко, а не подменит поведение.
  const app = createApp({ db, ai: {} as AiDeps, webDistDir: '/nonexistent-web-dist' });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  origin = `http://127.0.0.1:${server.port}`;
  // Метаданные обязаны называть ТОТ ЖЕ origin, на котором мы слушаем: иначе сверка
  // `resource` при обмене кода (token-endpoint.ts) отвергнет запрос как чужой.
  process.env.ORBIS_PUBLIC_URL = origin;
});

afterAll(async () => {
  server?.stop(true);
  if (savedPublicUrl === undefined) delete process.env.ORBIS_PUBLIC_URL;
  else process.env.ORBIS_PUBLIC_URL = savedPublicUrl;
  await dbClient.end();
});

test('путь агента целиком: 401 → метаданные → DCR → согласие → токен → тулы → отзыв', async () => {
  // --- 1. Единственный адрес, который агент знает от человека: сам эндпоинт MCP ---
  const unauth = await postMcp(`${origin}/mcp`);
  expect(unauth.status).toBe(401);
  // RFC 9728 §5.1: без этого указателя клиент видит «нужна авторизация», но не знает куда
  // идти — браузерный вход не начинается вовсе.
  const challengeHeader = unauth.headers.get('www-authenticate') ?? '';
  const metaUrl = /resource_metadata="([^"]+)"/.exec(challengeHeader)?.[1];
  if (metaUrl === undefined) throw new Error(`в WWW-Authenticate нет адреса: «${challengeHeader}»`);
  // Указатель ведёт на нас, а не на чужой хост из подменённого заголовка Host
  expect(new URL(metaUrl).origin).toBe(origin);

  // --- 2. Метаданные ресурса → метаданные authorization server ---
  const prm = await getJson<ProtectedResourceMetadata>(metaUrl, 'метаданные ресурса');
  // Владелец увидит это имя на экране согласия
  expect(prm.resource_name).toBe('Orbis');
  const issuer = first(prm.authorization_servers, 'authorization_servers');
  const asMeta = await getJson<AuthorizationServerMetadata>(
    asMetadataUrl(issuer),
    'метаданные authorization server',
  );
  expect(asMeta.issuer).toBe(issuer);
  // Единственная сверка с литералом во всём пути обнаружения — и она осмысленная: агент
  // пришёл на `<origin>/mcp` и обязан получить документ, называющий ТОТ ЖЕ адрес. Назови
  // метаданные другой ресурс — токен выписался бы «для другого сервера», и агент ходил бы
  // им на эндпоинт, которому он не предназначен. Дальше по файлу адрес /mcp не пишется
  // руками ни разу: и SDK-транспорт, и проверка после отзыва идут по prm.resource.
  expect(prm.resource).toBe(`${origin}/mcp`);

  // --- 3. Динамическая регистрация клиента (RFC 7591) ---
  const regRes = await fetch(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [REDIRECT] }),
  });
  expect(regRes.status, `регистрация (${asMeta.registration_endpoint})`).toBe(201);
  const reg = (await regRes.json()) as RegistrationResponse;
  expect(reg.client_id).toMatch(/^[0-9a-f]{32}$/);

  // --- 4. Браузерный шаг: владелец соглашается (единственная подмена в файле) ---
  // Метод PKCE берётся ИЗ МЕТАДАННЫХ, а не пишется литералом: обещание документа обмена
  // и то, что принимает экран согласия (zod-литерал в routers/oauth.ts), — одна правда.
  // Приведение типа нужно только компилятору; разойдись значения — zod откажет в рантайме.
  const method = first(asMeta.code_challenge_methods_supported, 'code_challenge_methods_supported');
  const { verifier, challenge } = pkce();
  const { redirectTo } = await ownerCaller.oauth.consent({
    clientId: reg.client_id,
    redirectUri: REDIRECT,
    // resource передаём тот, что объявлен метаданными: сверка «наш ли ресурс» стоит и
    // здесь, и на обмене — разъехавшись, они дали бы зелёный свет на одном шаге и отказ
    // на другом.
    resource: prm.resource,
    codeChallenge: challenge,
    codeChallengeMethod: method as 'S256',
    state: 'st-1',
  });
  const back = new URL(redirectTo);
  // Адрес возврата — тот, что клиент зарегистрировал, и state вернулся неизменным:
  // клиент, сверяющий state строкой, иначе счёл бы ответ чужим.
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('st-1');
  const code = back.searchParams.get('code');
  if (code === null) throw new Error(`в адресе возврата нет кода: ${redirectTo}`);

  // --- 5. Обмен кода на токены ---
  const grantType = asMeta.grant_types_supported.find((g) => g === 'authorization_code');
  expect(grantType, 'метаданные обязаны объявлять authorization_code').toBe('authorization_code');
  const tokenRes = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: reg.client_id,
      resource: prm.resource,
    }),
  });
  // Тело отказа тут — единственная улика при расхождении канонического ресурса,
  // поэтому попадает в сообщение, а не теряется за «expected 400 to be 200».
  expect(tokenRes.status, `обмен кода: ${await tokenRes.clone().text()}`).toBe(200);
  const tokens = (await tokenRes.json()) as TokenResponse;
  expect(tokens.token_type).toBe('Bearer');
  expect(tokens.access_token.startsWith('orbis_at_')).toBe(true);
  expect(tokens.refresh_token.startsWith('orbis_rt_')).toBe(true);
  // Токены не должны осесть в кэше по пути (OAuth 2.1 §4.1.4)
  expect(tokenRes.headers.get('cache-control')).toBe('no-store');

  // --- 6. Настоящий MCP-клиент из SDK с полученным токеном ---
  const agent = new Client({ name: 'e2e-agent', version: '0.0.0' });
  await agent.connect(
    // Адрес — из метаданных (prm.resource), а не собранный тестом
    new StreamableHTTPClientTransport(new URL(prm.resource), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    }),
  );
  try {
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name)).toContain('entity_query');

    const created = await agent.callTool({
      name: 'entity_create',
      // tags обязателен по §9.2 (может быть пустым) — реестр объявляет его в required
      arguments: { title: 'из агента по OAuth', tags: [] },
    });
    expect(created.isError).toBeFalsy();
    const content = created.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(first(content, 'content ответа tools/call').text) as {
      result: WireEntity;
    };
    expect(payload.result.title).toBe('из агента по OAuth');
    // Сущность легла ВЛАДЕЛЬЦУ гранта: токен несёт identity, а не только право входа
    expect(payload.result.ownerId).toBe(owner);
    createdByAgentId = payload.result.id;
  } finally {
    await agent.close();
  }

  // --- 7. Владелец видит доступ в «Агентах» и отзывает его ---
  const grants = await ownerCaller.oauth.listGrants();
  // Ровно один: труба «регистрация → согласие → обмен» обязана оставить ОДНУ строку,
  // а не заводить новую на каждом шаге.
  expect(grants).toHaveLength(1);
  const grant = first(grants, 'список доступов владельца');
  expect(grant.kind).toBe('oauth');
  // Подпись из DCR доехала до метки гранта через экран согласия
  expect(grant.label).toBe(CLIENT_NAME);
  expect(grant.connected).toBe(true);
  expect(grant.revokedAt).toBeNull();
  // last_used_at проставлен: владелец видит, что агент ходил
  expect(grant.lastUsedAt).not.toBeNull();

  expect(await ownerCaller.oauth.revokeGrant({ grantId: grant.id })).toEqual({ revoked: true });

  // Отзыв — строка в базе, а не смена переменной с передеплоем: действует немедленно
  const after = await postMcp(prm.resource, { authorization: `Bearer ${tokens.access_token}` });
  expect(after.status).toBe(401);
  const afterBody = (await after.json()) as { error?: { code?: string } };
  expect(afterBody.error?.code).toBe('UNAUTHORIZED');
});

test('созданное агентом действие попало в журнал с атрибуцией agent/mcp', async () => {
  // Предыдущий тест создал сущность через OAuth-токен. Проверяем, что путь через новый
  // транспорт не потерял атрибуцию: карточка действия обязана лежать в ГЛОБАЛЬНОМ треде
  // владельца с actor_kind=agent и source=mcp (§7.8, D11) — иначе владелец не увидит,
  // что натворил агент, и отменять будет нечего.
  //
  // Ключи — snake_case, как в ActionRecord (executor/types.ts): actor_kind, source,
  // entity_id, actor_user_id; поля `tool` у записи журнала нет вовсе (оно у ActionCard),
  // вид операции несёт `type`.
  expect(createdByAgentId, 'первый тест не дошёл до создания сущности').toBeDefined();

  const rows = await withIdentity(db, owner, (tx) =>
    tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, globalThreadId(owner)))
      .orderBy(chatMessages.createdAt, chatMessages.id),
  );
  const actions = rows
    .filter((r) => r.role === 'system')
    .map((r) => (r.metadata as { actions?: ActionRecord[] }).actions?.[0])
    .filter((a): a is ActionRecord => a !== undefined);

  const created = actions.find((a) => a.entity_id === createdByAgentId);
  expect(created).toBeDefined();
  expect(created).toMatchObject({
    type: 'entity_created',
    actor_kind: 'agent',
    source: 'mcp',
    actor_user_id: owner,
  });
  // Обратная операция записана — значит Undo владельцу есть над чем делать (§7.8)
  expect(created?.inverse.length).toBeGreaterThan(0);
});
