// apps/server/src/static.test.ts
// Тесты apps/server/src/app.ts. Task 7 (слайс 1c-2): same-origin раздача собранной
// web-статики из Hono + SPA-fallback. Ниже них — resolvePort (порт из env, слайс 4b):
// он живёт в том же модуле, потому что это такая же выведенная из окружения настройка
// раздачи, как WEB_DIST_DIR.
// Основная часть файла проверяет ДВЕ вещи одновременно:
//   1) статика отдаётся: GET / → index.html, GET /assets/* → ассет, PWA sw.js/manifest —
//      с корректным content-type, неизвестный не-API GET → SPA-fallback index.html;
//   2) порядок роутов: API-роуты (/trpc/*, /mcp, /health, /.well-known/* — метаданные
//      OAuth слайса 4b) НЕ перехвачены статик-роутом — их прежние ответы сохранены
//      (health {status:'ok'}, /mcp GET 405, POST без PAT 401, /trpc — tRPC-ответ,
//      метаданные — JSON, а не index.html).
// Статика берётся из фикстурной dist во временной папке (без сборки web): быстро,
// герметично, независимо от cwd — createApp принимает webDistDir абсолютным путём.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiDeps } from './ai/send-message';
import { createApp, DEFAULT_PORT, resolvePort, TRPC_MAX_BODY_BYTES } from './app';
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

  // Промах в /assets/* — НЕ клиентский роут: файл с хешем в имени либо есть, либо исчез
  // вместе со старым деплоем (каждый деплой — новый контейнер с чистым dist). SPA-fallback
  // отдавал на него index.html с 200 и text/html, и провал динамического import() приходил
  // в консоль ошибкой MIME («Failed to fetch dynamically imported module») вместо честного
  // «файла нет». С ленивыми чанками этот путь стал штатным.
  test('промах в /assets/* → 404, а не SPA-fallback', async () => {
    for (const path of ['/assets/index-DEADBEEF.js', '/assets/nested/chunk-DEADBEEF.js']) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
      expect(await res.text()).not.toContain(INDEX_MARKER);
    }
  });

  // HEAD ходит по GET-роутам Hono, поэтому до правки промах по HEAD тоже отвечал 200 и
  // text/html (телом пустым — оттого и незаметно). Прочие методы до статики не доходят
  // вовсе и падают в 404 Hono; пин держит обе половины метода-поверхности разом, чтобы
  // «ассета нет» нигде не выглядело как «вот вам страница».
  test('/assets/* не отдаёт HTML ни на одном методе', async () => {
    for (const method of ['HEAD', 'POST', 'PUT', 'DELETE']) {
      const res = await app.request('/assets/index-DEADBEEF.js', { method });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
    }
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

  // V1.2: планировщик рутин наблюдаем через /health той же формой, что реестр аспектов:
  // геттера нет — поля нет (тесты композиции, стенды без фона); выключен env'ом — 'off';
  // включён, но первый тик ещё не прошёл — 'pending'; дальше — ISO последнего тика.
  test('/health без геттера планировщика: форма прежняя, поля routineScheduler нет', async () => {
    const res = await app.request('/health');
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('/health с геттером планировщика: off / pending / ISO последнего тика, статус ok', async () => {
    const health = async (state: { enabled: boolean; lastTickAt: string | null }) => {
      const res = await createApp({
        db: {} as Db,
        ai: {} as AiDeps,
        webDistDir: distDir,
        routineScheduler: () => state,
      }).request('/health');
      return res.json();
    };
    expect(await health({ enabled: false, lastTickAt: null })).toEqual({
      status: 'ok',
      routineScheduler: 'off',
    });
    expect(await health({ enabled: true, lastTickAt: null })).toEqual({
      status: 'ok',
      routineScheduler: 'pending',
    });
    expect(await health({ enabled: true, lastTickAt: '2026-08-18T04:30:00.000Z' })).toEqual({
      status: 'ok',
      routineScheduler: '2026-08-18T04:30:00.000Z',
    });
  });

  test('/health несёт и дрейф реестра, и планировщик одновременно', async () => {
    const both = createApp({
      db: {} as Db,
      ai: {} as AiDeps,
      webDistDir: distDir,
      aspectDrift: () => ({ status: 'unknown' as const }),
      routineScheduler: () => ({ enabled: false, lastTickAt: null }),
    });
    expect(await (await both.request('/health')).json()).toEqual({
      status: 'ok',
      aspectDrift: 'unknown',
      routineScheduler: 'off',
    });
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

  // Метаданные OAuth (слайс 4b) — обычные GET по пути, который SPA-fallback перехватил бы
  // целиком: до монтирования в createApp оба адреса отдавали index.html с 200, то есть
  // MCP-клиент получал бы HTML вместо документа обнаружения и не находил вход вовсе.
  // Пин держит именно порядок регистрации, а не содержимое документов (оно — в
  // oauth/metadata.test.ts).
  test('метаданные OAuth НЕ перехвачены статикой (JSON, а не index.html)', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('json');
      expect(await res.text()).not.toContain(INDEX_MARKER);
    }
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

  // Неизвестный путь под /.well-known/* обязан быть 404, а не страницей приложения.
  // До правки SPA-fallback отдавал на них index.html с кодом 200: MCP-клиент обходит
  // документы обнаружения СПИСКОМ кандидатов и на 404 переходит к следующему, а 200 с
  // HTML даёт ему не мягкий откат, а исключение при разборе JSON. Первый адрес в списке —
  // ровно тот, что клиент вывел бы сам из нашего же resource_metadata, приписав слэш.
  test('неизвестный /.well-known/* → 404, а не SPA-fallback', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp/',
      '/.well-known/oauth-authorization-server/mcp',
      '/.well-known/openid-configuration',
      '/.well-known/',
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
      expect(await res.text()).not.toContain(INDEX_MARKER);
    }
  });

  // Отсечка выше не должна была съесть сами документы обнаружения — их пин рядом
  // («метаданные OAuth НЕ перехвачены статикой»), здесь держим границу с другой стороны.
  test('известные /.well-known/* по-прежнему отвечают JSON', async () => {
    const res = await app.request('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('json');
  });

  // /oauth/token и /oauth/register объявлены в метаданных как POST-эндпоинты, но на GET
  // до правки отдавали index.html с 200 — «страница вместо эндпоинта» того же рода, что и
  // выше. 405 (а не 404): путь существует, не годится метод, и Allow это называет прямо.
  // /oauth/authorize сюда НЕ попадает — это клиентский роут SPA, и он обязан остаться
  // страницей; поэтому отсечка поимённая, а не по /oauth/*.
  test('не-POST на /oauth/token и /oauth/register → 405 с Allow, а не index.html', async () => {
    for (const path of ['/oauth/token', '/oauth/register']) {
      for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
        const res = await app.request(path, { method });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('POST');
        expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
      }
    }
  });

  test('/oauth/authorize остаётся страницей SPA (отсечка выше его не задела)', async () => {
    const res = await app.request('/oauth/authorize?client_id=x&redirect_uri=y');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(INDEX_MARKER);
  });
});

// ---------------------------------------------------------------------------
// Защита от кликджекинга (финальное ревью слайса 4b, I1)
// ---------------------------------------------------------------------------
//
// Экран согласия — обычная страница SPA, и до правки сервис не ставил ни одного
// защитного заголовка: `GET /oauth/authorize` отвечал 200 text/html с пустыми
// X-Frame-Options и Content-Security-Policy. Сценарий, который это открывает:
// регистрация клиентов публична, а `client_name` не проверяется, поэтому чужой
// регистрируется «Claude Code» со своим адресом возврата, фреймит наш экран согласия
// под прозрачным оверлеем — и один клик владельца отправляет ему живой код авторизации.
// RFC 9700 §4.14 требует защищать authorization endpoint от кликджекинга явно.
//
// Пин держит ВЕСЬ сервис, а не только /oauth/authorize: Orbis нигде не встраивается, а
// защита, действующая на одном пути, теряется на следующем добавленном роуте.
describe('анти-фрейминг (I1): заголовки на всём сервисе', () => {
  test('каждый ответ несёт X-Frame-Options: DENY и frame-ancestors none', async () => {
    for (const path of [
      '/oauth/authorize?client_id=x', // экран согласия — ради него всё и затевалось
      '/', // корень SPA
      '/browser/123', // клиентский роут через SPA-fallback
      '/assets/app-abc123.js', // статика
      '/assets/index-DEADBEEF.js', // 404 отсечки ассетов
      '/health',
      '/mcp', // 405
      '/.well-known/oauth-protected-resource/mcp', // JSON-документ обнаружения
      '/.well-known/openid-configuration', // 404 отсечки well-known
      '/trpc/nonexistent',
    ]) {
      const res = await app.request(path);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
  });

  // Не-GET ходит по другой ветке композиции (статики на них нет вовсе), поэтому
  // заголовки на ней проверяются отдельно: middleware обязан быть общим, а не «на GET».
  test('заголовки стоят и на не-GET (POST /mcp без токена — 401)', async () => {
    const res = await app.request('/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

// ---------------------------------------------------------------------------
// resolvePort (ревью Task 3, раунд 3): PORT='0' обязан означать «свободный порт»
// ---------------------------------------------------------------------------
//
// Прежнее `Number(process.env.PORT) || 3001` съедало ровно ноль, и `PORT='0'` садилось на
// боевой 3001 — а ноль и есть единственный законный способ попросить свободный порт.
// Проба стартового гейта (oauth/metadata.test.ts) обещала им защиту от захода на 3001 и
// не давала её; тесты ниже стерегут механизм, а не обещание.

describe('resolvePort (порт HTTP-сервера из env)', () => {
  test("PORT='0' → 0 (свободный порт ядра), а НЕ 3001 — ровно тот случай, что съедало `|| 3001`", () => {
    expect(resolvePort('0')).toBe(0);
    expect(resolvePort('0')).not.toBe(DEFAULT_PORT);
  });

  test('не задано / пусто / пробелы → 3001 (Number("") — это 0, наивное ?? дало бы свободный порт)', () => {
    expect(resolvePort(undefined)).toBe(DEFAULT_PORT);
    expect(resolvePort('')).toBe(DEFAULT_PORT);
    expect(resolvePort('   ')).toBe(DEFAULT_PORT);
  });

  test('годное число — оно само (Render всегда передаёт PORT)', () => {
    expect(resolvePort('8080')).toBe(8080);
    expect(resolvePort(' 10000 ')).toBe(10000);
  });

  test('мусор и значения вне диапазона → 3001: кривой PORT не роняет старт', () => {
    for (const bad of ['abc', '80.5', '-1', '70000', 'NaN', '1e4x']) {
      expect(resolvePort(bad)).toBe(DEFAULT_PORT);
    }
  });
});
