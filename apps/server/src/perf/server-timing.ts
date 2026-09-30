// `Server-Timing` (спека скорости §3.1, РП-3): время приложения и базы по HTTP-запросу, стандарт W3C Server Timing.
// «db» — суммарная длительность транзакций `withIdentity` (и `verifyBearer`) запроса: внутри транзакции идёт и код
// executor'а, значит это ВЕРХНЯЯ оценка времени базы. Хуков длительности запроса у postgres.js нет (Ф-А-3).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { MiddlewareHandler } from 'hono';

interface RequestTiming {
  readonly startedAt: number;
  dbMs: number;
}
const store = new AsyncLocalStorage<RequestTiming>();

export function withRequestTiming<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ startedAt: performance.now(), dbMs: 0 }, fn);
}
/** Вне запроса (планировщик, скрипты) — ничего: счётчика нет. */
export function addDbTime(ms: number): void {
  const t = store.getStore();
  if (t !== undefined) t.dbMs += ms;
}
export function serverTimingHeader(): string | null {
  const t = store.getStore();
  if (t === undefined) return null;
  // desc — ASCII намеренно: значение заголовка — ByteString (Fetch), кириллица роняет `Headers.set` (TypeError).
  return `app;dur=${(performance.now() - t.startedAt).toFixed(1)}, db;dur=${t.dbMs.toFixed(1)};desc="transactions"`;
}
/** Заголовок ставится ПОСЛЕ `next()` на готовом ответе — тот же приём, что у анти-фрейма (`app.ts`). */
export function serverTiming(): MiddlewareHandler {
  return (c, next) =>
    withRequestTiming(async () => {
      await next();
      const h = serverTimingHeader();
      if (h !== null) c.res.headers.set('Server-Timing', h);
    });
}
