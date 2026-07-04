import { trpcServer } from '@hono/trpc-server';
import { Hono } from 'hono';
import { makeAiDeps } from './ai/send-message';
import { makeCreateContext } from './context';
import { makeDb } from './db/client';
import { appRouter } from './router';

// Один пул соединений на процесс; в request-контекст db попадает ссылкой (Task 12)
const { db } = makeDb();

// AI-deps — один инстанс на процесс (§7.7: провайдер один, имя модели — конфиг);
// fail-fast: невалидный ORBIS_LLM_PROVIDER/отсутствующий ключ роняют старт, не запрос
const ai = makeAiDeps();

const app = new Hono();

app.use('/trpc/*', trpcServer({ router: appRouter, createContext: makeCreateContext(db, ai) }));
app.get('/health', (c) => c.json({ status: 'ok' }));

export default {
  port: Number(process.env.PORT) || 3001,
  fetch: app.fetch,
};
