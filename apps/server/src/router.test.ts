import { expect, test } from 'bun:test';
import { appRouter } from './router';
import type { Context } from './trpc';

// ping/whoami БД не трогают — стаб вместо пула соединений
const ctx: Context = { actorUserId: null, db: null as unknown as Context['db'] };

test('ping возвращает ok', async () => {
  const caller = appRouter.createCaller(ctx);
  expect(await caller.ping()).toEqual({ ok: true });
});

test('whoami без авторизации бросает UNAUTHORIZED', async () => {
  const caller = appRouter.createCaller(ctx);
  await expect(caller.whoami()).rejects.toThrow();
});
