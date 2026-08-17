// Интеграционные тесты MCP-сервера (§9.3): НАСТОЯЩИЙ MCP-клиент из SDK
// (Client + StreamableHTTPClientTransport) против реально поднятого Hono-приложения
// на свободном порту (Bun.serve port: 0) и живой БД — интеграционная правда, без моков
// транспорта. Env: DATABASE_URL / DATABASE_URL_ADMIN (как остальные интеграционные);
// токен агента с переездом на таблицу грантов (D34) выдаётся в БАЗУ через issuePatGrant,
// в окружении его больше нет.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { batchAuditMessageId, entityThreadId, globalThreadId, newId } from '@orbis/shared';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import type { WireChatMessage } from '../chat/messages';
import { chatMessages, entities, oauthClients } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { ActionRecord, WireEntity } from '../executor/types';
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  issuePatGrant,
  revokeGrant,
  verifyBearer,
} from '../oauth/grants';
import { approvePending } from '../policy/pending';
import { appRouter } from '../router';
import { buildToolRegistry } from '../tools/registry';
import { createCallerFactory } from '../trpc';
import { MCP_MAX_BODY_BYTES, makeMcpHandler } from './transport';

requireEnv();

const { db, client: dbClient } = appDb();
const owner = freshUserId();

/** Живой headless-грант владельца; выдаётся в базу в beforeAll (сырой токен — оттуда). */
let TOKEN: string;
/** Тот же владелец, но грант со скоупом worker (С7) — фоновый исполнитель. */
let WORKER_TOKEN: string;

// ORBIS_PUBLIC_URL берётся под контроль ЯВНО (по образцу metadata.test.ts): от неё
// зависит адрес в WWW-Authenticate, который ниже пинится дословно. Файл переменную не
// задаёт, но и не вправе полагаться на то, что её нет в окружении прогона — она вот-вот
// появится в apps/server/.env.example (задача про прод), и первый же разработчик,
// скопировавший пример, получил бы непонятный диф в тесте про MCP.
const savedPublicUrl = process.env.ORBIS_PUBLIC_URL;

// Два независимых сервера на свободных портах: боевые deps и deps с инжектированным
// резолвером §8 (agents.requests_per_day = 0) — rate-гейт проверяется изолированно
let main: ReturnType<typeof Bun.serve>;
let gated: ReturnType<typeof Bun.serve>;
const mainUrl = () => `http://127.0.0.1:${main.port}/mcp`;
const gatedUrl = () => `http://127.0.0.1:${gated.port}/mcp`;

const createCaller = createCallerFactory(appRouter);
/** Владелец аккаунта — tRPC-caller (владельческая поверхность, не MCP). */
const ownerCaller = createCaller({
  actorUserId: owner,
  actorKind: 'owner',
  db,
  clientVersion: null,
});

beforeAll(async () => {
  delete process.env.ORBIS_PUBLIC_URL; // база метаданных = адрес запроса (локальный стенд)
  await truncateAll();
  TOKEN = await issuePatGrant(db, { ownerId: owner, label: 'тестовый агент' });
  // Скоуп worker выдаётся штатным путём (Задача 8): правка строки под admin-DSN,
  // стоявшая здесь прежде, обходила бы ровно тот код, который теперь и проверяется.
  WORKER_TOKEN = await issuePatGrant(db, {
    ownerId: owner,
    label: 'фоновый исполнитель',
    scope: 'worker',
  });

  const app = new Hono();
  app.all('/mcp', makeMcpHandler({ db }));
  main = Bun.serve({ port: 0, fetch: app.fetch });

  const gatedApp = new Hono();
  gatedApp.all('/mcp', makeMcpHandler({ db, entitlements: () => ({ allowed: true, limit: 0 }) }));
  gated = Bun.serve({ port: 0, fetch: gatedApp.fetch });
});

afterAll(async () => {
  main?.stop(true);
  gated?.stop(true);
  if (savedPublicUrl === undefined) delete process.env.ORBIS_PUBLIC_URL;
  else process.env.ORBIS_PUBLIC_URL = savedPublicUrl;
  await dbClient.end();
});

/** MCP-клиент SDK, подключённый к url с Bearer-токеном (по умолчанию — валидный PAT). */
async function connectAgent(url: string, token: string = TOKEN): Promise<Client> {
  const agent = new Client({ name: 'test-agent', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await agent.connect(transport);
  return agent;
}

/** tools/call + разбор единственного text-контента как JSON (контракт адаптера). */
async function callTool(
  agent: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const r = await agent.callTool({ name, arguments: args });
  const content = r.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe('text');
  return {
    isError: r.isError === true,
    payload: JSON.parse(content[0]?.text ?? '') as Record<string, unknown>,
  };
}

/** Сид-сущность владельца через executor без синка — без audit-шума в тредах. */
async function seedEntity(input: Record<string, unknown>): Promise<WireEntity> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool: 'entity_create', input }],
  });
  if (!r.ok) throw new Error(`seedEntity: ${r.error.code} ${r.error.message}`);
  return r.results[0] as WireEntity;
}

/** actions[0] всех audit-сообщений глобального треда владельца (§7.8). */
async function globalAuditActions(): Promise<ActionRecord[]> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, globalThreadId(owner)))
      .orderBy(chatMessages.createdAt, chatMessages.id),
  );
  return rows
    .filter((r) => r.role === 'system')
    .map((r) => (r.metadata as { actions?: ActionRecord[] }).actions?.[0])
    .filter((a): a is ActionRecord => a !== undefined);
}

// ---------------------------------------------------------------------------
// Аутентификация: грант из таблицы ДО любой MCP-логики (§9.3, fail-closed)
// ---------------------------------------------------------------------------

describe('/mcp: аутентификация по гранту ДО MCP-логики (§9.3)', () => {
  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'probe', version: '0.0.0' },
    },
  };

  async function post(headers: Record<string, string>): Promise<Response> {
    return fetch(mainUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(initBody),
    });
  }

  test('без Authorization / токена нет в таблице / JWT вместо гранта → 401 нашей формы (не JSON-RPC)', async () => {
    const cases: Record<string, string>[] = [
      {}, // вовсе без заголовка
      { authorization: `Bearer orbis_pat_${'00'.repeat(32)}` }, // формат верный, строки в таблице нет
      // Access-токен OAuth того же формата, но не выданный нами, — тот же отказ
      { authorization: `Bearer orbis_at_${'00'.repeat(32)}` },
      // Supabase JWT в /mcp не пускается: эндпоинт ТОЛЬКО для внешних агентов (§9.3);
      // владельческие поверхности ходят в tRPC с JWT (context.ts)
      { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl' },
    ];
    for (const headers of cases) {
      const res = await post(headers);
      expect(res.status).toBe(401);
      // Наша структурная форма, а не JSON-RPC-ответ: отказ случился ДО MCP-слоя
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('UNAUTHORIZED');
    }
  });

  test('SDK-клиент с чужим токеном не подключается (401 UNAUTHORIZED)', async () => {
    // Сообщение ошибки SDK-клиента несёт тело ответа — матчим нашу структурную форму
    await expect(connectAgent(mainUrl(), `orbis_pat_${'ee'.repeat(32)}`)).rejects.toThrow(
      /UNAUTHORIZED/,
    );
  });

  // Ради этого теста доступ и переезжал из env в таблицу (Р4): отзыв — строка в базе,
  // а не смена переменной с передеплоем. Токен тут настоящий и до отзыва рабочий.
  test('отозванный токен больше не пускает', async () => {
    const token = await issuePatGrant(db, { ownerId: owner, label: 'на отзыв' });
    const identity = await verifyBearer(db, token);
    if (identity === null) throw new Error('выданный токен не прошёл verifyBearer');
    // До отзыва тот же токен пускает — иначе тест был бы зелёным и на сломанной выдаче
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(200);

    expect(await revokeGrant(db, { ownerId: owner, grantId: identity.grantId })).toBe(true);

    const res = await post({ authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });

  // RFC 9728 §5.1: без этого указателя MCP-клиент видит «нужна авторизация», но не знает
  // куда идти — браузерный вход не начинается вовсе. Форма адреса — path-aware (§3.1):
  // ровно та, которую клиент вывел бы сам из идентификатора ресурса <origin>/mcp.
  test('401 указывает, где искать метаданные ресурса (RFC 9728)', async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="http://127.0.0.1:${main.port}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  // ПОЛОЖИТЕЛЬНЫЙ тест на второй вид Bearer. Отказ несуществующему orbis_at_ (выше) не
  // доказывает ничего: он остался бы зелёным и после выпадения ACCESS_PREFIX из
  // BEARER_PREFIXES — то есть /mcp молча перестал бы пускать ВСЕХ OAuth-агентов, а
  // покраснел бы только тест чужой поверхности (context.test.ts). Токен добывается
  // настоящим путём OAuth — код + PKCE + обмен, — а не вставкой строки в таблицу.
  test('access-токен, выданный обменом кода, пускает на /mcp от имени владельца', async () => {
    const clientId = 'test-client-mcp';
    const redirectUri = 'http://localhost:8080/callback';
    await db
      .insert(oauthClients)
      .values({ clientId, clientName: 'Claude Code', redirectUris: [redirectUri] })
      .onConflictDoNothing();
    const verifier = randomBytes(32).toString('base64url');
    const code = await createAuthorizationCode(db, {
      ownerId: owner,
      clientId,
      label: 'Claude Code',
      redirectUri,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      scope: 'full',
    });
    const { accessToken } = await exchangeAuthorizationCode(db, {
      code,
      codeVerifier: verifier,
      redirectUri,
      clientId,
    });
    expect(accessToken.startsWith('orbis_at_')).toBe(true);

    // Не просто 200: сущность обязана лечь владельцу гранта — токен несёт identity,
    // а не только право входа
    const agent = await connectAgent(mainUrl(), accessToken);
    let created: WireEntity;
    try {
      const r = await callTool(agent, 'entity_create', {
        title: 'Создано OAuth-агентом',
        tags: [],
      });
      expect(r.isError).toBe(false);
      created = r.payload.result as WireEntity;
    } finally {
      await agent.close();
    }
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select().from(entities).where(eq(entities.id, created.id)),
    );
    expect(rows).toHaveLength(1);
  });

  // Порядок 401 → 413 не проверял никто: 401-кейсы шлют крошечные тела, 413-кейсы шлют
  // валидный токен, и перенос bodyLimit выше аутентификации оставил бы сьют зелёным.
  // Инвариант же содержательный: неаутентифицированный клиент не должен заставлять
  // сервер читать мегабайт — иначе гейт размера становится усилителем, а не защитой.
  test('тело больше лимита БЕЗ токена → 401, а не 413 (аутентификация ДО чтения тела)', async () => {
    const res = await fetch(mainUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(MCP_MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// Харднинг транспорта (Task 10b): 405 на не-POST, 413 на большое тело
// ---------------------------------------------------------------------------

describe('/mcp: харднинг транспорта (405/413, Task 10b)', () => {
  test('GET даже с валидным PAT → 405, Allow: POST (stateless polling §9.3, без SSE)', async () => {
    const res = await fetch(mainUrl(), {
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toContain('POST');
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('METHOD_NOT_ALLOWED');
  });

  test('POST с телом > MCP_MAX_BODY_BYTES → 413 до транспорта', async () => {
    // Size-гейт стоит до JSON-парсинга — телу не обязательно быть валидным JSON
    const res = await fetch(mainUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
      },
      body: 'x'.repeat(MCP_MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('POST с телом > лимита БЕЗ content-length (chunked/stream) → 413 (закрыт обход Task 10b)', async () => {
    // Тело шлётся ReadableStream'ом: fetch не знает длины → НЕ ставит content-length,
    // отправляет chunked (transfer-encoding). Заголовочный гейт (старый код) такое тело
    // пропускал (счётчик по content-length, здесь его нет) — платформенный лимит должен
    // резать по ФАКТИЧЕСКИ прочитанным байтам. Ровно (лимит+1) байт кусками по 100 КБ:
    // последний кусок пересекает порог и он же последний — стрим дочитывается до конца
    // (без обрыва пайпа), затем 413.
    const TOTAL = MCP_MAX_BODY_BYTES + 1;
    let remaining = TOTAL;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          controller.close();
          return;
        }
        const n = Math.min(100_000, remaining);
        controller.enqueue(new Uint8Array(n).fill(120)); // 'x'
        remaining -= n;
      },
    });
    const res = await fetch(mainUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
      },
      body,
      // duplex обязателен для стримингового тела запроса в fetch (WHATWG/undici)
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(res.status).toBe(413);
    const parsed = (await res.json()) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('POST валидного chunked-тела ПОД лимитом (без content-length) → 200 dispatch (лочит ре-буфер bodyLimit)', async () => {
    // Регресс-гард (ревью Task 4): валидный JSON-RPC, отправленный chunked без
    // content-length, идёт по СТРИМ-ветке bodyLimit — та дочитывает поток, ре-буферизует
    // и переприсваивает c.req.raw буфером тела; ниже transport читает уже этот c.req.raw.
    // Это опора на внутренности Hono 4.12.27. Мутационный смысл теста: сломайся ре-буфер
    // (напр. апгрейд Hono) — c.req.raw после bodyLimit оказался бы пуст, JSON-parse упал
    // бы, transport вернул бы parse-error (не 200 + result). Тест стережёт именно это.
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'chunked-probe', version: '0.0.0' },
      },
    });
    const bytes = new TextEncoder().encode(initBody);
    expect(bytes.length).toBeLessThan(MCP_MAX_BODY_BYTES); // маленькое, гарантированно под лимитом
    // Тело через ReadableStream: fetch не знает длины → НЕ ставит content-length, шлёт
    // chunked (как в 413-тесте), но валидное и маленькое — путь ре-буфера, не быстрый пред-чек
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const res = await fetch(mainUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    // 200 (под лимитом, не 413) с валидным dispatch-ответом (тело дочитано после ре-буфера, не 400)
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as {
      jsonrpc?: string;
      id?: number;
      result?: Record<string, unknown>;
      error?: unknown;
    };
    expect(parsed.error).toBeUndefined();
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// tools/list: реестр §9.2 минус internalOnly
// ---------------------------------------------------------------------------

describe('/mcp tools/list (§9.2)', () => {
  test('состав = публичный реестр: 9 публичных core (с thread_post) + 11 attach_*, без internalOnly; имена/описания/схемы дословно', async () => {
    const agent = await connectAgent(mainUrl());
    try {
      const { tools } = await agent.listTools();
      const names = tools.map((t) => t.name);

      expect(names).not.toContain('user_query'); // internalOnly не публикуется (§9.2)
      expect(names).not.toContain('import_csv_start'); // internalOnly (C4c): у агента нет экрана импорта
      for (const name of [
        'entity_query',
        'entity_get',
        'entity_create',
        'entity_update',
        'relation_create',
        'relation_delete',
        'batch_execute',
        'budget_status',
        'thread_post',
      ]) {
        expect(names).toContain(name);
      }
      // orbis/agent-run в списке нет намеренно: служебный аспект attach_*-тула не получает
      // (SERVICE_ASPECT_IDS) — прогон правит только сервер своими глаголами.
      for (const aspect of [
        'schedule',
        'task',
        'financial',
        'note',
        'budget',
        'category',
        'memory',
        'goal',
        'project',
        'repo',
        'assignment',
      ]) {
        expect(names).toContain(`attach_orbis_${aspect}`);
      }
      expect(names).not.toContain('attach_orbis_agent_run');

      // Дословная сверка с реестром (имя, описание, inputSchema) — адаптер ничего не
      // сочиняет и ничего не теряет, кроме отсечения internalOnly
      const defs = await withIdentity(db, owner, (tx) => buildToolRegistry(tx));
      const publicDefs = defs.filter((d) => d.internalOnly !== true);
      expect(tools).toHaveLength(publicDefs.length); // builtin-набор: 20
      for (const def of publicDefs) {
        const tool = tools.find((t) => t.name === def.name);
        expect(tool).toBeDefined();
        expect(tool?.description).toBe(def.description);
        expect(tool?.inputSchema as unknown).toEqual(def.inputJsonSchema);
      }
    } finally {
      await agent.close();
    }
  });

  test('tools/call user_query → структурная ошибка VALIDATION (fail-closed и на вызове)', async () => {
    const agent = await connectAgent(mainUrl());
    try {
      const r = await callTool(agent, 'user_query', {
        query: 'aspect=orbis/task',
        aggregate: 'count',
      });
      expect(r.isError).toBe(true);
      const error = r.payload.error as { code: string };
      expect(error.code).toBe('VALIDATION');
    } finally {
      await agent.close();
    }
  });
});

// ---------------------------------------------------------------------------
// tools/call: dispatchTool(actorKind 'agent', source 'mcp'), audit в глобальный тред
// ---------------------------------------------------------------------------

describe('/mcp tools/call → dispatchTool (§9.3)', () => {
  test('entity_create: сущность в БД; audit в ГЛОБАЛЬНОМ треде владельца с actor_kind=agent, source=mcp (02 §2.3)', async () => {
    const agent = await connectAgent(mainUrl());
    let created: WireEntity;
    try {
      const r = await callTool(agent, 'entity_create', { title: 'Создано агентом', tags: ['mcp'] });
      expect(r.isError).toBe(false);
      created = r.payload.result as WireEntity;
      expect(created.title).toBe('Создано агентом');
      expect((r.payload.card as { kind: string }).kind).toBe('entity_card');
    } finally {
      await agent.close();
    }

    // Сущность реально в графе
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select().from(entities).where(eq(entities.id, created.id)),
    );
    expect(rows).toHaveLength(1);

    // Audit — системное сообщение в глобальном треде владельца (threadId не передавался):
    // действия агентов видимы владельцу (02 §2.3), атрибуция честная (§7.8, D11)
    const action = (await globalAuditActions()).find((a) => a.entity_id === created.id);
    expect(action).toBeDefined();
    expect(action?.actor_kind).toBe('agent');
    expect(action?.source).toBe('mcp');
    expect(action?.actor_user_id).toBe(owner);
    // С2: «агент вообще» → конкретный грант. Владелец по записи журнала видит, КАКОЙ
    // из подключённых агентов это сделал, и может отозвать именно его. id гранта тест
    // берёт тем же путём, что и транспорт (/mcp → verifyBearer), а не отдельным знанием.
    const grant = await verifyBearer(db, TOKEN);
    if (grant === null) throw new Error('тестовый PAT не прошёл verifyBearer');
    expect(action?.actor_grant_id).toBe(grant.grantId);
  });

  test('batch_execute из 11 архиваций → pending_confirmation (§7.10), isError: false, граф чист', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      ids.push((await seedEntity({ title: `Кандидат на архивацию ${i}`, tags: [] })).id);
    }

    const agent = await connectAgent(mainUrl());
    try {
      const r = await callTool(agent, 'batch_execute', {
        batch_id: newId(),
        operations: ids.map((id) => ({ tool: 'entity_update', input: { id, archived: true } })),
      });
      // Ожидание подтверждения — НЕ сбой: честный не-error ответ агенту (§9.3)
      expect(r.isError).toBe(false);
      expect(r.payload.status).toBe('pending_confirmation');
      expect(r.payload.pendingId).toMatch(/^[0-9a-f-]{36}$/);
      expect(String(r.payload.note)).toContain('не повторяй');
    } finally {
      await agent.close();
    }

    // До approve владельца граф не тронут — ни одна сущность не заархивирована
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(inArray(entities.id, ids)),
    );
    expect(rows).toHaveLength(11);
    for (const row of rows) expect(row.archived).toBe(false);
  });

  test('гигиена ошибок: инфраструктурный сбой не течёт агенту — обезличенная JSON-RPC-ошибка', async () => {
    // Резолвер §8, падающий «сырой» ошибкой с внутренностями, — суррогат
    // инфраструктурного сбоя (БД и т.п.); наружу внутренности уходить не должны
    const app = new Hono();
    app.all(
      '/mcp',
      makeMcpHandler({
        db,
        entitlements: () => {
          throw new Error('secret internals: SELECT * FROM entities');
        },
      }),
    );
    const broken = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const agent = await connectAgent(`http://127.0.0.1:${broken.port}/mcp`);
      try {
        const call = agent.callTool({ name: 'entity_query', arguments: { query: 'tag=x' } });
        await expect(call).rejects.toThrow(/внутренняя ошибка сервера/);
        await expect(call).rejects.not.toThrow(/SELECT/);
      } finally {
        await agent.close();
      }
    } finally {
      broken.stop(true);
    }
  });

  test('rate-гейт agents.requests_per_day (§8) ДО dispatch: лимит 0 → LIMIT, ничего не исполнено', async () => {
    const agent = await connectAgent(gatedUrl());
    try {
      const r = await callTool(agent, 'entity_create', {
        title: 'Не должно существовать',
        tags: [],
      });
      expect(r.isError).toBe(true);
      const error = r.payload.error as { code: string };
      expect(error.code).toBe('LIMIT');
    } finally {
      await agent.close();
    }
    // Гейт стоит ДО dispatch: ни сущности, ни audit-следа
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select().from(entities).where(eq(entities.title, 'Не должно существовать')),
    );
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §9.3, сценарий 2 ДОСЛОВНО: polling-петля «что нового» без нового механизма
// ---------------------------------------------------------------------------

describe('/mcp: паттерн «что нового» (§9.3, сценарий 2)', () => {
  test('владелец обновил → entity_query по курсору находит → entity_get thread отдаёт инструкцию → агент закрывает и отписывается', async () => {
    // Подготовка владельцем (tRPC): задача + инструкция агенту в её треде
    const task = await ownerCaller.entity.create({
      input: {
        title: 'Отчёт за квартал',
        tags: [],
        aspects: { 'orbis/task': { status: 'inbox' } },
      },
      source: 'quick_capture',
    });
    const { threadId } = await ownerCaller.chat.ensureThread({ entityId: task.id });
    await ownerCaller.chat.appendUserMessage({
      id: newId(),
      threadId,
      content: 'Инструкция для агента: собери цифры и закрой задачу',
    });

    // Курсор «момент прошлого опроса» хранит АГЕНТ (не сервер): строго после создания.
    // +1ms поверх ms-огрублённого wire-updatedAt покрывает µs-хвост значения в БД
    const cursor = new Date(Date.parse(task.updatedAt) + 1).toISOString();

    const agent = await connectAgent(mainUrl());
    try {
      // До обновления владельцем курсор задачу НЕ находит (сравнение моментов §6.1)
      const before = await callTool(agent, 'entity_query', { query: `updated_at>${cursor}` });
      expect(before.isError).toBe(false);
      expect((before.payload.result as WireEntity[]).map((e) => e.id)).not.toContain(task.id);

      // Владелец обновляет сущность — «сигнал» агенту (updated_at пересекает курсор)
      await ownerCaller.entity.update({ id: task.id, title: 'Отчёт за квартал (срочно)' });

      // 1) entity_query по курсору находит изменённую сущность
      const found = await callTool(agent, 'entity_query', { query: `updated_at>${cursor}` });
      expect(found.isError).toBe(false);
      expect((found.payload.result as WireEntity[]).map((e) => e.id)).toContain(task.id);

      // 2) entity_get include:['thread'] отдаёт инструкцию владельца из треда
      const got = await callTool(agent, 'entity_get', { id: task.id, include: ['thread'] });
      expect(got.isError).toBe(false);
      const thread = (got.payload.result as { thread: { messages: WireChatMessage[] } }).thread;
      expect(
        thread.messages.some(
          (m) => m.role === 'user' && m.content.includes('Инструкция для агента'),
        ),
      ).toBe(true);

      // 3) работа сделана вне Orbis; агент закрывает задачу и оставляет заметку в тред
      const done = await callTool(agent, 'entity_update', {
        id: task.id,
        aspects: { 'orbis/task': { status: 'done' } },
      });
      expect(done.isError).toBe(false);

      const note = await callTool(agent, 'thread_post', {
        entity_id: task.id,
        content: 'Готово: отчёт собран и отправлен владельцу',
      });
      expect(note.isError).toBe(false);
    } finally {
      await agent.close();
    }

    // Статус обновлён shallow-merge'ем аспекта
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select().from(entities).where(eq(entities.id, task.id)),
    );
    const aspects = rows[0]?.aspects as Record<string, Record<string, unknown>>;
    expect(aspects['orbis/task']?.status).toBe('done');

    // Audit агентского entity_update — в глобальном треде владельца, actor 'agent'/'mcp'
    const agentUpdate = (await globalAuditActions()).find(
      (a) => a.actor_kind === 'agent' && a.type === 'entity_updated' && a.entity_id === task.id,
    );
    expect(agentUpdate).toBeDefined();
    expect(agentUpdate?.source).toBe('mcp');

    // Заметка агента — в треде сущности, с честной пометкой автора (§9.3)
    const threadRows = await withIdentity(db, owner, (tx) =>
      tx
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.threadId, entityThreadId(owner, task.id))),
    );
    const agentNote = threadRows.find(
      (m) => (m.metadata as { author_kind?: string }).author_kind === 'agent',
    );
    expect(agentNote?.content).toContain('Готово');
  });
});

// ---------------------------------------------------------------------------
// Скоуп worker (С7, §4.14): сужение tools/list и fail-closed отказ на tools/call
// ---------------------------------------------------------------------------

describe('/mcp: скоуп worker (С7, §4.14)', () => {
  test('tools/list сужен: без entity_update / attach_* / batch_execute; entity_get и thread_post на месте', async () => {
    const agent = await connectAgent(mainUrl(), WORKER_TOKEN);
    try {
      const { tools } = await agent.listTools();
      const names = tools.map((t) => t.name);
      for (const name of [
        'entity_create',
        'entity_update',
        'relation_create',
        'relation_delete',
        'batch_execute',
        'attach_orbis_task',
      ]) {
        expect(names).not.toContain(name);
      }
      for (const name of ['entity_get', 'entity_query', 'budget_status', 'thread_post']) {
        expect(names).toContain(name);
      }
    } finally {
      await agent.close();
    }
  });

  test('tools/call entity_update worker-грантом → isError, FORBIDDEN_LEVEL (список — не единственная линия)', async () => {
    const target = await seedEntity({ title: 'Цель worker-отказа', tags: [] });
    const agent = await connectAgent(mainUrl(), WORKER_TOKEN);
    try {
      const r = await callTool(agent, 'entity_update', { id: target.id, title: 'Переименовано' });
      expect(r.isError).toBe(true);
      expect((r.payload.error as { code?: string }).code).toBe('FORBIDDEN_LEVEL');
    } finally {
      await agent.close();
    }
    // Отказ до записи: заголовок не изменился
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select({ title: entities.title }).from(entities).where(eq(entities.id, target.id)),
    );
    expect(rows[0]?.title).toBe('Цель worker-отказа');
  });
});

// ---------------------------------------------------------------------------
// Грант доживает до approve: pending хранит исходный грант (С2, §7.8)
// ---------------------------------------------------------------------------

describe('/mcp: pending-подтверждение несёт грант исходного вызова (С2)', () => {
  test('approve batch-а от MCP-гранта: action журнала несёт actor_grant_id', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      ids.push((await seedEntity({ title: `Грант в pending ${i}`, tags: [] })).id);
    }
    let pendingId = '';
    const agent = await connectAgent(mainUrl());
    try {
      const r = await callTool(agent, 'batch_execute', {
        batch_id: newId(),
        operations: ids.map((id) => ({ tool: 'entity_update', input: { id, archived: true } })),
      });
      expect(r.payload.status).toBe('pending_confirmation');
      pendingId = String(r.payload.pendingId);
    } finally {
      await agent.close();
    }

    const approved = await approvePending(db, { ownerId: owner, pendingId });
    expect(approved.ok).toBe(true);

    // Атрибуция ИСХОДНОГО актора (§7.8, D11) — вместе с грантом: владелец видит, какой
    // доступ попросил подтверждение, даже если исполнил план он сам кнопкой
    const grant = await verifyBearer(db, TOKEN);
    if (grant === null) throw new Error('тестовый PAT не прошёл verifyBearer');
    const auditRows = await withIdentity(db, owner, (tx) =>
      tx
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.id, batchAuditMessageId(owner, pendingId))),
    );
    const action = (auditRows[0]?.metadata as { actions?: ActionRecord[] }).actions?.[0];
    expect(action).toBeDefined();
    expect(action?.actor_kind).toBe('agent');
    expect(action?.source).toBe('mcp');
    expect(action?.actor_grant_id).toBe(grant.grantId);
  });
});
