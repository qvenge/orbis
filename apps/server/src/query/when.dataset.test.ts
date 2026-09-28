// apps/server/src/query/when.dataset.test.ts
// ТАБЛИЦА СЛУЧАЕВ С1в-1 (спека 1в §3.1–§3.3, §4.2): значение «когда» и адреса слотов на мире
// `seedWhenWorld` — компилят исполняется на настоящей базе под идентичностью владельца (RLS), с
// фиксированными «сегодня» `2026-07-15` (среда) и поясом `Asia/Novosibirsk`, по образцу
// `compile.dataset.test.ts`. Каждая строка — текст запроса → множество имён записей мира; порядок
// сверяется только там, где таблица его называет.
//
// Токены — только формой `=T` (края токенов в сравнениях — задача 2); сравнения — литералами.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type AspectDefinition,
  aspectDefinitionSchema,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  type GraphId,
  propertyDefinitionSchema,
} from '@orbis/shared';
import { parseQueryAst, type QueryAst, toParseRegistry } from '@orbis/shared/query';
import { eq, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { adminDb, appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { seedWhenWorld, type WhenName, type WhenWorld } from '../../test/when-world';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { parseGraphId } from '../identity';
import { effectiveRegistry } from '../registry/cache';
import { setExtensionDisabled } from '../registry/extensions';
import type { RegistrySnapshot } from '../registry/load';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { type CompileCtx, compileQueryAst, compileSumAst } from './compile-ast';
import { DEFAULT_TIMEZONE, todayInTimeZone } from './context';
import { addressSortKey, slotValuesSql } from './contract-sql';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});

const TODAY = '2026-07-15';
const TIME_ZONE = 'Asia/Novosibirsk';

let graph: GraphId;
let world: WhenWorld;

beforeAll(async () => {
  graph = await freshGraph();
  world = await seedWhenWorld(graph, { today: TODAY, timeZone: TIME_ZONE });
});

/** Контекст компиляции с зафиксированными «сегодня» и поясом — реестр владельца из базы. */
async function ctx(): Promise<CompileCtx> {
  const reg = await withIdentity(db, personal(graph), (tx) => effectiveRegistry(tx, graph));
  return {
    graphId: graph,
    today: TODAY,
    timeZone: TIME_ZONE,
    weekStart: 'monday',
    reg,
    thisEntityId: null,
  };
}

function parse(text: string, c: CompileCtx): QueryAst {
  const parsed = parseQueryAst(text, toParseRegistry(c.reg, 'ru'));
  if (!parsed.ok) throw new Error(`«${text}»: ${parsed.error.code} — ${parsed.error.message}`);
  return parsed.ast;
}

/**
 * Имена выдачи в её порядке. Служебная запись мира (категория `F1`) из выдачи вычитается: в
 * таблице её нет. Любой ДРУГОЙ неизвестный id — отказ теста, а не тихий пропуск.
 */
async function names(query: string | QueryAst): Promise<WhenName[]> {
  const c = await ctx();
  const ast = typeof query === 'string' ? parse(query, c) : query;
  const rows = await withIdentity(db, personal(graph), (tx) => tx.execute(compileQueryAst(ast, c)));
  return [...rows].flatMap((r) => {
    const id = (r as { id: string }).id;
    if (world.helperIds.includes(id)) return [];
    const name = world.nameOf.get(id);
    if (name === undefined) throw new Error(`в выдаче запись вне мира: ${id}`);
    return [name];
  });
}

const sorted = (xs: readonly string[]) => [...xs].sort();

/** Таблица С1в-1: запрос → множество имён (порядок не сверяется). */
const SET_CASES: ReadonlyArray<[string, WhenName[]]> = [
  ['orbis/when=today', ['E2', 'T3', 'T11a']],
  // У T8 дата впереди; сделанное вчера — истинно (§3.3: «просроченное» пишется с class=open).
  ['orbis/when=overdue', ['T2', 'T4']],
  ['orbis/when=overdue, class=orbis/completable:open', ['T2']],
  ['orbis/when=next_7d', ['E1', 'E2', 'T1', 'T3', 'T7', 'T9', 'T10', 'T11a']],
  ['orbis/when=2026-07-17', ['E1', 'T10']],
  ['orbis/when=2026-07-16..2026-07-18', ['E1', 'T1', 'T7', 'T9', 'T10']],
  ['orbis/when<2026-07-15', ['T2', 'T4', 'T8']],
  ['orbis/when<=2026-07-15', ['E2', 'T2', 'T3', 'T4', 'T8', 'T11a']],
  ['orbis/when>2026-07-22', ['T8']],
  ['orbis/when>=2026-07-18', ['T1', 'T8', 'T9', 'T10']],
  // Два сравнения — не интервал: у T8 07-14 ≤ 22 и 08-14 ≥ 15.
  [
    'orbis/when>=2026-07-15, orbis/when<=2026-07-22',
    ['E1', 'E2', 'T1', 'T3', 'T7', 'T8', 'T9', 'T10', 'T11a'],
  ],
  // Запись без дат проходит отрицание.
  ['!orbis/when=next_7d', ['T2', 'T4', 'T5', 'T6', 'T8', 'T11b', 'N1', 'F1']],
  ['orbis/when!=next_7d', ['T2', 'T4', 'T5', 'T6', 'T8', 'T11b', 'N1', 'F1']],
  // «Начал вчера, срок через месяц» — ровно в «Дальше».
  ['orbis/when>2026-07-22, !orbis/when=2026-07-15..2026-07-22', ['T8']],
  // Адрес слота — сырые значения: правило значения не действует.
  ['orbis/when.deadline=next_7d', ['T1', 'T4', 'T5', 'T7', 'T9']],
  // T11a — привязка аспекта владельца, дата-факт.
  ['orbis/when.done=today', ['T3', 'T11a']],
  ['orbis/when.moment=2026-07-19', ['T10']],
  // Две привязки одного слота — хоть одна; строка одна.
  ['orbis/when.moment=2026-07-17', ['E1', 'T10']],
  ['orbis/money-movement.amount>1000', ['F1']],
];

describe('С1в-1: значение «когда» и адреса слотов — таблица случаев', () => {
  test.each(SET_CASES)('%s', async (text, expected) => {
    const got = await names(text);
    // Строка одна на запись, даже при двух привязках слота (§С8-21) — дублей нет.
    expect(got.length).toBe(new Set(got).size);
    expect(sorted(got)).toEqual(sorted(expected));
  });

  test('дерево `in` по значению: хоть одна дата в списке дней', async () => {
    const got = await names({
      filter: { prop: { contract: 'orbis/when' }, op: 'in', value: ['2026-07-16', '2026-07-18'] },
    });
    expect(sorted(got)).toEqual(sorted(['T1', 'T7', 'T9']));
  });

  test('два сравнения + sortBy: T8 первым — ключ «хоть одному» (07-14)', async () => {
    const got = await names(
      'orbis/when>=2026-07-15, orbis/when<=2026-07-22, sortBy=orbis/when:asc',
    );
    expect(got[0]).toBe('T8');
    expect(sorted(got)).toEqual(sorted(['E1', 'E2', 'T1', 'T3', 'T7', 'T8', 'T9', 'T10', 'T11a']));
  });

  test('ключ — ранняя из дат, удовлетворяющих условию: T8 с ключом 08-14 в конце', async () => {
    const got = await names('orbis/when>=2026-07-16, sortBy=orbis/when:asc');
    // E1 и T10 — равные ключи (07-17 09:00): порядок между ними добивает `id` задачи 3.
    expect(got.slice(0, 2)).toEqual(['T7', 'T9']);
    expect(sorted(got.slice(2, 4))).toEqual(['E1', 'T10']);
    expect(got.slice(4)).toEqual(['T1', 'T8']);
  });

  test('next_7d по ключу: разные ключи идут по возрастанию', async () => {
    const got = await names('orbis/when=next_7d, sortBy=orbis/when:asc');
    // Равные ключи (E2/T11a — 07-15 00:00, E1/T10 — 07-17 09:00) — группой, в любом порядке.
    const groups: WhenName[][] = [['E2', 'T11a'], ['T3'], ['T7'], ['T9'], ['E1', 'T10'], ['T1']];
    let at = 0;
    for (const g of groups) {
      expect(sorted(got.slice(at, at + g.length))).toEqual(sorted(g));
      at += g.length;
    }
    expect(at).toBe(got.length);
  });

  test('ключ >2026-07-22: T8 с ключом 08-14 — ранняя из дат, удовлетворяющих условию', async () => {
    expect(await names('orbis/when>2026-07-22, sortBy=orbis/when:asc')).toEqual(['T8']);
    // Ключ T8 — полночь срока 08-14 в поясе владельца, а не момент 07-14 (он условию не отвечает).
    const c = await ctx();
    const ast = parse('orbis/when>2026-07-22', c);
    const key = addressSortKey({ contract: 'orbis/when' }, ast.filter ? [ast.filter] : [], c);
    const rows = await withIdentity(db, personal(graph), (tx) =>
      tx.execute(sql`SELECT ${key} AS key FROM entities e WHERE e.id = ${world.ids.T8}`),
    );
    const got = new Date(String((rows[0] as { key: unknown }).key)).toISOString();
    expect(got).toBe(new Date('2026-08-14T00:00:00+07:00').toISOString());
  });

  test('без условий: записи без дат — в конце', async () => {
    const got = await names('sortBy=orbis/when:asc, limit=50');
    const dateless = new Set<WhenName>(['T5', 'T6', 'T11b', 'N1', 'F1']);
    const firstDateless = got.findIndex((n) => dateless.has(n));
    expect(firstDateless).toBeGreaterThan(0);
    expect(got.slice(firstDateless).every((n) => dateless.has(n))).toBe(true);
    expect(got.slice(firstDateless).length).toBe(dateless.size);
  });

  test('сумма по адресу слота на плитке: 1500 числом (валюты — задача 3)', async () => {
    const c = await ctx();
    const ast = parse(
      'aspect=orbis/financial, display=tile, aggregate=sum:orbis/money-movement.amount',
      c,
    );
    if (ast.aggregate === undefined || ast.aggregate.fn !== 'sum') throw new Error('агрегат');
    const field = ast.aggregate.field;
    const rows = await withIdentity(db, personal(graph), (tx) =>
      tx.execute(compileSumAst(ast, field, c)),
    );
    expect(Number((rows[0] as { sum: string }).sum)).toBe(1500);
  });

  test('выключенные Финансы: адрес слота работает (§3.1, спека 1б §8.3)', async () => {
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.transaction((tx) => setExtensionDisabled(tx, graph, 'finance', true));
      expect(await names('orbis/money-movement.amount>1000')).toEqual(['F1']);
    } finally {
      await admin.transaction((tx) => setExtensionDisabled(tx, graph, 'finance', false));
      await adminClient.end();
    }
  });
});

describe('С1в-1: правило значения на записи', () => {
  test('(а) T7: done → planned снимает время закрытия, запись возвращается на свои даты', async () => {
    const [row] = await withIdentity(db, personal(graph), (tx) =>
      tx.select({ props: entities.props }).from(entities).where(eq(entities.id, world.ids.T7)),
    );
    const props = (row?.props ?? {}) as Record<string, unknown>;
    expect(props['orbis/task_status']).toBe('planned');
    expect(props['orbis/completed_at']).toBeUndefined();
    expect(await names('orbis/when=2026-07-16')).toContain('T7');
    expect(await names('orbis/when.done=next_7d')).not.toContain('T7');
  });

  test('(б) T5 отменена: дат нет — ни в одной положительной форме, отрицание проходит', async () => {
    for (const text of [
      'orbis/when=today',
      'orbis/when=overdue',
      'orbis/when=next_7d',
      'orbis/when=after_7d',
      'orbis/when<2026-12-31',
      'orbis/when>2000-01-01',
    ]) {
      expect(await names(text), text).not.toContain('T5');
    }
    expect(await names('!orbis/when>2000-01-01')).toContain('T5');
    // Сырой срок у отменённой остаётся адресуемым слотом — правило значения его не трогает.
    expect(await names('orbis/when.deadline=2026-07-16')).toContain('T5');
  });

  test('(б′) закрытое без времени закрытия со сроком ВЧЕРА — не «просрочено» (К-2: хотя бы одна есть)', async () => {
    // Отдельный граф: у записи мира таблицы такой пары нет, а ловит она ровно половину К-2 «и хотя
    // бы одна дата есть» — сырой срок позади, но дат у отменённой нет, и `overdue` обязан быть ложью.
    const other = await freshGraph();
    const made = await execute(db, {
      identity: personal(other),
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_create',
          input: {
            title: 'Отменена, срок вчера',
            tags: [],
            aspects: ['orbis/task'],
            props: { 'orbis/task_status': 'cancelled', 'orbis/due_date': '2026-07-14' },
          },
        },
      ],
    });
    if (!made.ok) throw new Error(`запись: ${made.error.code} ${made.error.message}`);
    const reg = await withIdentity(db, personal(other), (tx) => effectiveRegistry(tx, other));
    const c: CompileCtx = {
      graphId: other,
      today: TODAY,
      timeZone: TIME_ZONE,
      weekStart: 'monday',
      reg,
    };
    const rows = await withIdentity(db, personal(other), (tx) =>
      tx.execute(compileQueryAst(parse('orbis/when=overdue', c), c)),
    );
    expect([...rows]).toHaveLength(0);
    // Сырой срок при этом позади — адрес слота его видит.
    const raw = await withIdentity(db, personal(other), (tx) =>
      tx.execute(compileQueryAst(parse('orbis/when.deadline=overdue', c), c)),
    );
    expect([...raw]).toHaveLength(1);
  });

  test('(в) неизвестный слот в entity.query — VALIDATION, reason UNKNOWN_SLOT', async () => {
    const caller = createCallerFactory(appRouter)({
      identity: personal(graph),
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    let cause: unknown = null;
    try {
      await caller.entity.query({ query: 'orbis/when.nope=today' });
    } catch (e) {
      cause = (e as { cause?: unknown }).cause;
    }
    expect(cause).toMatchObject({ reason: 'UNKNOWN_SLOT' });
  });
});

describe('С1в-1 (г): окно материализации от адреса «когда»', () => {
  test('шаблон недели назад — экземпляр этой недели создан и в ответе блока; done — окна нет', async () => {
    const owner = await freshGraph();
    const today = todayInTimeZone(DEFAULT_TIMEZONE);
    const lastWeek = new Date(`${today}T00:00:00Z`);
    lastWeek.setUTCDate(lastWeek.getUTCDate() - 7);
    const start = `${lastWeek.toISOString().slice(0, 10)}T09:00:00+03:00`;
    const created = await execute(db, {
      identity: personal(owner),
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_create',
          input: {
            title: 'Еженедельная встреча',
            tags: [],
            aspects: ['orbis/schedule'],
            props: {
              'orbis/start_at': start,
              'orbis/timezone': DEFAULT_TIMEZONE,
              'orbis/recurrence': { freq: 'weekly', interval: 1 },
            },
          },
        },
      ],
    });
    if (!created.ok) throw new Error(`шаблон: ${created.error.code} ${created.error.message}`);
    const templateId = (created.results[0] as { id: string }).id;
    const caller = createCallerFactory(appRouter)({
      identity: personal(owner),
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    const count = async () =>
      (
        await withIdentity(db, personal(owner), (tx) =>
          tx.select({ id: entities.id }).from(entities).where(eq(entities.graphId, owner)),
        )
      ).length;

    // `completed_at` не триггер правила материализации: блок по `done` окна не открывает.
    const done = await caller.entity.blocks({
      blocks: [{ key: 'done', text: 'orbis/when.done=today' }],
    });
    expect(done.results.done?.ok).toBe(true);
    expect(await count()).toBe(1);

    const { results } = await caller.entity.blocks({
      blocks: [{ key: 'week', text: 'orbis/when=next_7d, !class=orbis/recurrence:templates' }],
    });
    const week = results.week;
    if (week === undefined || !week.ok || week.kind !== 'rows') throw new Error('блок недели');
    const instance = week.rows.find((r) => r.id !== templateId);
    expect(instance).toBeDefined();
    expect(String(instance?.props['orbis/start_at'])).toContain(today);
    expect(week.rows.some((r) => r.id === templateId)).toBe(false);
  });
});

describe('С1в-1 (д): ранг привязок у слота не-даты (РП-21)', () => {
  const dialect = new PgDialect();
  const TWIN = 'user/amount-twin';
  const TWIN_AMOUNT = 'user/tw_amount';
  const financial = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/financial');
  if (financial === undefined) throw new Error('нет orbis/financial');

  /** Реестр с двойником «движения денег»: объявлен ПЕРВЫМ в словаре, ранг — параметр. */
  function reg(twinRank: number): RegistrySnapshot {
    const twin: AspectDefinition = aspectDefinitionSchema.parse({
      id: TWIN,
      graphId: null,
      key: TWIN,
      label: { ru: 'Двойник суммы' },
      description: { ru: 'Второй аспект, привязавший слот amount' },
      properties: [{ propertyId: TWIN_AMOUNT, required: false, rank: 1 }],
      implements: [{ contract: 'orbis/money-movement', bind: { amount: TWIN_AMOUNT } }],
      aiInstructions: null,
      tagMappings: [],
      viewConfig: { keyFields: [] },
      module: null,
      service: false,
      rank: twinRank,
    });
    const twinAmount = propertyDefinitionSchema.parse({
      id: TWIN_AMOUNT,
      graphId: null,
      key: TWIN_AMOUNT,
      label: { ru: 'Сумма двойника' },
      description: { ru: 'Сумма двойника' },
      type: { kind: 'decimal' },
      status: 'active',
      module: null,
      rank: 999,
    });
    return {
      properties: new Map([...BUILTIN_PROPERTY_META, twinAmount].map((p) => [p.id, p])),
      aspects: new Map([twin, ...BUILTIN_ASPECT_DEFS].map((a) => [a.id, a])),
      roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
      contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
      subscriptions: new Map(),
      actions: new Map(),
      ownerVersion: 0,
      systemVersion: 1,
    } as RegistrySnapshot;
  }
  const cctx = (twinRank: number): CompileCtx => ({
    graphId: parseGraphId('00000000-0000-7000-8000-0000000000a1'),
    today: TODAY,
    timeZone: TIME_ZONE,
    weekStart: 'monday',
    reg: reg(twinRank),
  });
  const order = (text: string) => {
    const a = text.indexOf(`'${TWIN}'`);
    const b = text.indexOf(`'orbis/financial'`);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
    return a < b ? 'twin-first' : 'financial-first';
  };
  const addr = { contract: 'orbis/money-movement', slot: 'amount' };

  test('COALESCE ключа и строки значений — в порядке ранга аспектов, не объявления', () => {
    // Двойник объявлен ПЕРВЫМ, но ранг у него старше — первым идёт `orbis/financial`.
    const late = cctx(financial.rank + 100);
    expect(order(dialect.sqlToQuery(addressSortKey(addr, [], late)).sql)).toBe('financial-first');
    const lateValues = slotValuesSql(addr, late);
    if (lateValues === null) throw new Error('нет привязок');
    expect(order(dialect.sqlToQuery(lateValues).sql)).toBe('financial-first');
    // Ранг младше — первым двойник.
    const early = cctx(financial.rank - 100);
    expect(order(dialect.sqlToQuery(addressSortKey(addr, [], early)).sql)).toBe('twin-first');
  });
});
