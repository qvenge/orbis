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
// Потолок тела импортируется (манера static.test.ts с TRPC_MAX_BODY_BYTES): строить
// сверхлимитное тело нужно ОТ него, а само значение отдельно пинится числом ниже.
import { REGISTER_MAX_BODY_BYTES } from './register';

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
  ['http://[::2]/cb', 'IPv6, но не петля'],
  // Учётные данные в URL аллоулист хоста НЕ обходят (hostname тут evil.com), но обманывают
  // человека на экране согласия — а вся защита слайса держится на нём: client_name
  // подконтролен тому, кто регистрируется, и назваться «Claude Code» может кто угодно.
  ['https://claude.ai@evil.com/cb', 'чужой хост под видом claude.ai через учётные данные'],
  ['https://user:pw@localhost:8080/cb', 'учётные данные даже на петле'],
  ['http://claude.ai@127.0.0.1/cb', 'учётные данные перед петлёй'],
  // Фрагмент запрещён RFC 6749 §3.1.2, и запрет не декоративный: адрес возврата строится
  // как `${uri}?code=…`, и `…/cb#frag?code=…` уводит код во фрагмент — локальный сервер
  // клиента его не увидит, вход молча не состоится.
  ['http://localhost:8080/cb#frag', 'фрагмент'],
  // У пустого фрагмента `parsed.hash` пуст, а '#' в строке остаётся: проверка по hash
  // пропустила бы ровно ту же поломку.
  ['http://localhost:8080/cb#', 'пустой фрагмент — ломается так же'],
  // new URL вырезает TAB/CR/LF и обрезает края, поэтому такие строки проходят проверку
  // хоста, а в таблицу ложатся как есть. Последствие проверено ревью: Location с таким
  // значением бросает «Header 'Location' has invalid value», то есть 500 вместо возврата.
  ['http://loc\nalhost/cb', 'перевод строки внутри хоста — URL его вырежет'],
  ['http://localhost:8080/cb\r\n', 'CRLF в хвосте'],
  ['http://local\thost:8080/cb', 'табуляция внутри хоста'],
  [' http://localhost:8080/cb', 'пробел в начале — URL обрежет'],
  ['http://localhost:8080/cb ', 'пробел в конце — URL обрежет'],
  ['http://localhost:8080/cb\u00a0', 'неразрывный пробел — в исходнике его не видно'],
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
  // RFC 8252 §7.3 приводит ОБЕ формы петли и советует клиенту пробовать оба стека и брать
  // доступный: без этой строки клиент, поступающий ровно по спеке, у нас не зарегистрируется.
  ['http://[::1]:33418/callback', 'IPv6-петля'],
  ['http://[0:0:0:0:0:0:0:1]:33418/cb', 'развёрнутая IPv6-петля — URL нормализует в [::1]'],
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

const badMetadata: Array<[unknown, string]> = [
  [{ client_name: 'X', redirect_uris: [] }, 'пустой список'],
  [{ client_name: 'X' }, 'поля нет вовсе'],
  [{ client_name: 'X', redirect_uris: 'http://localhost:8080/cb' }, 'строка вместо списка'],
  [{ client_name: 'X', redirect_uris: [42] }, 'список без строк'],
  // Не-строка в списке — такой же негодный элемент, как негодный адрес: молчаливое
  // усечение списка оставило бы клиента зарегистрированным не тем, что он просил.
  [{ client_name: 'X', redirect_uris: [REDIRECT, 42] }, 'строка и не-строка вперемешку'],
  [{ client_name: 'X', redirect_uris: [REDIRECT, null] }, 'строка и null вперемешку'],
];
for (const [body, why] of badMetadata) {
  test(`redirect_uris (${why}) отвергается как invalid_client_metadata`, async () => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_client_metadata');
    expect(await db.select().from(oauthClients)).toHaveLength(0);
  });
}

// Смысл запрета пробелов и управляющих символов — не в самой строке, а в её последствии:
// адрес возврата уедет в заголовок Location, и значение с переводом строки бросает
// «Header 'Location' has invalid value», то есть 500 вместо возврата кода владельцу.
// Тест идёт от последствия: что легло в таблицу — тем можно ответить.
test('всё, что записано в таблицу, годится в заголовок Location', async () => {
  for (const [uri] of goodRedirects) {
    await post({ client_name: 'X', redirect_uris: [uri] });
  }
  const stored = await db.select().from(oauthClients);
  expect(stored).toHaveLength(goodRedirects.length);
  for (const row of stored) {
    for (const uri of row.redirectUris) {
      expect(() => new Headers({ Location: `${uri}?code=abc` })).not.toThrow();
      // И сам код обязан остаться в query, а не уехать во фрагмент
      expect(new URL(`${uri}?code=abc`).searchParams.get('code')).toBe('abc');
    }
  }
});

// ---------------------------------------------------------------------------
// Потолок тела: единственный публичный POST, у которого его не было
// ---------------------------------------------------------------------------
//
// У /trpc/* лимит 4 МиБ, у /mcp — 1 МБ, а сюда ходит НЕАУТЕНТИФИЦИРОВАННЫЙ отправитель.
// Без потолка объявленная защита («потолок в 50 строк от засорения таблицы») не считается:
// 50 строк по десятку мегабайт — это гигабайты, и JSON.parse на них зовёт кто угодно.
test('потолок тела — размер пинится числом, а не импортом', () => {
  // Законная заявка DCR — сотни байт (живая проба: 108). Значение держится числом:
  // молчаливое разрастание потолка вернуло бы ровно ту дыру, ради которой он появился.
  expect(REGISTER_MAX_BODY_BYTES).toBe(16 * 1024);
});

test('тело сверх потолка — 413 формой OAuth, до разбора JSON', async () => {
  const oversized = JSON.stringify({
    client_name: 'x'.repeat(REGISTER_MAX_BODY_BYTES),
    redirect_uris: [REDIRECT],
  });
  const res = await postRaw(oversized);
  expect(res.status).toBe(413);
  const body = await json(res);
  // Форма — та же спецификационная, а не структурная { error: { code } } из /mcp
  expect(body.error).toBe('invalid_client_metadata');
  expect(typeof body.error_description).toBe('string');
  expect(await db.select().from(oauthClients)).toHaveLength(0);
});

test('тело под потолком проходит гейт: ответ не 413', async () => {
  const padded = JSON.stringify({
    client_name: 'x'.repeat(REGISTER_MAX_BODY_BYTES - 200),
    redirect_uris: [REDIRECT],
  });
  expect(padded.length).toBeLessThan(REGISTER_MAX_BODY_BYTES);
  const res = await postRaw(padded);
  expect(res.status).toBe(201);
});

// Chunked-тело без content-length: заголовочный пред-чек тут не срабатывает вовсе, и
// потолок обязан считаться по фактически прочитанным байтам (та же дыра, что закрывалась
// на /mcp в Task 4 слайса 1c-2).
test('сверхбольшое тело без content-length тоже режется', async () => {
  const chunk = 'x'.repeat(4096);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`{"client_name":"`));
      for (let i = 0; i < 10; i++) controller.enqueue(enc.encode(chunk));
      controller.enqueue(enc.encode(`","redirect_uris":["${REDIRECT}"]}`));
      controller.close();
    },
  });
  const res = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    // @ts-expect-error duplex — обязателен для стримового тела в fetch-совместимом Request
    duplex: 'half',
  });
  expect(res.status).toBe(413);
});

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

  // За одним кодом invalid_redirect_uri стоят четыре правила, и описание — единственный
  // канал отладки для разработчика чужого агента: отказ по фрагменту обязан называть
  // фрагмент, а не отправлять проверять схему и хост, где всё в порядке.
  const fragment = await json(
    await post({ client_name: 'X', redirect_uris: ['http://localhost:8080/cb#frag'] }),
  );
  expect(fragment.error_description).toContain('фрагмент');
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
