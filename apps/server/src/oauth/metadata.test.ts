// apps/server/src/oauth/metadata.test.ts
// Точка входа OAuth: два публичных документа метаданных (RFC 9728 для ресурса,
// RFC 8414 для authorization server), по которым MCP-клиент понимает, куда идти
// авторизовываться. Базе тут делать нечего — модуль это чистые функции от
// ORBIS_PUBLIC_URL и запроса, поэтому файл гоняется без --env-file.
import { afterEach, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { mountOAuthMetadata, protectedResourceMetadataUrl, publicOrigin } from './metadata';

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
  expect(body.authorization_endpoint).toBe('https://orbis.example.com/oauth/authorize');
  expect(body.token_endpoint).toBe('https://orbis.example.com/oauth/token');
  expect(body.registration_endpoint).toBe('https://orbis.example.com/oauth/register');
  expect(body.code_challenge_methods_supported).toEqual(['S256']);
  expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
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

test('хвостовой слэш в ORBIS_PUBLIC_URL не даёт двойного слэша', async () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com/';
  const body = await (await app().request('/.well-known/oauth-protected-resource')).json();
  expect(body.resource).toBe('https://orbis.example.com/mcp');
});

// Этот адрес транспорт /mcp положит в WWW-Authenticate (следующая задача) — он обязан
// быть абсолютным и не зависеть от того, по какому адресу пришёл запрос.
test('адрес метаданных ресурса абсолютен и берётся из ORBIS_PUBLIC_URL', () => {
  process.env.ORBIS_PUBLIC_URL = 'https://orbis.example.com/';
  expect(protectedResourceMetadataUrl(ctx('http://127.0.0.1:3020/mcp'))).toBe(
    'https://orbis.example.com/.well-known/oauth-protected-resource',
  );
});
