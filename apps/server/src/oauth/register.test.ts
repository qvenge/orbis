// apps/server/src/oauth/register.test.ts
// Динамическая регистрация клиентов (RFC 7591) — интеграционно: живая БД под ролью
// orbis_app и НАСТОЯЩЕЕ приложение (createApp), а не голая Hono с примонтированным
// хендлером. Причина в том, что у этого эндпоинта половина контракта — сам факт
// монтирования: агент приходит по адресу из registration_endpoint метаданных, и
// незарегистрированный роут отдал бы ему 404 при полностью исправном модуле.
//
// Запросов без токена тут не бывает по построению: регистрация происходит ДО всякой
// аутентификации, иначе агенту нечем начать вход.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { appDb, requireEnv, truncateAll } from '../../test/helpers';
import type { AiDeps } from '../ai/send-message';
import { createApp } from '../app';
import { oauthClients } from '../db/schema';

requireEnv();
const { db, client: dbClient } = appDb();

/**
 * Потолок держится ЛИТЕРАЛОМ, а не импортом MAX_REGISTRATIONS_PER_DAY: с импортом сьют
 * проверял бы согласованность модуля с самим собой (та же причина, по которой
 * grants.test.ts считает хеши сам). Изменение константы обязано ронять этот файл.
 */
const CAP = 50;
const REDIRECT = 'http://localhost:8080/callback';

// Статики на этом пути нет и быть не может: каталог заведомо отсутствует, чтобы
// serveStatic ничего не подменил, а роут проверялся сам по себе.
const app = createApp({ db, ai: {} as AiDeps, webDistDir: '/nonexistent-orbis-dist' });

function postRaw(raw: string): Promise<Response> {
  return Promise.resolve(
    app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    }),
  );
}

const post = (body: unknown): Promise<Response> => postRaw(JSON.stringify(body));

interface RegisterBody {
  client_id?: string;
  client_name?: string;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  error?: string;
  error_description?: string;
}

const json = async (res: Response): Promise<RegisterBody> => (await res.json()) as RegisterBody;

/** Строки клиентов с заданным возрастом — потолок считается по времени создания. */
async function seedClients(n: number, ageMs: number): Promise<void> {
  const createdAt = new Date(Date.now() - ageMs);
  await db.insert(oauthClients).values(
    Array.from({ length: n }, (_, i) => ({
      clientId: `seed-${ageMs}-${i}`,
      clientName: `посев ${i}`,
      redirectUris: [REDIRECT],
      createdAt,
    })),
  );
}

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await dbClient.end();
});

test('регистрация возвращает client_id и запоминает redirect_uris', async () => {
  const res = await post({ client_name: 'Claude Code', redirect_uris: [REDIRECT] });
  expect(res.status).toBe(201);
  const body = await json(res);
  expect(typeof body.client_id).toBe('string');
  expect(body.redirect_uris).toEqual([REDIRECT]);
  expect(body.token_endpoint_auth_method).toBe('none');
  expect(body.client_name).toBe('Claude Code');
  // Поля контракта RFC 7591: строгий клиент читает их, чтобы понять, что секрета нет
  // и обмен защищён PKCE. Молчаливая пропажа иначе всплывёт только на живом агенте.
  expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
  expect(body.response_types).toEqual(['code']);

  // Эхо в ответе — не доказательство: по этой строке /oauth/authorize будет сверять
  // redirect_uri, и хендлер, который ничего не записал, прошёл бы проверки выше.
  const clientId = body.client_id;
  if (!clientId) throw new Error('регистрация не вернула client_id');
  const rows = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.redirectUris).toEqual([REDIRECT]);
  expect(rows[0]?.clientName).toBe('Claude Code');
});

test('client_id не повторяется и не угадывается', async () => {
  const first = await json(await post({ client_name: 'A', redirect_uris: [REDIRECT] }));
  const second = await json(await post({ client_name: 'A', redirect_uris: [REDIRECT] }));
  expect(first.client_id).not.toBe(second.client_id);
  // 16 случайных байт в hex: перебор client_id — это перебор 128 бит. Имя клиента
  // приходит снаружи, и вывести идентификатор из него нельзя.
  expect(first.client_id).toMatch(/^[0-9a-f]{32}$/);
});

test('redirect_uri не localhost и не https отвергается', async () => {
  const res = await post({ client_name: 'X', redirect_uris: ['http://evil.example.com/cb'] });
  expect(res.status).toBe(400);
  expect((await json(res)).error).toBe('invalid_redirect_uri');
  // Отказ обязан быть настоящим: строки в таблице после него быть не должно
  expect(await db.select().from(oauthClients)).toHaveLength(0);
});

// Похожие на петлю имена — самый дешёвый способ увести код на чужой хост, если
// проверка написана через includes/startsWith, а не по равенству hostname.
const badRedirects: Array<[string, string]> = [
  ['http://evil.example.com/cb', 'посторонний http-хост'],
  ['http://localhost.evil.com/cb', 'localhost как поддомен чужого хоста'],
  ['http://127.0.0.1.evil.com/cb', '127.0.0.1 как поддомен чужого хоста'],
  ['http://evil.com/localhost', 'петля в пути, а не в хосте'],
  ['ftp://localhost/cb', 'не http(s) схема'],
  ['не url вовсе', 'вообще не URL'],
  ['/callback', 'относительный адрес — new URL его не разбирает'],
];
for (const [uri, why] of badRedirects) {
  test(`redirect_uri ${JSON.stringify(uri)} (${why}) отвергается`, async () => {
    const res = await post({ client_name: 'X', redirect_uris: [uri] });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_redirect_uri');
  });
}

// Обратная половина: проверка обязана пропускать законных клиентов, иначе владелец
// не подключит ничего, а все отказы выше останутся зелёными.
const goodRedirects: Array<[string, string]> = [
  ['http://localhost:8080/callback', 'петля по имени с портом'],
  ['http://127.0.0.1:33418/callback', 'петля по адресу'],
  ['https://claude.ai/api/mcp/auth_callback', 'размещённый клиент по https'],
  ['http://LOCALHOST:8080/cb', 'регистр хоста URL нормализует сам'],
];
for (const [uri, why] of goodRedirects) {
  test(`redirect_uri ${JSON.stringify(uri)} (${why}) принимается`, async () => {
    const res = await post({ client_name: 'X', redirect_uris: [uri] });
    expect(res.status).toBe(201);
  });
}

test('несколько redirect_uris: годится только список целиком', async () => {
  const both = await post({ client_name: 'X', redirect_uris: [REDIRECT, 'https://ok.example/cb'] });
  expect(both.status).toBe(201);
  expect((await json(both)).redirect_uris).toEqual([REDIRECT, 'https://ok.example/cb']);

  // Один негодный адрес в списке — отказ целиком: иначе клиент считал бы себя
  // зарегистрированным с адресом, которого мы у него не приняли.
  const mixed = await post({
    client_name: 'X',
    redirect_uris: [REDIRECT, 'http://evil.example/cb'],
  });
  expect(mixed.status).toBe(400);
  expect((await json(mixed)).error).toBe('invalid_redirect_uri');
});

const emptyMetadata: Array<[unknown, string]> = [
  [{ client_name: 'X', redirect_uris: [] }, 'пустой список'],
  [{ client_name: 'X' }, 'поля нет вовсе'],
  [{ client_name: 'X', redirect_uris: 'http://localhost:8080/cb' }, 'строка вместо списка'],
  [{ client_name: 'X', redirect_uris: [42] }, 'список без строк'],
];
for (const [body, why] of emptyMetadata) {
  test(`redirect_uris (${why}) отвергается как invalid_client_metadata`, async () => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_client_metadata');
  });
}

// Тело формирует неаутентифицированный клиент, то есть кто угодно: битый JSON обязан
// давать отказ по спеке, а не 500 с трейсом Hono.
test('битое и пустое тело — отказ по форме OAuth, а не 500', async () => {
  for (const raw of ['{не json', '', 'null', '[]']) {
    const res = await postRaw(raw);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_client_metadata');
  }
});

test('без client_name регистрация проходит с понятной подписью', async () => {
  const res = await post({ redirect_uris: [REDIRECT] });
  expect(res.status).toBe(201);
  // Имя владелец увидит на экране согласия и в списке агентов: пустая подпись там
  // хуже, чем обобщённая, поэтому пустое и пробельное имя заменяются.
  expect((await json(res)).client_name).toBe('внешний агент');
  const blank = await post({ client_name: '   ', redirect_uris: [REDIRECT] });
  expect((await json(blank)).client_name).toBe('внешний агент');
});

test('ошибки отдаются формой OAuth: error + error_description', async () => {
  const body = await json(await post({ client_name: 'X', redirect_uris: [] }));
  // Форма { error, error_description } — из спеки, и она НЕ структурная { error: { code } }
  // из /mcp и tRPC: клиент разбирает именно спецификационные поля.
  expect(typeof body.error).toBe('string');
  expect(typeof body.error_description).toBe('string');
});

test('регистрации ограничены потолком в сутки', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < CAP; i++) {
    statuses.push((await post({ client_name: `клиент ${i}`, redirect_uris: [REDIRECT] })).status);
  }
  // Все CAP регистраций обязаны пройти: потолок ниже сделал бы 429 ниже пустым.
  expect(statuses.every((s) => s === 201)).toBe(true);
  const res = await post({ client_name: 'лишний', redirect_uris: [REDIRECT] });
  expect(res.status).toBe(429);
  expect((await json(res)).error_description).toContain('регистраций');
  // Лишняя регистрация не должна оставлять следа в таблице
  expect(await db.select().from(oauthClients)).toHaveLength(CAP);
});

test('потолок считается по времени: регистрации старше суток его не занимают', async () => {
  await seedClients(CAP, 25 * 3600 * 1000);
  const res = await post({ client_name: 'сегодняшний', redirect_uris: [REDIRECT] });
  expect(res.status).toBe(201);
});

test('потолок считается по времени: регистрации внутри суток его занимают', async () => {
  await seedClients(CAP, 23 * 3600 * 1000);
  const res = await post({ client_name: 'лишний', redirect_uris: [REDIRECT] });
  expect(res.status).toBe(429);
});

// Негодная заявка не должна съедать чужую квоту: иначе кто угодно закрывает владельцу
// регистрацию на сутки, ни разу не попав в таблицу.
test('отвергнутые заявки потолок не занимают', async () => {
  for (let i = 0; i < CAP + 5; i++) {
    const res = await post({ client_name: 'X', redirect_uris: ['http://evil.example.com/cb'] });
    expect(res.status).toBe(400);
  }
  expect((await post({ client_name: 'честный', redirect_uris: [REDIRECT] })).status).toBe(201);
});
