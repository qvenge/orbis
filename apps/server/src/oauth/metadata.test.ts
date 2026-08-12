// apps/server/src/oauth/metadata.test.ts
// Точка входа OAuth: два публичных документа метаданных (RFC 9728 для ресурса,
// RFC 8414 для authorization server), по которым MCP-клиент понимает, куда идти
// авторизовываться. Базе тут делать нечего — модуль это чистые функции от
// ORBIS_PUBLIC_URL и запроса, поэтому файл гоняется без --env-file.
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { OAUTH_AUTHORIZE_PATH } from '@orbis/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  assertPublicOriginConfigured,
  mountOAuthMetadata,
  protectedResourceMetadataUrl,
  publicOrigin,
} from './metadata';

const saved = process.env.ORBIS_PUBLIC_URL;
const savedNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  if (saved === undefined) delete process.env.ORBIS_PUBLIC_URL;
  else process.env.ORBIS_PUBLIC_URL = saved;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
});

function app() {
  const a = new Hono();
  mountOAuthMetadata(a);
  return a;
}

/** Контекст-заглушка для функций, которым нужен только адрес запроса. */
function ctx(url: string): Context {
  return { req: { url } } as unknown as Context;
}

test('метаданные ресурса называют канонический URI и наш AS', async () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com';
  const res = await app().request('/.well-known/oauth-protected-resource');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.resource).toBe('https://orbis.example.com/mcp');
  expect(body.authorization_servers).toEqual(['https://orbis.example.com']);
  expect(body.bearer_methods_supported).toEqual(['header']);
  // Имя ресурса владелец увидит на экране согласия — его пропажа иначе не всплывёт
  // до ручной проверки глазами.
  expect(body.resource_name).toBe('Orbis');
});

test('path-aware адрес метаданных ресурса отдаёт то же самое (RFC 9728 §3.1)', async () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com';
  const res = await app().request('/.well-known/oauth-protected-resource/mcp');
  expect((await res.json()).resource).toBe('https://orbis.example.com/mcp');
});

test('метаданные AS перечисляют эндпоинты, S256 и DCR', async () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com';
  const body = await (await app().request('/.well-known/oauth-authorization-server')).json();
  expect(body.issuer).toBe('https://orbis.example.com');
  // Путь экрана согласия сверяется с контрактом маршрутов (@orbis/shared), а не с третьей
  // копией строки: его же читает SPA, выбирая экран. Origin при этом пинится отдельно —
  // адрес обязан быть НАШ и абсолютный, иначе клиент уйдёт авторизовываться на чужой хост.
  const authorize = new URL(body.authorization_endpoint);
  expect(authorize.origin).toBe('https://orbis.example.com');
  expect(authorize.pathname).toBe(OAUTH_AUTHORIZE_PATH);
  expect(body.token_endpoint).toBe('https://orbis.example.com/oauth/token');
  expect(body.registration_endpoint).toBe('https://orbis.example.com/oauth/register');
  expect(body.code_challenge_methods_supported).toEqual(['S256']);
  expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  // response_types_supported — REQUIRED по RFC 8414 §2: молчаливая пропажа ломает
  // строгих клиентов, а не даёт мягкую деградацию.
  expect(body.response_types_supported).toEqual(['code']);
  expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
  expect(body.scopes_supported).toEqual(['full']);
});

// NODE_ENV выставляется ЯВНО, а не берётся из окружения прогона: фолбэк на адрес
// запроса разрешён только вне production, и тест обязан проверять именно эту ветку,
// а не то, чем `bun test` случайно заполнил NODE_ENV.
test('без ORBIS_PUBLIC_URL база берётся из запроса (локальный стенд)', async () => {
  delete process.env.ORBIS_PUBLIC_URL;
  process.env.NODE_ENV = 'development';
  const body = await (
    await app().request('http://127.0.0.1:3020/.well-known/oauth-protected-resource')
  ).json();
  expect(body.resource).toBe('http://127.0.0.1:3020/mcp');
});

// Обратная половина того же решения (Р8) и единственная причина, по которой переменная
// вообще обязательна: без этой ветки подменённый Host увёл бы клиента на чужой
// authorization server прямо через наши метаданные, и все тесты выше остались бы зелёными.
test('в production без ORBIS_PUBLIC_URL база НЕ выводится из запроса — отказ', () => {
  delete process.env.ORBIS_PUBLIC_URL;
  process.env.NODE_ENV = 'production';
  expect(() =>
    publicOrigin(ctx('https://attacker.example/.well-known/oauth-protected-resource')),
  ).toThrow(/ORBIS_PUBLIC_URL/);
});

// Кривое значение переменной раньше проезжало молча и получалось хуже, чем отказ.
// Худший случай — значение с путём (`https://host/base`): адрес PRM выходил
// `https://host/base/.well-known/oauth-protected-resource`, такого роута нет ни одного,
// и запрос уезжал в SPA-fallback — клиент получал index.html с кодом 200 на документе
// обнаружения. Ровно та беззвучная поломка, ради которой пинится порядок роутов,
// только заходящая через переменную окружения. `publicOrigin` обязан вернуть чистый
// origin либо не вернуть ничего.
const brokenValues: Array<[string, string]> = [
  ['https://orbis.example.com/base', 'путь'],
  ['https://orbis.example.com/base/', 'путь с хвостовым слэшем'],
  ['https://orbis.example.com/?x=1', 'query'],
  ['https://orbis.example.com/#f', 'фрагмент'],
  ['orbis.example.com', 'без схемы — URL такое не разбирает'],
  ['not a url', 'вообще не URL'],
  ['ftp://orbis.example.com', 'не http(s) — origin вышел бы строкой "null"'],
];
for (const [value, why] of brokenValues) {
  test(`ORBIS_PUBLIC_URL=${JSON.stringify(value)} (${why}) — громкий отказ`, () => {
    process.env.ORBIS_PUBLIC_URL = value;
    // Ошибка обязана называть переменную: иначе на проде её ищут по стектрейсу.
    expect(() => publicOrigin(ctx('http://127.0.0.1:3020/mcp'))).toThrow(/ORBIS_PUBLIC_URL/);
  });
}

// Отказ не должен превращаться в молчаливый фолбэк на адрес запроса — иначе кривая
// переменная вне production выглядела бы как «всё работает», а в проде ломалась.
test('кривое значение — отказ, а НЕ откат на адрес запроса', () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com/base';
  process.env.NODE_ENV = 'development';
  expect(() => publicOrigin(ctx('http://127.0.0.1:3020/mcp'))).toThrow(/ORBIS_PUBLIC_URL/);
});

test('пробелы по краям ORBIS_PUBLIC_URL прощаются', () => {
  process.env.ORBIS_PUBLIC_URL = '  https://orbis.example.com/  ';
  expect(publicOrigin(ctx('http://127.0.0.1:3020/mcp'))).toBe('https://orbis.example.com');
});

test('нестандартный порт — часть origin и не теряется', () => {
  process.env.ORBIS_PUBLIC_URL = 'http://127.0.0.1:3020';
  expect(publicOrigin(ctx('http://example.invalid/mcp'))).toBe('http://127.0.0.1:3020');
});

test('хвостовой слэш в ORBIS_PUBLIC_URL не даёт двойного слэша', async () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com/';
  const body = await (await app().request('/.well-known/oauth-protected-resource')).json();
  expect(body.resource).toBe('https://orbis.example.com/mcp');
});

// Этот адрес транспорт /mcp кладёт в WWW-Authenticate (Task 3) — он обязан быть
// абсолютным, не зависеть от того, по какому адресу пришёл запрос, и быть той самой
// path-aware формой (RFC 9728 §3.1), которую клиент вывел бы сам из <origin>/mcp.
test('адрес метаданных ресурса абсолютен, path-aware и берётся из ORBIS_PUBLIC_URL', () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com/';
  expect(protectedResourceMetadataUrl(ctx('http://127.0.0.1:3020/mcp'))).toBe(
    'https://orbis.example.com/.well-known/oauth-protected-resource/mcp',
  );
});

// Указатель бесполезен, если по нему ничего нет: адрес из заголовка обязан быть
// смонтированным роутом, а не просто правильно составленной строкой.
test('по адресу из WWW-Authenticate действительно лежат метаданные ресурса', async () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com';
  const url = protectedResourceMetadataUrl(ctx('https://orbis.example.com/mcp'));
  const res = await app().request(url);
  expect(res.status).toBe(200);
  expect((await res.json()).resource).toBe('https://orbis.example.com/mcp');
});

// ---------------------------------------------------------------------------
// Стартовый гейт конфигурации (D28-манера: неоднозначное/кривое значение роняет старт)
// ---------------------------------------------------------------------------
//
// Зачем он появился (ревью Task 3): с тех пор как 401 на /mcp несёт resource_metadata,
// бросок publicOrigin случается НА ПУТИ ОТКАЗА — и /mcp начинал отдавать 500 вместо 401.
// Причём не только в production: parsePublicOrigin бракует путь/query/не-http при любом
// NODE_ENV, поэтому опечатка вида `…onrender.com/mcp` роняла дверь и на локальном стенде.
// До Task 3 /mcp отдавал 401 при любой конфигурации, так что это был регресс режима
// отказа. Лечим не мягким откатом (он вернул бы бесполезный 401 без указателя), а
// отказом при старте: процесс с кривым значением просто не поднимается.

// env инжектится литералом (как у makeLLMProvider) — тест не зависит от окружения прогона
test('стартовый гейт: корректное значение — молча проходит', () => {
  expect(() =>
    assertPublicOriginConfigured({ ORBIS_PUBLIC_URL: 'https://orbis.example.com' }),
  ).not.toThrow();
  expect(() =>
    assertPublicOriginConfigured({
      ORBIS_PUBLIC_URL: 'https://orbis.example.com/',
      NODE_ENV: 'production',
    }),
  ).not.toThrow();
});

test('стартовый гейт: вне production переменную разрешено не задавать (фолбэк на адрес запроса)', () => {
  expect(() => assertPublicOriginConfigured({})).not.toThrow();
  expect(() => assertPublicOriginConfigured({ NODE_ENV: 'development' })).not.toThrow();
});

test('стартовый гейт: в production без переменной — отказ', () => {
  expect(() => assertPublicOriginConfigured({ NODE_ENV: 'production' })).toThrow(
    /ORBIS_PUBLIC_URL/,
  );
});

// Главная новая ветка: кривое значение бракуется НЕЗАВИСИМО от NODE_ENV — именно этот
// случай (опечатка на локальном стенде) отдавал 500 на /mcp и в отчёт Task 3 не попал.
for (const [value, why] of brokenValues) {
  test(`стартовый гейт вне production: ORBIS_PUBLIC_URL=${JSON.stringify(value)} (${why}) — отказ`, () => {
    expect(() => assertPublicOriginConfigured({ ORBIS_PUBLIC_URL: value })).toThrow(
      /ORBIS_PUBLIC_URL/,
    );
  });
}

// Проверка функции ничего не говорит о том, что её КТО-ТО ЗОВЁТ. Гейт имеет смысл только
// если процесс от кривого значения умирает, поэтому здесь поднимается настоящий index.ts
// отдельным процессом. Гейт стоит первым — до пула БД и до провайдера LLM, — поэтому
// проба не требует ни базы, ни ключей и умирает мгновенно.
const serverDir = join(import.meta.dir, '../..');

/**
 * Запуск настоящего index.ts.
 *
 * Три явные переменные — не украшение, а условие осмысленности пробы. Ребёнок
 * АВТОМАТИЧЕСКИ подхватывает `apps/server/.env` из cwd (это и есть та самая зависимость
 * от окружения прогона, от которой лечился mcp.test.ts, только через дочерний процесс);
 * явное значение `.env` перебивает, поэтому:
 *   • ORBIS_PUBLIC_URL='' — пустая строка falsy после trim, то есть «переменной нет», и
 *     production-ветка сработает даже когда переменная появится в .env (а она вот-вот
 *     появится в задаче про прод — иначе тест стал бы ложно-красным ценой 15 секунд);
 *   • PORT='0' — если гейт вдруг НЕ сработает И база при этом окажется настроенной,
 *     ребёнок сядет на свободный порт, выбранный ядром, а не на боевой 3001, где живёт
 *     dev-сервер: поднять настоящий API против dev-базы прямо из тестов хуже, чем
 *     красный тест. (Строка заработала только в раунде 3 ревью: до починки resolvePort
 *     выражение `Number(PORT) || 3001` съедало ноль, и ребёнок садился ровно на 3001 —
 *     механизм пинится в static.test.ts.)
 *   • DATABASE_URL='' — makeDb на нём отказывает. Это ускоряет провал регрессии (без
 *     гейта процесс умрёт сразу, а не провисит до таймаута) и заодно ПИНИТ ПОРЯДОК:
 *     дочитаться до сообщения про ORBIS_PUBLIC_URL можно, только если гейт стоит ДО
 *     пула БД. Переставь его ниже makeDb — и stderr заговорит про DATABASE_URL.
 *
 * timeout — последний рубеж на случай, если процесс всё-таки доживёт до Bun.serve:
 * без него повис бы весь прогон. Прибитый по таймауту отличается от умершего
 * самостоятельно по signalCode, и тест этого не прощает.
 */
function startServer(env: Record<string, string>) {
  const p = Bun.spawnSync(['bun', 'src/index.ts'], {
    cwd: serverDir,
    env: {
      PATH: process.env.PATH ?? '',
      ORBIS_PUBLIC_URL: '',
      PORT: '0',
      DATABASE_URL: '',
      ...env,
    },
    timeout: 15_000,
  });
  // Нормализуем: у самостоятельно завершившегося процесса Bun отдаёт undefined,
  // у прибитого — имя сигнала; сравнивать удобнее с одним значением
  return { exitCode: p.exitCode, signalCode: p.signalCode ?? null, stderr: p.stderr.toString() };
}

test('index.ts не поднимается с кривым ORBIS_PUBLIC_URL (гейт реально подключён)', () => {
  const r = startServer({ ORBIS_PUBLIC_URL: 'https://orbis.example.com/mcp' });
  expect(r.signalCode).toBeNull(); // отказался сам, а не был прибит по таймауту
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr).toContain('ORBIS_PUBLIC_URL');
});

test('index.ts не поднимается в production без ORBIS_PUBLIC_URL', () => {
  const r = startServer({ NODE_ENV: 'production' });
  expect(r.signalCode).toBeNull();
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr).toContain('ORBIS_PUBLIC_URL');
});
