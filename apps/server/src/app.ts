// Сборка Hono-приложения (вынесено из index.ts ради тестируемости композиции роутов):
// index.ts инжектит боевые db/ai, тест — стабы + фикстурный webDistDir.
// Порядок роутов КРИТИЧЕН (слайс 1c-2, Task 7): API-роуты (/trpc/*, /mcp, /health)
// регистрируются ПЕРЕД статикой, поэтому их ответы никогда не перехватываются
// SPA-fallback'ом (Hono исполняет matching-хендлеры в порядке регистрации; API-хендлер
// возвращает Response и не зовёт next → serveStatic до него не доходит).
import { trpcServer } from '@hono/trpc-server';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import type { AiDeps } from './ai/send-message';
import { makeCreateContext } from './context';
import type { Db } from './db/client';
import { makeMcpHandler } from './mcp/transport';
import { appRouter } from './router';

/**
 * Корень собранной web-статики (Vite output). Относителен cwd прод-процесса; дефолт —
 * apps/web/dist (cwd = корень репозитория). Dockerfile (Task 6) переопределяет WEB_DIST_DIR
 * реальным путём внутри образа; тест передаёт абсолютный путь к фикстуре.
 */
export const WEB_DIST_DIR = process.env.WEB_DIST_DIR ?? 'apps/web/dist';

export interface AppDeps {
  db: Db;
  ai: AiDeps;
  /** Переопределение корня статики (тест/Docker); по умолчанию WEB_DIST_DIR. */
  webDistDir?: string;
}

export function createApp({ db, ai, webDistDir = WEB_DIST_DIR }: AppDeps): Hono {
  const app = new Hono();

  // --- API-роуты: регистрируются ПЕРЕД статикой (порядок = приоритет) ---
  app.use('/trpc/*', trpcServer({ router: appRouter, createContext: makeCreateContext(db, ai) }));
  // MCP-эндпоинт внешних агентов (§9.3): Streamable HTTP, PAT-only (transport.ts)
  app.all('/mcp', makeMcpHandler({ db }));
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // --- Same-origin раздача web-статики (Task 7, Вариант A) ---
  // GET-only: не-GET к неизвестному пути падает в 404 Hono (не в index.html), а API-роуты
  // выше уже забрали свои методы. serveStatic при отсутствии файла зовёт next() →
  // цепочка доходит до SPA-fallback (index.html) — только для GET.
  app.get('*', serveStatic({ root: webDistDir }));
  // SPA-fallback: любой не пойманный выше GET (клиентский роут вроде /browser/123) →
  // index.html. path игнорирует путь запроса, поэтому всегда отдаёт единый bootstrap.
  app.get('*', serveStatic({ path: 'index.html', root: webDistDir }));

  return app;
}
