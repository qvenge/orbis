// Сборка Hono-приложения (вынесено из index.ts ради тестируемости композиции роутов):
// index.ts инжектит боевые db/ai, тест — стабы + фикстурный webDistDir.
// Порядок роутов КРИТИЧЕН (слайс 1c-2, Task 7): API-роуты (/trpc/*, /mcp, /health)
// регистрируются ПЕРЕД статикой, поэтому их ответы никогда не перехватываются
// SPA-fallback'ом (Hono исполняет matching-хендлеры в порядке регистрации; API-хендлер
// возвращает Response и не зовёт next → serveStatic до него не доходит).
import { trpcServer } from '@hono/trpc-server';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from 'hono/bun';
import type { AiDeps } from './ai/send-message';
import { makeCreateContext } from './context';
import type { AspectDriftStatus } from './db/aspect-drift';
import type { Db } from './db/client';
import { makeMcpHandler } from './mcp/transport';
import { appRouter } from './router';

/**
 * Корень собранной web-статики (Vite output). Относителен cwd прод-процесса; дефолт —
 * apps/web/dist и в образе (Dockerfile выставляет WORKDIR=/app и на дефолт полагается);
 * тест передаёт абсолютный путь к фикстуре.
 */
export const WEB_DIST_DIR = process.env.WEB_DIST_DIR ?? 'apps/web/dist';

/**
 * Заголовки кэша статики: serveStatic из hono не ставит ни Cache-Control, ни ETag —
 * каждый визит до установки service worker перекачивал весь бандл (трафик free-плана,
 * медленный первый рендер). Файлы /assets/* имеют хеш в имени → immutable на год;
 * всё остальное (index.html, sw.js, manifest) обязано перепроверяться, иначе клиент
 * застрянет на старой версии.
 */
function cacheHeaders(path: string, c: Context): void {
  const immutable = path.includes('/assets/');
  c.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
}

/**
 * Потолок тела /trpc/* — общий бэкстоп транспорта (не «лимит импорта»). До него у
 * tRPC не было лимита тела вовсе: любая мутация принимала гигабайтное тело, и его
 * разбирал JSON.parse ДО первой zod-проверки. Размер выбран по САМОЙ большой законной
 * мутации — import.confirm на MAX_IMPORT_ROWS строк: замер (фикс-раунд, A6) дал
 * 103 КБ на 300 строк и 344 КБ на 1000; поле `raw` строки схемой по длине не
 * ограничено, поэтому берём запас на выписку с длинными назначениями платежа.
 * 4 МиБ — с десятикратным запасом к замеру и всё ещё настоящий бэкстоп. Доменные
 * потолки (MAX_IMPORT_ROWS, .max() схем) он не заменяет: они дают внятный отказ,
 * этот — режет мусор до парсинга.
 */
export const TRPC_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Платформенный body-limit /trpc/* по образцу /mcp (mcp/transport.ts): считает по
 * ФАКТИЧЕСКИ прочитанным байтам, поэтому закрывает и chunked-тело без content-length.
 * Форма 413 — та же структурная, что у /mcp.
 */
const trpcBodyLimit = bodyLimit({
  maxSize: TRPC_MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `тело запроса превышает лимит ${TRPC_MAX_BODY_BYTES} байт`,
        },
      },
      413,
    ),
});

export interface AppDeps {
  db: Db;
  ai: AiDeps;
  /** Переопределение корня статики (тест/Docker); по умолчанию WEB_DIST_DIR. */
  webDistDir?: string;
  /**
   * Состояние стартовой проверки реестра аспектов (E1) — геттер, потому что проверка
   * асинхронная и приложение поднимается, не дожидаясь её. Геттера нет вовсе (тесты
   * композиции, встроенные стенды) — /health про реестр молчит.
   */
  aspectDrift?: () => AspectDriftStatus;
}

export function createApp({ db, ai, webDistDir = WEB_DIST_DIR, aspectDrift }: AppDeps): Hono {
  const app = new Hono();

  // --- API-роуты: регистрируются ПЕРЕД статикой (порядок = приоритет) ---
  // Size-гейт ДО tRPC-хендлера: сверхлимитное тело отсекается прежде JSON-парсинга и
  // любой zod-валидации (порядок регистрации = порядок исполнения middleware).
  app.use('/trpc/*', trpcBodyLimit);
  app.use('/trpc/*', trpcServer({ router: appRouter, createContext: makeCreateContext(db, ai) }));
  // MCP-эндпоинт внешних агентов (§9.3): Streamable HTTP, PAT-only (transport.ts)
  app.all('/mcp', makeMcpHandler({ db }));
  // Форма ответа на здоровом реестре НЕ меняется ({status:'ok'}) — на неё смотрит и
  // healthCheckPath Render, и тесты. Расхождение добавляет поле, но не меняет код ответа:
  // не-200 здесь превратил бы наблюдаемость ловушки в отказ деплоя (E1). Третье значение
  // — 'unknown': проверка не выполнилась (БД была недоступна на старте), и выдавать это
  // за «расхождений нет» нельзя — именно так ловушка снималась молча.
  app.get('/health', (c) => {
    const state = aspectDrift?.();
    if (state === undefined || state.status === 'ok') return c.json({ status: 'ok' });
    if (state.status === 'unknown') return c.json({ status: 'ok', aspectDrift: 'unknown' });
    return c.json({
      status: 'ok',
      aspectDrift: [...state.drift.missing, ...state.drift.drifted.map((d) => d.id)],
    });
  });

  // --- Same-origin раздача web-статики (Task 7, Вариант A) ---
  // GET-only: не-GET к неизвестному пути падает в 404 Hono (не в index.html), а API-роуты
  // выше уже забрали свои методы. serveStatic при отсутствии файла зовёт next() →
  // цепочка доходит до SPA-fallback (index.html) — только для GET.
  app.get('*', serveStatic({ root: webDistDir, onFound: cacheHeaders }));
  // Отсечка ДО SPA-fallback: хешированный ассет либо существует (его отдал serveStatic
  // выше и сюда не дошёл), либо исчез вместе со старым деплоем — клиентским роутом
  // /assets/* не бывает никогда. Без этой строки fallback отдаёт на промах index.html
  // с 200 и text/html, и провал динамического import() приходит в консоль ошибкой MIME
  // («Failed to fetch dynamically imported module») вместо «файла нет»; на честный 404
  // опирается клиентский обработчик vite:preloadError. c.notFound(), а не свой c.text:
  // тот же путь при не-GET уже отвечает штатным 404 Hono, и расходиться телом ответа
  // по методу незачем.
  // Отсечка НАМЕРЕННО узкая — только /assets/*. Хешированные файлы есть и в корне dist
  // (workbox-<хеш>.js, на него ссылается sw.js): промах по ним по-прежнему отдаёт HTML,
  // и в узкое окно скользящего деплоя service worker упадёт SyntaxError вместо «файла
  // нет». Улик, что это случалось, нет, а «всё с хешем в имени» — правило, которое
  // некому проверять; расширять отсечку без улики не стали.
  app.get('/assets/*', (c) => c.notFound());
  // SPA-fallback: любой не пойманный выше GET (клиентский роут вроде /browser/123) →
  // index.html. path игнорирует путь запроса, поэтому всегда отдаёт единый bootstrap.
  app.get('*', serveStatic({ path: 'index.html', root: webDistDir, onFound: cacheHeaders }));

  return app;
}
