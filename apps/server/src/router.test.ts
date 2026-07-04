import { MIN_COMPATIBLE_CLIENT_VERSION } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { expect, test } from 'bun:test';
import { appRouter } from './router';
import type { Context } from './trpc';

// ping/whoami БД не трогают — стаб вместо пула соединений
const ctx: Context = {
  actorUserId: null,
  clientVersion: null,
  db: null as unknown as Context['db'],
};

test('ping возвращает ok', async () => {
  const caller = appRouter.createCaller(ctx);
  expect(await caller.ping()).toEqual({ ok: true });
});

test('whoami без авторизации бросает UNAUTHORIZED', async () => {
  const caller = appRouter.createCaller(ctx);
  const err = await caller.whoami().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TRPCError);
  expect((err as TRPCError).code).toBe('UNAUTHORIZED');
});

// §9.1 min-compatible-version (Task 14): гейт стоит до protectedProcedure
test('клиент старше минимальной версии: PRECONDITION_FAILED + CLIENT_OUTDATED', async () => {
  const caller = appRouter.createCaller({ ...ctx, clientVersion: '0.0.9' });
  const err = await caller.ping().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TRPCError);
  expect((err as TRPCError).code).toBe('PRECONDITION_FAILED');
  const cause = (err as TRPCError).cause as { code?: string; min?: string } | undefined;
  expect(cause?.code).toBe('CLIENT_OUTDATED');
  expect(cause?.min).toBe(MIN_COMPATIBLE_CLIENT_VERSION);
});

test('устаревший клиент получает отказ версии раньше auth-проверки', async () => {
  const caller = appRouter.createCaller({ ...ctx, clientVersion: '0.0.1' });
  const err = await caller.whoami().then(
    () => null,
    (e: unknown) => e,
  );
  expect((err as TRPCError).code).toBe('PRECONDITION_FAILED');
});

test('равная/новая версия, отсутствие и мусорный заголовок проходят', async () => {
  // 'not-a-semver' эквивалентен отсутствию: NaN-компоненты не блокируют запрос
  for (const v of [MIN_COMPATIBLE_CLIENT_VERSION, '0.1.1', '0.2.0', '1.0.0', null, 'not-a-semver']) {
    const caller = appRouter.createCaller({ ...ctx, clientVersion: v });
    expect(await caller.ping()).toEqual({ ok: true });
  }
});
