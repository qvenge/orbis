import { expect, test } from 'bun:test';
import { MIN_COMPATIBLE_CLIENT_VERSION } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { appRouter } from './router';
import type { Context } from './trpc';

// ping/whoami БД не трогают — стаб вместо пула соединений
const ctx: Context = {
  actorUserId: null,
  actorKind: 'owner',
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

// §9.3 (Task 3): ownerOnlyProcedure — агент (PAT) не управляет аккаунтом владельца.
// db — стаб: FORBIDDEN обязан лететь из middleware ДО какого-либо обращения к БД.
const agentUserId = crypto.randomUUID();
const agentCtx: Context = { ...ctx, actorUserId: agentUserId, actorKind: 'agent' };

// Находка ревью 1c-2: timezone принималась как любая непустая строка, а queryContext
// строит из неё Intl.DateTimeFormat — невалидная зона роняла RangeError на каждом
// entity.query/count и на тулах агента. Гейт стоит во входной схеме, до withIdentity
// (db здесь — стаб: до БД дойти не должно).
const ownerCtx: Context = { ...ctx, actorUserId: crypto.randomUUID(), actorKind: 'owner' };

test('updateSettings: невалидная таймзона отклоняется валидацией входа', async () => {
  const caller = appRouter.createCaller(ownerCtx);
  const err = await caller.user.updateSettings({ timezone: 'Europe/Moskva' }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TRPCError);
  expect((err as TRPCError).code).toBe('BAD_REQUEST');
});

test('updateSettings: валидная IANA-зона проходит гейт валидации', async () => {
  const caller = appRouter.createCaller(ownerCtx);
  // Дальше вызов упрётся в db-стаб — важно лишь, что это не отказ валидации.
  const err = await caller.user.updateSettings({ timezone: 'Asia/Almaty' }).then(
    () => null,
    (e: unknown) => e,
  );
  expect((err as TRPCError | null)?.code).not.toBe('BAD_REQUEST');
});

test('ownerOnly под агентом: seedOnboarding/updateSettings/exportData → FORBIDDEN до БД', async () => {
  const caller = appRouter.createCaller(agentCtx);
  const calls: Array<() => Promise<unknown>> = [
    () => caller.user.seedOnboarding(),
    () => caller.user.updateSettings({}),
    () => caller.user.exportData(),
  ];
  for (const call of calls) {
    const err = await call().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('FORBIDDEN');
  }
});

// §9.3 (Task 10b): мутационная поверхность tRPC — поверхность владельца; единственный
// путь мутаций PAT-агента — /mcp → dispatchTool → политика §7.10. Входы структурно
// валидны (uuid и т.п.), чтобы zod-парсинг не подменил FORBIDDEN на BAD_REQUEST;
// db-стуб null доказывает, что гейт срабатывает ДО обращения к БД (пропусти он агента —
// упало бы не-FORBIDDEN ошибкой БД).
test('мутации графа/журнала под агентом: entity/relation/chat/undo → FORBIDDEN до БД', async () => {
  const caller = appRouter.createCaller(agentCtx);
  const uuid = crypto.randomUUID();
  const calls: Array<() => Promise<unknown>> = [
    () => caller.entity.create({ input: { title: 'x', tags: [] }, source: 'quick_capture' }),
    () => caller.entity.update({ id: uuid, title: 'x' }),
    () =>
      caller.relation.create({
        source_id: uuid,
        target_id: crypto.randomUUID(),
        relation_type: 'related_to',
      }),
    () =>
      caller.relation.delete({
        source_id: uuid,
        target_id: crypto.randomUUID(),
        relation_type: 'related_to',
      }),
    () => caller.chat.ensureThread({}),
    () => caller.chat.appendUserMessage({ id: crypto.randomUUID(), threadId: uuid, content: 'x' }),
    () => caller.ai.undo({ actionId: uuid }),
    () => caller.ai.undoLast(),
  ];
  for (const call of calls) {
    const err = await call().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('FORBIDDEN');
  }
});

test('агент проходит protectedProcedure (whoami) без заголовка версии', async () => {
  // Identity есть identity: PAT-агент аутентифицирован, version-гейт без заголовка молчит
  const caller = appRouter.createCaller(agentCtx);
  expect(await caller.whoami()).toEqual({ actorUserId: agentUserId });
});

test('равная/новая версия, отсутствие и мусорный заголовок проходят', async () => {
  // Не-семver значение (пустое, префикс 'v', нечисловые компоненты, мусор)
  // эквивалентно отсутствию заголовка: пред-проверка формата не блокирует запрос
  const passing = [
    MIN_COMPATIBLE_CLIENT_VERSION,
    '0.1.1',
    '0.2.0',
    '1.0.0',
    null,
    '',
    'v0.1.0',
    '0.0.x',
    'not-a-semver',
  ];
  for (const v of passing) {
    const caller = appRouter.createCaller({ ...ctx, clientVersion: v });
    expect(await caller.ping()).toEqual({ ok: true });
  }
});
