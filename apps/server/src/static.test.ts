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
import { createApp, TRPC_MAX_BODY_BYTES } from './app';
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

  // Раньше статика уходила вовсе без Cache-Control: каждый визит перекачивал бандл.
  test('хешированный /assets/* → immutable на год; index.html и sw.js → no-cache', async () => {
    const asset = await app.request('/assets/app-abc123.js');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    for (const path of ['/', '/sw.js', '/browser/123']) {
      const res = await app.request(path);
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
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

  // E1: расхождение реестра аспектов наблюдаемо снаружи, но код ответа прежний —
  // не-200 здесь завалил бы healthCheckPath Render, то есть превратил бы наблюдаемость
  // ловушки в отказ деплоя. Без дрейфа (и пока проверка не ответила) поле не появляется.
  test('/health при дрейфе реестра: 200 + список аспектов, статус остаётся ok', async () => {
    const withDrift = createApp({
      db: {} as Db,
      ai: {} as AiDeps,
      webDistDir: distDir,
      aspectDrift: () => ({
        status: 'drift' as const,
        drift: {
          missing: ['orbis/memory' as const],
          drifted: [{ id: 'orbis/financial' as const, what: ['schema' as const] }],
        },
      }),
    });
    const res = await withDrift.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      aspectDrift: ['orbis/memory', 'orbis/financial'],
    });
  });

  // Провал проверки обязан отличаться от «расхождений нет»: на холодном старте
  // Render+Supabase БД бывает недоступна, и раньше одна неудачная попытка навсегда
  // снимала ловушку, а /health отвечал ровно как на здоровом реестре.
  test('/health при НЕвыполненной проверке: aspectDrift = "unknown", статус ok', async () => {
    const unknown = createApp({
      db: {} as Db,
      ai: {} as AiDeps,
      webDistDir: distDir,
      aspectDrift: () => ({ status: 'unknown' as const }),
    });
    const res = await unknown.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', aspectDrift: 'unknown' });
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

  // Бэкстоп тела /trpc/* (фикс-раунд C, находка A4): у tRPC лимита тела не было вовсе —
  // сверхбольшое тело доезжало до JSON.parse и zod. Гейт стоит ДО хендлера.
  test('POST /trpc/* сверх TRPC_MAX_BODY_BYTES → 413 PAYLOAD_TOO_LARGE, до хендлера', async () => {
    const oversized = 'x'.repeat(TRPC_MAX_BODY_BYTES + 1);
    const res = await app.request('/trpc/import.confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('тело ПОД лимитом проходит гейт: ответ — tRPC-формы, а не 413', async () => {
    const res = await app.request('/trpc/bad', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'y'.repeat(1024) }),
    });
    expect(res.status).not.toBe(413);
    expect(res.headers.get('content-type')).toContain('json');
  });
});
