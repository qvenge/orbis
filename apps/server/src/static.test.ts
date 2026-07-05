// apps/server/src/static.test.ts
// Task 7 (слайс 1c-2): same-origin раздача собранной web-статики из Hono + SPA-fallback.
// Проверяет ДВЕ вещи одновременно:
//   1) статика отдаётся: GET / → index.html, GET /assets/* → ассет, PWA sw.js/manifest —
//      с корректным content-type, неизвестный не-API GET → SPA-fallback index.html;
//   2) порядок роутов: API-роуты (/trpc/*, /mcp, /health) НЕ перехвачены статик-роутом —
//      их прежние ответы сохранены (health {status:'ok'}, /mcp GET 405, POST без PAT 401,
//      /trpc — tRPC-ответ, а не index.html).
// Статика берётся из фикстурной dist во временной папке (без сборки web): быстро,
// герметично, независимо от cwd — createApp принимает webDistDir абсолютным путём.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiDeps } from './ai/send-message';
import { createApp } from './app';
import type { Db } from './db/client';

const INDEX_MARKER = '<!--orbis-spa-root-->';
const ASSET_BODY = "console.log('orbis-asset');";

let distDir: string;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), 'orbis-dist-'));
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(
    join(distDir, 'index.html'),
    `<!doctype html><html><head><title>Orbis</title></head><body>${INDEX_MARKER}<div id="root"></div></body></html>`,
  );
  writeFileSync(join(distDir, 'assets', 'app-abc123.js'), ASSET_BODY);
  writeFileSync(join(distDir, 'sw.js'), '// service worker');
  writeFileSync(join(distDir, 'manifest.webmanifest'), '{"name":"Orbis"}');

  // db/ai не нужны на проверяемых путях (анонимные запросы: createContext не трогает db,
  // /mcp GET/401 возвращает до deps) — стабы достаточны и падают громко при случайном обращении.
  app = createApp({ db: {} as Db, ai: {} as AiDeps, webDistDir: distDir });
});

afterAll(() => {
  rmSync(distDir, { recursive: true, force: true });
});

describe('static serving + SPA-fallback (Task 7)', () => {
  test('GET / → index.html (200, text/html)', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain(INDEX_MARKER);
  });

  test('GET /assets/<x>.js → ассет (200, javascript)', async () => {
    const res = await app.request('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toBe(ASSET_BODY);
  });

  test('PWA sw.js → javascript content-type', async () => {
    const res = await app.request('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  test('PWA manifest.webmanifest → manifest+json content-type', async () => {
    const res = await app.request('/manifest.webmanifest');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('manifest+json');
  });

  test('неизвестный не-API GET (/browser/123) → SPA-fallback index.html', async () => {
    const res = await app.request('/browser/123');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain(INDEX_MARKER);
  });

  test('/health НЕ перехвачен: всё ещё {status:"ok"}', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('/mcp GET НЕ перехвачен: всё ещё 405 (POST-only)', async () => {
    const res = await app.request('/mcp');
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('METHOD_NOT_ALLOWED');
  });

  test('/mcp POST без PAT НЕ перехвачен: всё ещё 401', async () => {
    const res = await app.request('/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });

  test('GET /trpc/<неизвестная> НЕ перехвачен статикой (tRPC-ответ, не index.html)', async () => {
    const res = await app.request('/trpc/nonexistent');
    const text = await res.text();
    expect(text).not.toContain(INDEX_MARKER); // не SPA-fallback
    expect(res.headers.get('content-type')).toContain('json'); // tRPC-форма
  });

  test('POST /trpc/bad НЕ перехвачен статикой (POST мимо GET-fallback)', async () => {
    const res = await app.request('/trpc/bad', { method: 'POST' });
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
    expect(await res.text()).not.toContain(INDEX_MARKER);
  });
});
