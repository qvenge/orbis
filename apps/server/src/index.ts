import { trpcServer } from '@hono/trpc-server';
import { Hono } from 'hono';
import { appRouter } from './router';
import { createContext } from './trpc';

const app = new Hono();

app.use('/trpc/*', trpcServer({ router: appRouter, createContext }));
app.get('/health', (c) => c.json({ status: 'ok' }));

export default {
  port: Number(process.env.PORT) || 3001,
  fetch: app.fetch,
};
