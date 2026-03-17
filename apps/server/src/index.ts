import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { trpcServer } from '@hono/trpc-server';
import { appRouter } from './router.ts';
import { createContext } from './trpc.ts';

const app = new Hono();

app.use(
  '/*',
  cors({
    origin: ['http://localhost:5173'],
    credentials: true,
  }),
);

// Simple in-memory rate limiter for AI endpoint
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 20; // requests per minute
const RATE_WINDOW = 60_000; // 1 minute

app.use('/trpc/ai.chat*', async (c, next) => {
  const authHeader = c.req.header('authorization') ?? 'anon';
  const key = authHeader.slice(0, 50);
  const now = Date.now();

  let entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    rateLimitMap.set(key, entry);
  }

  entry.count++;
  if (entry.count > RATE_LIMIT) {
    return c.json({ error: 'Rate limit exceeded. Try again later.' }, 429);
  }

  await next();
});

// Periodic cleanup of stale rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 60_000);

app.use(
  '/trpc/*',
  trpcServer({
    router: appRouter,
    createContext: ({ req }) => createContext({ req }),
  }),
);

app.get('/health', (c) =>
  c.json({ status: 'ok', version: '0.3', timestamp: new Date().toISOString() }),
);

const port = Number(process.env.PORT) || 3001;
console.log(`Orbis server v0.3 running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
