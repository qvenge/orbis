// Тест глобального errorFormatter (Task 14, кросс-катная гигиена из ревью Task 12):
// неожиданные (не обёрнутые в TRPCError c нашим cause) ошибки БД/рантайма не должны
// отдавать клиенту сырой message (SQL-текст и т.п.). Путь реальный — через
// fetchRequestHandler, как в проде, а не через createCaller (caller отдаёт ошибку
// до форматирования shape).

import { expect, spyOn, test } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { execErrorToTRPC } from './errors';
import type { Context } from './trpc';
import { publicProcedure, router } from './trpc';

const testRouter = router({
  boom: publicProcedure.query(() => {
    // Имитация сырой ошибки драйвера БД (drizzle кладёт SQL и params в message)
    throw new Error('Failed query: insert into entity ... SECRET_SQL_TEXT params: 1,2,3');
  }),
  sysfail: publicProcedure.query(() => {
    // Имитация системной сетевой ошибки (fetch/undici): Error со СТРОКОВЫМ code —
    // дискриминатор структурированных ошибок не должен пропускать её без нейтрализации
    const e = new Error('connect ECONNREFUSED SECRET_HOST_LEAK:443') as Error & { code: string };
    e.code = 'ECONNREFUSED';
    throw e;
  }),
  conflict: publicProcedure.query(() => {
    throw execErrorToTRPC({ code: 'CONFLICT', message: 'client-UUID занят' });
  }),
  bad: publicProcedure.query(() => {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'плохой ввод' });
  }),
});

function call(path: string): Promise<Response> {
  return fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request(`http://localhost/trpc/${path}`),
    router: testRouter,
    createContext: (): Context => ({
      actorUserId: null,
      db: null as unknown as Context['db'],
      clientVersion: null,
    }),
  });
}

test('сырая ошибка → нейтральный message, без утечки SQL в ответ', async () => {
  const spy = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await call('boom');
    expect(res.status).toBe(500);
    const text = await res.text();
    // Весь ответ (message/data/stack/cause) не содержит сырого текста запроса
    expect(text).not.toContain('SECRET_SQL_TEXT');
    const body = JSON.parse(text) as { error: { message: string; data: { code: string } } };
    expect(body.error.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body.error.message).toBe('внутренняя ошибка сервера');
    // Исходный message сохранён в серверном логе, с контекстом (path процедуры)
    const logged = spy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('SECRET_SQL_TEXT');
    expect(logged).toContain('boom');
  } finally {
    spy.mockRestore();
  }
});

test('системный Error со строковым code (ECONNREFUSED) тоже нейтрализуется', async () => {
  const spy = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await call('sysfail');
    expect(res.status).toBe(500);
    const text = await res.text();
    // Ни message, ни stack не утекают клиенту
    expect(text).not.toContain('SECRET_HOST_LEAK');
    const body = JSON.parse(text) as { error: { message: string; data: { code: string } } };
    expect(body.error.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body.error.message).toBe('внутренняя ошибка сервера');
    // Оригинал — в серверном логе
    expect(spy.mock.calls.flat().map(String).join(' ')).toContain('SECRET_HOST_LEAK');
  } finally {
    spy.mockRestore();
  }
});

test('структурированные ошибки (CONFLICT/BAD_REQUEST) сохраняют свои message', async () => {
  const conflict = JSON.parse(await (await call('conflict')).text()) as {
    error: { message: string; data: { code: string } };
  };
  expect(conflict.error.data.code).toBe('CONFLICT');
  expect(conflict.error.message).toBe('client-UUID занят');

  const bad = JSON.parse(await (await call('bad')).text()) as {
    error: { message: string; data: { code: string } };
  };
  expect(bad.error.data.code).toBe('BAD_REQUEST');
  expect(bad.error.message).toBe('плохой ввод');
});
