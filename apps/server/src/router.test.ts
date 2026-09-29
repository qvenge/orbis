import { expect, test } from 'bun:test';
import { MIN_COMPATIBLE_CLIENT_VERSION } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { accountOf, mintGraph, personal } from '../test/helpers';
import { appRouter } from './router';
import type { Context } from './trpc';

// ping/whoami БД не трогают — стаб вместо пула соединений
const ctx: Context = {
  identity: null,
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

test('клиент 0.2.x (до формата тела v3) получает CLIENT_OUTDATED — старая вкладка не пишет v2', async () => {
  // Фокус ревью п. 5: вкладка, открытая до выкатки v3, несёт 0.2.x и документ v2. Первым её
  // останавливает этот гейт (412 «обновите»), вторым — гейт версии документа в executor'е.
  for (const v of ['0.2.0', '0.2.9']) {
    const caller = appRouter.createCaller({ ...ctx, clientVersion: v });
    const err = await caller.ping().then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect(((err as TRPCError).cause as { code?: string }).code).toBe('CLIENT_OUTDATED');
  }
});

test('клиент 0.3.x (до страниц 1б) получает CLIENT_OUTDATED (R-12)', async () => {
  // Вкладка 1а, открытая через деплой 1б, не знает узлов `ownCards`/`hostBlock`: tiptap подставил
  // бы пустой документ, и первая буква затёрла бы тело. Версия схемы документа та же (3), поэтому
  // старую вкладку останавливает только этот гейт — на чтении так же, как на записи.
  for (const v of ['0.3.0', '0.3.9']) {
    const caller = appRouter.createCaller({ ...ctx, clientVersion: v });
    const err = await caller.ping().then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect(((err as TRPCError).cause as { code?: string }).code).toBe('CLIENT_OUTDATED');
  }
});

test('клиент 0.4.x (до среза 1в) получает CLIENT_OUTDATED на entity.blocks и entity.get, 0.5.0 проходит гейт', async () => {
  // Срез 1в меняет провод `entity.blocks` (сумма по валютам, «последнее» с валютой, `closedIds` у
  // строк) и заводит узел `{{param}}` тела при той же версии схемы документа (R-12 1б, спека §5.1
  // «Формат»). Вкладка 1б читала бы `sum.sums` как отсутствующее поле и рисовала пустую плитку —
  // её останавливает гейт версии клиента, на чтении так же, как на записи.
  const id = '00000000-0000-7000-8000-0000000000f1';
  const blocks = { blocks: [{ key: 'a', text: 'aspect=orbis/task' }] };
  for (const v of ['0.4.0', '0.4.9']) {
    const caller = appRouter.createCaller({ ...ctx, clientVersion: v });
    for (const call of [() => caller.entity.blocks(blocks), () => caller.entity.get({ id })]) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as TRPCError).code).toBe('PRECONDITION_FAILED');
      expect(((err as TRPCError).cause as { code?: string }).code).toBe('CLIENT_OUTDATED');
    }
  }
  // 0.5.0 гейт версии проходит: дальше его останавливает авторизация (identity нет), а не версия.
  const fresh = appRouter.createCaller({ ...ctx, clientVersion: '0.5.0' });
  expect(await fresh.ping()).toEqual({ ok: true });
  for (const call of [() => fresh.entity.blocks(blocks), () => fresh.entity.get({ id })]) {
    const err = await call().then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as TRPCError).code).toBe('UNAUTHORIZED');
  }
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
const agentGraph = mintGraph();
const agentCtx: Context = { ...ctx, identity: personal(agentGraph), actorKind: 'agent' };

// Находка ревью 1c-2: timezone принималась как любая непустая строка, а queryContext
// строит из неё Intl.DateTimeFormat — невалидная зона роняла RangeError на каждом
// entity.query/count и на тулах агента. Гейт стоит во входной схеме, до withIdentity
// (db здесь — стаб: до БД дойти не должно).
const ownerCtx: Context = { ...ctx, identity: personal(mintGraph()), actorKind: 'owner' };

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
        role: 'mention',
      }),
    () =>
      caller.relation.delete({
        source_id: uuid,
        target_id: crypto.randomUUID(),
        role: 'mention',
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
  // Identity есть: PAT-агент аутентифицирован, version-гейт без заголовка молчит.
  // Наружу едет АКТОР пары — у личного графа это его же id (D44, `identityOfPerson`).
  const caller = appRouter.createCaller(agentCtx);
  expect(await caller.whoami()).toEqual({ actorUserId: accountOf(agentGraph) });
});

test('равная/новая версия, отсутствие и мусорный заголовок проходят', async () => {
  // Не-семver значение (пустое, префикс 'v', нечисловые компоненты, мусор)
  // эквивалентно отсутствию заголовка: пред-проверка формата не блокирует запрос
  const passing = [
    MIN_COMPATIBLE_CLIENT_VERSION,
    '0.5.1',
    '0.5.0',
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

test('ручки agenda.list нет (спека 1в §6.5): Повестка — запись поставки из блоков, не подписка', () => {
  // Настроить Повестку значит править её тело; вторая дорога к тем же строкам — отдельная ручка —
  // разошлась бы с телом на первой правке владельца.
  expect(Object.keys(appRouter._def.record)).not.toContain('agenda');
  expect(Object.keys(appRouter._def.procedures)).not.toContain('agenda.list');
});
