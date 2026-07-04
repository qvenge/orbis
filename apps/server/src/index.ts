import { trpcServer } from '@hono/trpc-server';
import { Hono } from 'hono';
import { makeCreateContext } from './context';
import { makeDb } from './db/client';
import { appRouter } from './router';

// Один пул соединений на процесс; в request-контекст db попадает ссылкой (Task 12)
const { db } = makeDb();

const app = new Hono();

app.use('/trpc/*', trpcServer({ router: appRouter, createContext: makeCreateContext(db) }));
app.get('/health', (c) => c.json({ status: 'ok' }));

export default {
  port: Number(process.env.PORT) || 3001,
  fetch: app.fetch,
};
