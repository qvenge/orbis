import { expect, test } from 'bun:test';
import { appRouter } from './router';

test('ping возвращает ok', async () => {
  const caller = appRouter.createCaller({ actorUserId: null });
  expect(await caller.ping()).toEqual({ ok: true });
});

test('whoami без авторизации бросает UNAUTHORIZED', async () => {
  const caller = appRouter.createCaller({ actorUserId: null });
  await expect(caller.whoami()).rejects.toThrow();
});
