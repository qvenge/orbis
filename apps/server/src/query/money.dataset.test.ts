// apps/server/src/query/money.dataset.test.ts
// СУММА ПО ВАЛЮТАМ И «ПОСЛЕДНЕЕ» (спека 1в §3.6, §3.7; РП-7; С1в-7, С1в-11 «сумма по валютам»).
//
// Свойство ДЕНЕЖНОЕ, если аспект, стоящий на записи, привязал его к слоту `amount` «движения денег»;
// валюта записи — слот `currency` той же привязки, нет значения — валюта владельца. Сумма считается
// по валютам раздельно — у плитки страницы (`entity.blocks`) и у `user_query` агента; прогресс цели
// считает одним числом (В-5, `goals/progress.test.ts`). «Последнее» — первая строка в порядке
// `sortBy` блока, без `sortBy` — последняя правка; денежное — с валютой.
//
// Мир — настоящая база под идентичностью владельца: записи заводит исполнитель, аспекты владельца —
// декларацией (`seedCustomAspect`), Финансы включены явно (РП-36). Валюта владельца — `RUB` из
// настроек (последний тест меняет её и смотрит, что сумма идёт за ней).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BlockResult, GraphId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { enableFinanceForTest } from '../../test/finance-on';
import {
  adminDb,
  appDb,
  freshGraph,
  personal,
  requireEnv,
  seedCustomAspect,
} from '../../test/helpers';
import { execute } from '../executor/executor';
import { appRouter } from '../router';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

afterAll(async () => {
  await client.end();
});

const opt = (key: string, ru: string, rank: number) => ({ key, label: { ru }, rank });

let graph: GraphId;
const ids: Record<string, string> = {};

/** Валюта владельца в его настройках — под админом (строки настроек у свежего графа нет). */
async function setOwnerCurrency(currency: string): Promise<void> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    await admin.execute(
      sql`INSERT INTO user_settings (graph_id, "defaultCurrency") VALUES (${graph}, ${currency})
          ON CONFLICT (graph_id) DO UPDATE SET "defaultCurrency" = ${currency}`,
    );
  } finally {
    await adminClient.end();
  }
}

function callerFor(g: GraphId) {
  return createCaller({ identity: personal(g), actorKind: 'owner', db, clientVersion: null });
}

async function run(tool: string, input: Record<string, unknown>): Promise<string> {
  const r = await execute(db, {
    identity: personal(graph),
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool, input }],
  });
  if (!r.ok) throw new Error(`мир «деньги» ${tool}: ${r.error.code} — ${r.error.message}`);
  return (r.results[0] as { id: string }).id;
}

beforeAll(async () => {
  graph = await freshGraph();
  await enableFinanceForTest(graph);
  await setOwnerCurrency('RUB');
  // Не денежное число: калории складываются числом, без валюты.
  await seedCustomAspect(graph, {
    key: 'user/cal',
    label: { ru: 'Калории' },
    module: null,
    properties: [{ key: 'kcal', type: { kind: 'decimal' } }],
  });
  // Свой аспект владельца, реализующий «движение денег» всеми обязательными слотами и валютой.
  await seedCustomAspect(graph, {
    key: 'user/pay',
    label: { ru: 'Платёж' },
    module: null,
    properties: [
      { key: 'pay_sum', type: { kind: 'decimal' } },
      {
        key: 'pay_dir',
        type: { kind: 'select', options: [opt('out', 'Расход', 1), opt('in', 'Доход', 2)] },
      },
      { key: 'pay_cat', type: { kind: 'ref' } },
      { key: 'pay_date', type: { kind: 'date' } },
      { key: 'pay_cur', type: { kind: 'text' } },
    ],
    implements: [
      {
        contract: 'orbis/money-movement',
        bind: {
          amount: 'user/pay_sum',
          direction: 'user/pay_dir',
          category: 'user/pay_cat',
          date: 'user/pay_date',
          currency: 'user/pay_cur',
        },
        value_map: [
          { slot: 'direction', variant: 'out', class: 'outflow' },
          { slot: 'direction', variant: 'in', class: 'inflow' },
        ],
        fixed: {},
      },
    ],
  });

  const category = await run('entity_create', {
    title: 'Категория денег',
    tags: [],
    aspects: ['orbis/category'],
    props: {},
  });
  const money = (title: string, amount: string, occurredOn: string, currency?: string) =>
    run('entity_create', {
      title,
      tags: ['money'],
      aspects: ['orbis/financial'],
      props: {
        'orbis/amount': amount,
        'orbis/direction': 'expense',
        'orbis/finance_category': category,
        'orbis/occurred_on': occurredOn,
        ...(currency === undefined ? {} : { 'orbis/currency': currency }),
      },
    });
  // Даты и порядок заведения разведены: последняя по дате — M2, последняя правка — M1 (ниже).
  ids.M1 = await money('M1 без валюты', '12000', '2026-07-01');
  ids.M2 = await money('M2 доллары', '50', '2026-07-04', 'USD');
  ids.M3 = await money('M3 евро', '20', '2026-07-03', 'EUR');
  ids.M4 = await money('M4 тенге', '5', '2026-07-02', 'KZT');
  ids.K1 = await run('entity_create', {
    title: 'K1 калории',
    tags: [],
    aspects: ['user/cal'],
    props: { 'user/kcal': '300' },
  });
  ids.P1 = await run('entity_create', {
    title: 'P1 платёж владельца',
    tags: ['pay'],
    aspects: ['user/pay'],
    props: {
      'user/pay_sum': '700',
      'user/pay_dir': 'out',
      'user/pay_cat': category,
      'user/pay_date': '2026-07-02',
      'user/pay_cur': 'USD',
    },
  });
  // То же свойство суммы, но аспекта-привязки на записи нет: число, не деньги (привязка не стоит).
  ids.P2 = await run('entity_create', {
    title: 'P2 сумма без аспекта',
    tags: ['pay'],
    aspects: [],
    props: { 'user/pay_sum': '100' },
  });
  // Последняя правка — M1: «последнее» без sortBy берёт её, с sortBy — первую строку порядка.
  await run('entity_update', { id: ids.M1, title: 'M1 без валюты (уточнено)' });
});

/** Одна плитка через `entity.blocks` — как её спрашивает страница. */
async function tile(text: string): Promise<BlockResult> {
  const { results } = await callerFor(graph).entity.blocks({ blocks: [{ key: 't', text }] });
  return results.t as BlockResult;
}

function ctxFor(): ToolCallCtx {
  return {
    db,
    identity: personal(graph),
    actorKind: 'ai',
    source: 'chat',
    explicitCommand: false,
    clock: () => new Date('2026-07-04T10:00:00.000Z'),
  };
}

describe('сумма по валютам (спека 1в §3.6)', () => {
  test('плитка «движения денег»: валюта владельца первой, прочие по алфавиту; запись без валюты — в валюте владельца', async () => {
    expect(await tile('aspect=orbis/financial, display=tile, aggregate=sum:orbis/amount')).toEqual({
      ok: true,
      kind: 'sum',
      count: 4,
      sums: [
        { currency: 'RUB', sum: '12000', count: 1 },
        { currency: 'EUR', sum: '20', count: 1 },
        { currency: 'KZT', sum: '5', count: 1 },
        { currency: 'USD', sum: '50', count: 1 },
      ],
    });
  });

  test('не денежное свойство (калории) — одна сумма без валюты', async () => {
    expect(await tile('aspect=user/cal, display=tile, aggregate=sum:user/kcal')).toEqual({
      ok: true,
      kind: 'sum',
      count: 1,
      sums: [{ currency: null, sum: '300', count: 1 }],
    });
  });

  test('денежность — по привязке аспекта НА ЗАПИСИ: то же свойство без аспекта — число без валюты', async () => {
    expect(await tile('tags=pay, display=tile, aggregate=sum:user/pay_sum')).toEqual({
      ok: true,
      kind: 'sum',
      count: 2,
      sums: [
        { currency: 'USD', sum: '700', count: 1 },
        { currency: null, sum: '100', count: 1 },
      ],
    });
  });

  test('адрес слота `orbis/money-movement.amount` — все привязки, валюта каждой своей привязкой', async () => {
    // Выборка — все записи владельца: у категории, калорий и P2 значения слота нет — в суммы они
    // не входят (сумма без значения — не «0 без валюты»), но в общий счёт выборки входят.
    const got = await tile('display=tile, aggregate=sum:orbis/money-movement.amount');
    expect(got).toMatchObject({
      ok: true,
      kind: 'sum',
      sums: [
        { currency: 'RUB', sum: '12000', count: 1 },
        { currency: 'EUR', sum: '20', count: 1 },
        { currency: 'KZT', sum: '5', count: 1 },
        { currency: 'USD', sum: '750', count: 2 },
      ],
    });
  });

  test('пустая выборка — ни одной суммы, счёт 0', async () => {
    expect(
      await tile('aspect=orbis/financial, tags=nothing, display=tile, aggregate=sum:orbis/amount'),
    ).toEqual({ ok: true, kind: 'sum', count: 0, sums: [] });
  });

  test('user_query агента: карточка несёт суммы по валютам, а не одно число', async () => {
    const r = await dispatchTool(ctxFor(), 'user_query', {
      query: 'aspect=orbis/financial',
      aggregate: 'sum',
      field: 'orbis/amount',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const sums = [
      { currency: 'RUB', sum: '12000', count: 1 },
      { currency: 'EUR', sum: '20', count: 1 },
      { currency: 'KZT', sum: '5', count: 1 },
      { currency: 'USD', sum: '50', count: 1 },
    ];
    // Модель видит суммы по валютам — сложить рубли с долларами ей не из чего.
    expect(r.result).toEqual({ sums });
    expect(r.card).toEqual({
      kind: 'query_result',
      count: 4,
      entityIds: [],
      aggregate: { op: 'sum', value: '12000', sums },
    });
  });

  test('user_query над калориями — одна сумма без валюты', async () => {
    const r = await dispatchTool(ctxFor(), 'user_query', {
      query: 'aspect=user/cal',
      aggregate: 'sum',
      field: 'user/kcal',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const sums = [{ currency: null, sum: '300', count: 1 }];
    expect(r.result).toEqual({ sums });
    expect(r.card).toMatchObject({ aggregate: { op: 'sum', value: '300', sums } });
  });
});

describe('«последнее» (спека 1в §3.7)', () => {
  test('с sortBy — первая строка порядка блока (не последняя правка), с валютой', async () => {
    expect(
      await tile(
        'aspect=orbis/financial, display=tile, aggregate=latest:orbis/amount, sortBy=orbis/occurred_on:desc',
      ),
    ).toEqual({ ok: true, kind: 'latest', value: '50', currency: 'USD' });
  });

  test('без sortBy — последняя правка; запись без валюты — валюта владельца', async () => {
    expect(
      await tile('aspect=orbis/financial, display=tile, aggregate=latest:orbis/amount'),
    ).toEqual({ ok: true, kind: 'latest', value: '12000', currency: 'RUB' });
  });

  test('не денежное — без валюты', async () => {
    expect(await tile('aspect=user/cal, display=tile, aggregate=latest:user/kcal')).toEqual({
      ok: true,
      kind: 'latest',
      value: '300',
      currency: null,
    });
  });
});

describe('валюта владельца — из его настроек', () => {
  test('смена валюты владельца переносит записи без валюты и ставит её первой', async () => {
    await setOwnerCurrency('KZT');
    try {
      expect(
        await tile('aspect=orbis/financial, display=tile, aggregate=sum:orbis/amount'),
      ).toEqual({
        ok: true,
        kind: 'sum',
        count: 4,
        sums: [
          { currency: 'KZT', sum: '12005', count: 2 },
          { currency: 'EUR', sum: '20', count: 1 },
          { currency: 'USD', sum: '50', count: 1 },
        ],
      });
    } finally {
      await setOwnerCurrency('RUB');
    }
  });
});
