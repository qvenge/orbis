// apps/server/src/subscriptions/budget.test.ts
// Движок ведомостей Budget (§Б5-4): пины величин, порядка, фаз и порога на живой фикстуре плюс
// мутационные проверки «ответ зависит от декларации, а не от кода». Второй реализации Overview нет с
// Б-2 (Р-32): «ноль расхождений» §С8-15 держит снимок вывода движка (`budget-golden.test.ts`, свой мир
// с прибитым «сегодня»), а этот сьют — пины литералами.
//
// Мир — КОПИЯ фикстуры `budget/aggregates.test.ts`: её пины и есть ожидания этого файла. Копия, а не
// импорт: тест-файл импортировать нельзя — его тесты зарегистрировались бы в этом сьюте.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import {
  type BudgetOverview,
  type BudgetSubscription,
  bindingIndexOf,
  newId,
  ROLE_ENVELOPE_BINDING,
  ROLE_INSTANCE_OF,
  RULE_ENVELOPE_UNIQUE,
  RULE_ROLLOVER,
} from '@orbis/shared';
import type { ExprNode } from '@orbis/shared/expr';
import { eq, type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  appDb,
  executeWithFixtureCategories as execute,
  freshGraph,
  mintGraph,
  personal,
  requireEnv,
  seedCustomAspect,
  truncateAll,
  withRule,
} from '../../test/helpers';
import { budgetOverview, rolloverCreate } from '../budget/aggregates';
import { bindingFor, budgetContourOf } from '../budget/contour';
import { entities } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import type { ExecError } from '../errors';
import type { ExecuteRequest, WireEntity } from '../executor/types';
import { compileContractPredicate } from '../expr/compile';
import { type ExprEvalScope, evalExpr } from '../expr/eval';
import type { CompileCtx } from '../query/compile-ast';
import { DEFAULT_TIMEZONE } from '../query/context';
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import { removeSubscriptionDelta, setSubscriptionDelta } from '../registry/ops';
import { seedCategoryId, seedOwnerGraph } from '../seed/onboarding';
import {
  BUDGET_SUBSCRIPTION_ID,
  bindingForEntity,
  budgetAlertCountOf,
  budgetOverviewOf,
  budgetStatusOf,
  categoryTrendOf,
  envelopeForCategoryOf,
  planLedgers,
  propertyDefaultsOf,
} from './budget';
import { assertSubscription, builtinSubscription } from './registry';

requireEnv();
const { db, client } = appDb();
const userA = mintGraph();
const TZ = 'Europe/Moscow';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

// Календарные хелперы и `paceOf` — ДОСЛОВНО из `aggregates.test.ts` (независимая от `decimal.ts`
// и `shared/date.ts` проверка: тест обязан считать дни и делить своим способом, иначе он проверял
// бы реализацию ею же).
function addDaysISO(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}
function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function daysInclusive(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1;
}
function paceOf(remaining: string, days: number): string {
  const cents = BigInt(remaining.replace('.', ''));
  const den = BigInt(days);
  let q = cents / den;
  if ((cents % den) * 2n >= den) q += 1n;
  const s = q.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

const curMonth = today.slice(0, 7);
const cmStart = `${curMonth}-01`;
const cmEnd = lastDayOf(curMonth);
const nextMonth = shiftMonth(curMonth, 1);

/** Фикстура через исполнитель. `mechanism: 'seed'` (§А4-4): сид кладёт ГОТОВОЕ состояние, в том
 *  числе перенесённый остаток `orbis/carryover`, который в проде пишет правило rollover. */
async function exec(user: GraphId, tool: string, input: unknown): Promise<WireEntity> {
  const req: ExecuteRequest = {
    identity: personal(user),
    actorKind: 'owner',
    source: 'ui',
    mechanism: 'seed',
    operations: [{ tool, input }],
  };
  const r = await execute(db, req);
  if (!r.ok) throw new Error(`${tool}: ${r.error.code} — ${r.error.message}`);
  return r.results[0] as WireEntity;
}

const envelope = (
  categoryRef: string,
  periodStart: string,
  periodEnd: string,
  limit: string,
  over: Record<string, unknown> = {},
) => ({
  title: `Конверт ${categoryRef.slice(0, 8)} ${periodStart}`,
  tags: [],
  aspects: ['orbis/budget'],
  props: {
    'orbis/finance_category': categoryRef,
    'orbis/limit': limit,
    'orbis/period_start': periodStart,
    'orbis/period_end': periodEnd,
    ...over,
  },
});
const txn = (
  categoryRef: string,
  amount: string,
  occurredOn: string,
  over: Record<string, unknown> = {},
) => ({
  title: `Транзакция ${amount}`,
  tags: [],
  aspects: ['orbis/financial'],
  props: {
    'orbis/amount': amount,
    'orbis/direction': 'expense',
    'orbis/finance_category': categoryRef,
    'orbis/occurred_on': occurredOn,
    ...over,
  },
});

function envById(ov: BudgetOverview, id: string) {
  const st = ov.envelopes.find((e) => e.envelope.id === id);
  if (!st) throw new Error(`конверт ${id} не найден в overview`);
  return st;
}

const catFood = seedCategoryId(userA, 'food');
const catTransport = seedCategoryId(userA, 'transport');
const catHousing = seedCategoryId(userA, 'housing');
const catEnt = seedCategoryId(userA, 'entertainment');
const catEdu = seedCategoryId(userA, 'education');
const catSalary = seedCategoryId(userA, 'salary');
const catSubs = seedCategoryId(userA, 'subscriptions');
let catParent = '';
let catChild = '';
let envFood = '';
let envUsd = '';
let envHousing = '';
let envEnt = '';
let envParent = '';
let envChild = '';
let envChildUsd = '';
let envNext = '';
let envMay = '';
let envBoundary = '';
let plannedTxnId = '';

beforeAll(async () => {
  await truncateAll();
  await seedOwnerGraph(db, personal(userA));
  catParent = (
    await exec(userA, 'entity_create', {
      title: 'Хобби',
      tags: [],
      aspects: ['orbis/category'],
      props: { 'orbis/icon': '🎨', 'orbis/spend_class': 'discretionary' },
    })
  ).id;
  catChild = (
    await exec(userA, 'entity_create', {
      title: 'Хобби — кино',
      tags: [],
      aspects: ['orbis/category'],
      props: { 'orbis/icon': '🎬', 'orbis/spend_class': 'discretionary' },
    })
  ).id;
  await exec(userA, 'relation_create', {
    source_id: catParent,
    target_id: catChild,
    role: 'category-parent',
  });
  // Конверты — ДО транзакций: авто-привязку (ребро `envelope-binding`) ставит хук при создании траты.
  envFood = (
    await exec(
      userA,
      'entity_create',
      envelope(catFood, cmStart, cmEnd, '30000.00', { 'orbis/carryover': '1200.00' }),
    )
  ).id;
  envUsd = (
    await exec(
      userA,
      'entity_create',
      envelope(catFood, cmStart, cmEnd, '1000.00', { 'orbis/currency': 'USD' }),
    )
  ).id;
  envHousing = (await exec(userA, 'entity_create', envelope(catHousing, cmStart, cmEnd, '1000.00')))
    .id;
  envEnt = (await exec(userA, 'entity_create', envelope(catEnt, cmStart, cmEnd, '100.00'))).id;
  envParent = (await exec(userA, 'entity_create', envelope(catParent, cmStart, cmEnd, '10000.00')))
    .id;
  envChild = (await exec(userA, 'entity_create', envelope(catChild, cmStart, cmEnd, '5000.00'))).id;
  envChildUsd = (
    await exec(
      userA,
      'entity_create',
      envelope(catChild, cmStart, cmEnd, '500.00', { 'orbis/currency': 'USD' }),
    )
  ).id;
  envNext = (
    await exec(
      userA,
      'entity_create',
      envelope(catTransport, `${nextMonth}-01`, lastDayOf(nextMonth), '5000.00'),
    )
  ).id;
  envMay = (
    await exec(userA, 'entity_create', envelope(catEdu, '2026-05-01', '2026-05-31', '1000.00'))
  ).id;
  envBoundary = (
    await exec(userA, 'entity_create', envelope(catEdu, '2026-03-01', '2026-03-31', '10000.00'))
  ).id;

  await exec(userA, 'entity_create', txn(catFood, '340.00', today));
  await exec(userA, 'entity_create', txn(catFood, '2340.00', cmStart));
  plannedTxnId = (
    await exec(
      userA,
      'entity_create',
      txn(catFood, '8000.00', addDaysISO(today, 3), { 'orbis/planned': true }),
    )
  ).id;
  await exec(userA, 'entity_create', txn(catFood, '500.00', today, { 'orbis/currency': 'USD' }));
  await exec(
    userA,
    'entity_create',
    txn(catSalary, '165000.00', today, { 'orbis/direction': 'income' }),
  );
  await exec(userA, 'entity_create', txn(catTransport, '3200.00', today)); // unbudgeted
  await exec(userA, 'entity_create', txn(catHousing, '900.00', today)); // 90% лимита → alert
  await exec(userA, 'entity_create', txn(catEnt, '150.00', today)); // перерасход
  await exec(userA, 'entity_create', txn(catChild, '1000.00', today));
  await exec(userA, 'entity_create', txn(catChild, '100.00', today, { 'orbis/currency': 'USD' }));
  await exec(userA, 'entity_create', txn(catEdu, '340.00', '2026-05-31'));
  await exec(userA, 'entity_create', txn(catEdu, '8500.00', '2026-03-15')); // ровно 85% envBoundary
  await exec(userA, 'entity_create', {
    title: 'Netflix',
    tags: [],
    aspects: ['orbis/schedule', 'orbis/financial'],
    props: {
      'orbis/start_at': `${addDaysISO(today, 1)}T12:00:00+03:00`,
      'orbis/timezone': TZ,
      'orbis/recurrence': { freq: 'weekly', interval: 1 },
      'orbis/amount': '599.00',
      'orbis/direction': 'expense',
      'orbis/finance_category': catSubs,
      'orbis/recurring': true,
    },
  });
  // Конвейер §2.8 (postDue + материализация окна) движку НЕ принадлежит — он живёт в обёртке
  // (§Б5-4 про ведомости, не про материализацию). Инстансы Coming up кладёт он, и без этих двух
  // прогонов список был бы пуст, и пины списков проверяли бы пустоту.
  await budgetOverview(db, personal(userA), curMonth);
  await budgetOverview(db, personal(userA), curMonth);
  // @ts-expect-error bun-types 1.2.7 не объявляет второй аргумент beforeAll — таймаут
}, 120_000);

afterAll(async () => {
  await client.end();
});

/** Снимок + разобранная декларация + контекст компиляции — один вход на все тесты сьюта. */
async function engineOn<T>(
  user: GraphId,
  fn: (a: {
    tx: Tx;
    reg: RegistrySnapshot;
    def: BudgetSubscription;
    cctx: CompileCtx;
  }) => Promise<T>,
): Promise<T> {
  return withIdentity(db, personal(user), async (tx) => {
    const reg = await effectiveRegistry(tx, user);
    const def = builtinSubscription(reg, BUDGET_SUBSCRIPTION_ID) as BudgetSubscription;
    return fn({
      tx,
      reg,
      def,
      cctx: { graphId: user, today, timeZone: DEFAULT_TIMEZONE, reg, thisEntityId: null },
    });
  });
}
const overviewOf = (user: GraphId, month: string) =>
  engineOn(user, ({ tx, reg, def }) => budgetOverviewOf(tx, user, { month, today }, def, reg));

describe('двухфазный план §Б5-3', () => {
  test('фаза 1 отдаёт ровно те конверты, что попадают в карточку', async () => {
    // Тест про ФАЗУ 1 плана §Б5-3 (селектор источника): её id и есть множество карточек Overview,
    // и расхождение значило бы, что фаза 2 считает не те конверты, которые владелец видит.
    await engineOn(userA, async ({ tx, reg, def, cctx }) => {
      const plan = planLedgers(def, cctx, {
        month: curMonth,
        today,
        defaultCurrency: 'RUB',
        defaults: propertyDefaultsOf(cctx.reg),
        timeZone: cctx.timeZone,
      });
      const rows = (await tx.execute(plan.sources.envelopeIds)) as unknown as Array<{ id: string }>;
      const mine = await budgetOverviewOf(tx, userA, { month: curMonth, today }, def, reg);
      expect(rows.map((r) => r.id).sort()).toEqual(mine.envelopes.map((e) => e.envelope.id).sort());
      // Сторож: сверка идёт по конвертам месяца, а не по пустоте.
      expect(rows.length).toBe(7);
    });
  });

  test('ведомость spent ограничена `= ANY($ids)`, конверт другого конца — из entities, не из CTE', async () => {
    await engineOn(userA, async ({ def, cctx }) => {
      const plan = planLedgers(def, cctx, {
        month: curMonth,
        today,
        defaultCurrency: 'RUB',
        defaults: propertyDefaultsOf(cctx.reg),
        timeZone: cctx.timeZone,
      });
      // Текст ГОТОВОГО фрагмента — тем же диалектом, что и golden компилятора Q
      // (`query/compile-ast.test.ts`): своя склейка `queryChunks` показывала бы не тот SQL,
      // который уедет в Postgres.
      const text = new PgDialect().sqlToQuery(plan.aggregates.get('spent') as SQL).sql;
      expect(text).toContain('= ANY(');
      expect(text).toContain('JOIN entities env');
      // CTE набора без статистики дал бы вложенный цикл на 458k пар (П2 §10.3) — плана «WITH» тут нет.
      expect(text).not.toContain('WITH ');
    });
  });
});

/**
 * ОБЛАСТЬ `where` У ВЕДОМОСТИ И СПИСКА (находка B3 I-1). Валидатор записи типизирует `where` в
 * области КОНТРАКТА движения (`subscriptions/registry.ts`, `budgetSites`), а движок компилировал
 * тот же `where` БЕЗ привязки — и `{slot}`/`{has:<слот>}`, принятые на записи, отказывали
 * `EXPR_SHAPE` на ЧТЕНИИ (пять читателей Budget) и на ЗАПИСИ траты (хук `spentContributionOf`).
 * Расхождение истины в двух местах одного языка: отказ приходил не автору декларации (Р-И-7).
 */
describe('область `where` ведомости и списка (B3 I-1)', () => {
  const OUTFLOW_NODE: ExprNode = {
    op: 'in',
    args: [{ class: { contract: 'orbis/money-movement' } }, { const: 'outflow' }],
  };
  /** `and(outflow, amount > "500")` — слот контракта движения прямо в предикате ведомости. */
  const BIG_OUTFLOW: ExprNode = {
    op: 'and',
    args: [OUTFLOW_NODE, { op: '>', args: [{ slot: 'amount' }, { const: '500' }] }],
  };
  const spentWhere = (def: BudgetSubscription, where: ExprNode): BudgetSubscription =>
    ({
      ...def,
      aggregates: { ...def.aggregates, spent: { ...def.aggregates.spent, where } },
    }) as BudgetSubscription;
  const listWhere = (def: BudgetSubscription, where: ExprNode): BudgetSubscription =>
    ({
      ...def,
      lists: { ...def.lists, planned: { ...def.lists.planned, where } },
    }) as BudgetSubscription;
  const rowOf = (definition: BudgetSubscription) => ({
    id: BUDGET_SUBSCRIPTION_ID,
    graphId: userA,
    surface: 'finance/budget-overview',
    definition,
    module: 'finance',
    rank: 20,
  });

  test('валидатор принял {slot}/{has} в where — движок обязан скомпилировать', async () => {
    await engineOn(userA, async ({ tx, reg, def, cctx }) => {
      const hasAmount: ExprNode = { op: 'and', args: [OUTFLOW_NODE, { has: 'amount' }] };
      for (const where of [BIG_OUTFLOW, hasAmount]) {
        const withSlot = spentWhere(def, where);
        // Ступень 1 — валидатор записи ПРИНИМАЕТ (иначе отказ пришёл бы автору дельты).
        expect(() =>
          assertSubscription(rowOf(withSlot), { reg: cctx.reg, systemSeed: false }),
        ).not.toThrow();
        // Ступень 2 — тот же `where` обязан скомпилироваться движком.
        const text = new PgDialect().sqlToQuery(
          planLedgers(withSlot, cctx, {
            month: curMonth,
            today,
            defaultCurrency: 'RUB',
            defaults: propertyDefaultsOf(cctx.reg),
            timeZone: cctx.timeZone,
          }).aggregates.get('spent') as SQL,
        ).sql;
        expect(text).toContain("'orbis/amount'"); // слот дошёл до SQL, а не отказал
      }
      // Тот же язык у списка (`runList`, `budget.ts:1279`) — через боевого читателя.
      const withList = listWhere(def, { op: 'and', args: [OUTFLOW_NODE, { has: 'amount' }] });
      expect(() =>
        assertSubscription(rowOf(withList), { reg: cctx.reg, systemSeed: false }),
      ).not.toThrow();
      const ov = await budgetOverviewOf(tx, userA, { month: curMonth, today }, withList, reg);
      expect(ov.planned.map((r) => r.entity.id)).toContain(plannedTxnId);
    });
  });

  test('семантический пин: and(outflow, amount > "500") считает только крупные траты', async () => {
    // Ведомость СЧИТАЕТСЯ, а не читается из кэша: `spent` материализуема, и через `budgetOverviewOf`
    // сужение не наблюдалось бы вовсе. Пин нужен затем, что «скомпилировалось» ≠ «значит»: предикат,
    // скомпилированный и НЕ положенный в `where[]`, дал бы тот же текст SQL.
    await engineOn(userA, async ({ tx, def, cctx }) => {
      const args = {
        month: curMonth,
        today,
        defaultCurrency: 'RUB',
        defaults: propertyDefaultsOf(cctx.reg),
        timeZone: cctx.timeZone,
      };
      const ids = (
        (await tx.execute(planLedgers(def, cctx, args).sources.envelopeIds)) as unknown as Array<{
          id: string;
        }>
      ).map((r) => r.id);
      const spentOf = async (d: BudgetSubscription) =>
        (
          (await tx.execute(
            planLedgers(d, cctx, args, ids).aggregates.get('spent') as SQL,
          )) as unknown as Array<{ key: string; total: string }>
        ).find((r) => r.key === envFood)?.total;
      // Норматив даёт 2680 = 340 + 2340; сужение обязано отсечь 340 и оставить 2340.
      expect([await spentOf(def), await spentOf(spentWhere(def, BIG_OUTFLOW))]).toEqual([
        '2680.00',
        '2340.00',
      ]);
    });
  });

  test('живая дельта со слотом в where: entity_create траты не падает (хук кэша, :625)', async () => {
    const user = await freshGraph();
    await seedOwnerGraph(db, personal(user));
    const cat = seedCategoryId(user, 'food');
    const env = await exec(user, 'entity_create', envelope(cat, cmStart, cmEnd, '10000.00'));
    const def = await withIdentity(db, personal(user), async (tx) =>
      builtinSubscription(await effectiveRegistry(tx, user), BUDGET_SUBSCRIPTION_ID),
    );
    await withIdentity(db, personal(user), (tx) =>
      setSubscriptionDelta(tx, user, BUDGET_SUBSCRIPTION_ID, {
        definition: spentWhere(def as BudgetSubscription, BIG_OUTFLOW),
      }),
    );
    try {
      // Хук `applySpentCacheEffect` идёт БЕЗ try/catch внутри транзакции: отказ компиляции здесь
      // валит саму запись траты, а не только кэш.
      await exec(user, 'entity_create', txn(cat, '340.00', today));
      await exec(user, 'entity_create', txn(cat, '2340.00', today));
      const ov = await withIdentity(db, personal(user), async (tx) => {
        const reg = await effectiveRegistry(tx, user);
        return budgetOverviewOf(
          tx,
          user,
          { month: curMonth, today },
          builtinSubscription(reg, BUDGET_SUBSCRIPTION_ID) as BudgetSubscription,
          reg,
        );
      });
      expect(envById(ov, env.id).spent).toBe('2340.00');
    } finally {
      await withIdentity(db, personal(user), (tx) =>
        removeSubscriptionDelta(tx, user, BUDGET_SUBSCRIPTION_ID),
      );
    }
  });
});

describe('ведомость spent (§2.2, П2 №1)', () => {
  test('пин ведомости по каждому конверту месяца литералом (карточка — после rollup §2.10)', async () => {
    // Был сверкой двух реализаций; стал пином ведомости: значения посчитаны по фикстуре руками.
    const mine = await overviewOf(userA, curMonth);
    expect(new Map(mine.envelopes.map((e) => [e.envelope.id, e.spent]))).toEqual(
      new Map([
        [envFood, '2680.00'], // 340 + 2340
        [envUsd, '500.00'],
        [envHousing, '900.00'],
        [envEnt, '150.00'],
        [envParent, '1000.00'], // свой 0 + дочерний RUB 1000
        [envChild, '1000.00'],
        [envChildUsd, '100.00'],
      ]),
    );
  });

  test('доход в spent не входит (класс outflow); чужая валюта — тоже (same_as_envelope)', async () => {
    const mine = await overviewOf(userA, curMonth);
    // 340 + 2340; planned 8000, USD 500, доход 165000 и трата категории без конверта
    // (транспорт) в spent конверта еды НЕ входят.
    expect(envById(mine, envFood).spent).toBe('2680.00');
    // У USD-конверта своя валютная граница (§5) — он видит ровно USD-трату.
    expect(envById(mine, envUsd).spent).toBe('500.00');
    expect(envById(mine, envHousing).spent).toBe('900.00');
  });

  test('проведённый recurring-инстанс входит в spent один раз, шаблон — ни разу', async () => {
    // `orbis/recurring = true` стоит и на шаблоне, и на инстансе. Считай движок `recurring`
    // маркером шаблона — набор `facts` выбросил бы инстанс, и владелец перестал бы видеть
    // половину своих расходов; считай он шаблон операцией — увидел бы двойной.
    const user = await freshGraph();
    await seedOwnerGraph(db, personal(user));
    const cat = newId();
    const env = await exec(user, 'entity_create', envelope(cat, cmStart, cmEnd, '10000.00'));
    const tpl = await exec(user, 'entity_create', {
      title: 'Шаблон',
      tags: [],
      aspects: ['orbis/schedule', 'orbis/financial'],
      props: {
        'orbis/start_at': `${today}T12:00:00+03:00`,
        'orbis/timezone': TZ,
        'orbis/recurrence': { freq: 'monthly', interval: 1 },
        'orbis/amount': '700.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': cat,
        'orbis/occurred_on': today,
        'orbis/recurring': true,
      },
    });
    const inst = await exec(user, 'entity_create', txn(cat, '700.00', today));
    // Ребро порождения ставит сервер (`created_by: 'system'`) — фикстурный `exec` идёт
    // механизмом `seed` и гейт `ROLE_SYSTEM_ONLY` проходит. Ребро — ДО пометки `recurring`:
    // инвариант §3.3 пускает её только на шаблоне со своим `orbis/recurrence` либо на
    // инстансе с ВХОДЯЩИМ ребром порождения.
    await exec(user, 'relation_create', {
      source_id: tpl.id,
      target_id: inst.id,
      role: ROLE_INSTANCE_OF,
    });
    await exec(user, 'entity_update', { id: inst.id, props: { 'orbis/recurring': true } });
    const ov = await overviewOf(user, curMonth);
    expect(envById(ov, env.id).spent).toBe('700.00'); // не '1400.00' и не '0.00'
  });
});

describe('формулы E и фазы (§2.4, §2.9)', () => {
  test('effective_limit = limit + carryover; remaining = effective_limit − spent', async () => {
    const food = envById(await overviewOf(userA, curMonth), envFood);
    expect(food.effectiveLimit).toBe('31200.00'); // 30000 + carryover 1200
    expect(food.remaining).toBe('28520.00'); // 31200 − 2680
    expect(food.phase).toBe('active');
  });

  test('dailyPace = remaining / days_inclusive(today, period_end), 2 знака', async () => {
    const mine = await overviewOf(userA, curMonth);
    expect(envById(mine, envFood).dailyPace).toBe(paceOf('28520.00', daysInclusive(today, cmEnd)));
  });

  test('remaining < 0 → null; upcoming → null; closed → null и БЕЗ деления на ноль', async () => {
    const cur = await overviewOf(userA, curMonth);
    expect(envById(cur, envEnt).remaining).toBe('-50.00'); // 100 лимита, 150 траты
    expect(envById(cur, envEnt).dailyPace).toBeNull();
    const next = await overviewOf(userA, nextMonth);
    expect(envById(next, envNext).spent).toBe('0.00');
    expect(envById(next, envNext).dailyPace).toBeNull();
    // `days_inclusive(today, '2026-05-31')` = 0 (from > to → 0), и жадное плечо `if` дало бы
    // RangeError вместо «—/день». Ленивое не считает его вовсе.
    const may = await overviewOf(userA, '2026-05');
    expect(envById(may, envMay).dailyPace).toBeNull();
  });

  test('фазы вычисляются в объявленном порядке, `active` — остаток', async () => {
    const cur = await overviewOf(userA, curMonth);
    const next = await overviewOf(userA, nextMonth);
    const may = await overviewOf(userA, '2026-05');
    expect([
      envById(next, envNext).phase,
      envById(may, envMay).phase,
      envById(cur, envFood).phase,
    ]).toEqual(['upcoming', 'closed', 'active']);
  });
});

describe('rollup дерева, порядок карточек, алерты', () => {
  test('родительская категория агрегирует потомков только своей валюты', async () => {
    const mine = await overviewOf(userA, curMonth);
    expect(envById(mine, envChild).spent).toBe('1000.00');
    expect(envById(mine, envChild).effectiveLimit).toBe('5000.00');
    // Родитель: свой конверт (0 из 10000) + дочерний RUB (1000 из 5000)
    expect(envById(mine, envParent).spent).toBe('1000.00'); // не '1100.00'
    expect(envById(mine, envParent).effectiveLimit).toBe('15000.00'); // не '15500.00'
    expect(envById(mine, envParent).remaining).toBe('14000.00');
    // USD-конверт ребёнка живёт своей карточкой и в RUB-родителя не втекает (§5)
    expect(envById(mine, envChildUsd).spent).toBe('100.00');
  });

  test('порядок карточек = deref(category).title → period_start → id поэлементно (ключ `order_by`)', async () => {
    // Пин КЛЮЧА, а не второй реализации: ровно та формула, что стоит в декларации (§Б5-4).
    const mine = await overviewOf(userA, curMonth);
    const keyOf = (e: BudgetOverview['envelopes'][number]) =>
      [
        e.category.title,
        String((e.envelope.props as Record<string, unknown>)['orbis/period_start']),
        e.envelope.id,
      ].join('\u0000');
    const sorted = [...mine.envelopes].sort((a, b) =>
      keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0,
    );
    expect(mine.envelopes.map((e) => e.envelope.id)).toEqual(sorted.map((e) => e.envelope.id));
    // Сторож третьей части ключа: у RUB- и USD-конверта «Еды» заголовок и начало периода общие,
    // и порядок между ними решает `id` — без такой пары пин не видел бы потерю хвоста ключа.
    expect(mine.envelopes.filter((e) => e.category.title === 'Еда')).toHaveLength(2);
  });

  test('warn_at 0.85 ВКЛЮЧИТЕЛЬНО: конверт ровно 85 % в бейдже', async () => {
    // Изолированный месяц 2026-03: 8500 из 10000. При строгом `>` конверт выпал бы из бейджа,
    // хотя карточка уже ⚠ (§3.1) — коллизия решена владельцем 2026-07-23 в пользу «≥ везде».
    const march = await overviewOf(userA, '2026-03');
    expect(envById(march, envBoundary).spent).toBe('8500.00');
    expect(march.alertCount).toBe(1);
  });

  test('порог на СЫРЫХ значениях (on_raw), фаза upcoming пропускается', async () => {
    // Жильё 900/1000 = 90 % (⚠) и развлечения 150/100 = 150 % (🔴). Карточка родителя после
    // rollup — 1000/15000 = 6,7 %, и в бейдж она не идёт: порог считает СЫРЫЕ значения конверта.
    expect((await overviewOf(userA, curMonth)).alertCount).toBe(2);
    expect((await overviewOf(userA, '2026-05')).alertCount).toBe(0); // 340/1000 = 34 %
    expect((await overviewOf(userA, nextMonth)).alertCount).toBe(0); // envNext — фаза upcoming
  });
});

describe('умолчания реестра в интерпретаторе E (Р-К-29, §Б3-4)', () => {
  test('`planned = false` считает движение БЕЗ свойства тратой в обоих бэкендах — по одной карте умолчаний', async () => {
    await engineOn(userA, async ({ tx, reg, cctx }) => {
      const defaults = propertyDefaultsOf(reg);
      expect(defaults.get('orbis/planned')).toBe(false); // единственный род `default` сегодня — boolean
      const notPlanned: ExprNode = { op: '=', args: [{ slot: 'planned' }, { const: false }] };
      // SQL-бэкенд: умолчание подставляет `castedExpr` — движение без `orbis/planned` В выдаче.
      const e = sql.raw('e');
      const idsOf = async (expr: ExprNode) =>
        (await tx.execute(sql`SELECT e.id, e.props FROM entities e WHERE e.graph_id = ${userA}
          AND ${compileContractPredicate('orbis/money-movement', expr, cctx, e)}`)) as unknown as Array<{
          id: string;
          props: Record<string, unknown>;
        }>;
      const bySql = (await idsOf(notPlanned)).map((r) => r.id);
      expect(bySql.length).toBeGreaterThan(0);
      expect(bySql).not.toContain(plannedTxnId);
      // Интерпретатор с ТОЙ ЖЕ картой — тот же вердикт по каждой строке. Сравниваются вердикты
      // ОДНОГО И ТОГО ЖЕ множества-кандидата (члены контракта денег): членство §Б2-3 — вопрос
      // второго рода, и подмешивать его сюда значило бы проверять не умолчания.
      const all = await idsOf({ const: true });
      const binding = bindingIndexOf(reg)
        .byAspect('orbis/financial')
        .find((b) => b.contract === 'orbis/money-movement');
      const scopeOf = (props: Record<string, unknown>, withDefaults: boolean): ExprEvalScope => ({
        params: {},
        aggs: {},
        phase: null,
        props,
        binding,
        today,
        defaults: withDefaults ? defaults : undefined,
      });
      expect(
        new Set(
          all.filter((r) => evalExpr(notPlanned, scopeOf(r.props, true)) === true).map((r) => r.id),
        ),
      ).toEqual(new Set(bySql));
      // Без карты интерпретатор отвечал бы «нет» на каждом движении без свойства (§Б3-4 без
      // умолчаний) — это и есть расхождение, которое закрывает `LedgerArgs.defaults`.
      expect(
        all.filter((r) => evalExpr(notPlanned, scopeOf(r.props, false)) === true),
      ).toHaveLength(0);
    });
  });
});

describe('списки (§Б5-4) и мутационная проверка порога', () => {
  test('coming_up — инстансы (ребро instance-of, side target) окна [today; horizon_end]', async () => {
    const mine = await overviewOf(userA, curMonth);
    // Еженедельный Netflix с завтра: два инстанса попадают в горизонт 14 дней, третий — нет.
    expect(mine.comingUp.map((c) => c.occurredOn)).toEqual([
      addDaysISO(today, 1),
      addDaysISO(today, 8),
    ]);
    for (const c of mine.comingUp) {
      expect(c.amount).toBe('599.00');
      expect(c.direction).toBe('expense');
    }
  });

  test('planned — ручные покупки без ребра instance-of, расходы, не шаблоны', async () => {
    const mine = await overviewOf(userA, curMonth);
    expect(mine.planned).toHaveLength(1);
    expect(mine.planned[0]?.entity.id).toBe(plannedTxnId);
    expect(mine.planned[0]?.amount).toBe('8000.00');
    expect(mine.planned[0]?.categoryTitle).toBe('Еда');
    // Дискриминатор `instance-of`: множества не пересекаются (списки строит одна декларация,
    // и «ребро есть» / «ребра нет» — её же конструкция, а не два разных запроса в коде).
    const coming = new Set(mine.comingUp.map((c) => c.entity.id));
    expect(mine.planned.some((p) => coming.has(p.entity.id))).toBe(false);
  });

  test('мутационная проверка: warn_at "0.99" дельтой владельца МЕНЯЕТ alertCount', async () => {
    // Снимок (`budget-golden.test.ts`) доказывает «движок равен себе вчерашнему», но не то, что ответ
    // ЗАВИСИТ от декларации: подвинь порог — и бейдж обязан измениться, потому что порог в декларации.
    const def = await engineOn(userA, async ({ def: d }) => d);
    const tighter = { ...def, alerts: { ...def.alerts, warn_at: '0.99' } };
    try {
      await withIdentity(db, personal(userA), (tx) =>
        setSubscriptionDelta(tx, userA, BUDGET_SUBSCRIPTION_ID, { definition: tighter }),
      );
      // Жильё 900/1000 = 90 % из бейджа выпадает, развлечения 150/100 = 150 % остаются.
      expect((await overviewOf(userA, curMonth)).alertCount).toBe(1);
    } finally {
      // Дельта живёт у ВЛАДЕЛЬЦА и пережила бы этот тест, сдвинув все следующие.
      await withIdentity(db, personal(userA), (tx) =>
        removeSubscriptionDelta(tx, userA, BUDGET_SUBSCRIPTION_ID),
      );
    }
    expect((await overviewOf(userA, curMonth)).alertCount).toBe(2);
  });
});

describe('четыре читателя движка помимо карточки', () => {
  test('бейдж (`budgetAlertCountOf`) = alertCount карточки на всех четырёх месяцах фикстуры', async () => {
    // Два читателя одного порога идут РАЗНЫМИ сужениями `runLedgers` (бейдж — без ведомостей периода
    // и дерева, Ф-Б1-39), и расхождение бейджа с карточкой владелец видит как враньё интерфейса
    // (§6.1 vs §3.1). Литералы порога — в тестах «warn_at 0.85» и «on_raw» выше.
    const counts: Array<[string, number, number]> = [];
    for (const month of [curMonth, nextMonth, '2026-05', '2026-03']) {
      await engineOn(userA, async ({ tx, reg, def }) => {
        const card = await budgetOverviewOf(tx, userA, { month, today }, def, reg);
        counts.push([
          month,
          await budgetAlertCountOf(tx, userA, { month, today }, def, reg),
          card.alertCount,
        ]);
      });
    }
    expect(counts.map(([m, badge]) => [m, badge])).toEqual(counts.map(([m, , card]) => [m, card]));
    // Сторож: хотя бы один месяц с ненулевым бейджем — иначе равенство выполнялось бы на нулях.
    expect(counts.some(([, badge]) => badge > 0)).toBe(true);
  });

  test('envelopeForCategory: конверт валюты по умолчанию, значения СЫРЫЕ (без rollup)', async () => {
    await engineOn(userA, async ({ tx, reg, def }) => {
      const st = await envelopeForCategoryOf(
        tx,
        userA,
        { categoryId: catFood, date: today, today },
        def,
        reg,
      );
      expect(st?.envelope.id).toBe(envFood); // не USD-конверт: селектор фильтрует валюту
      expect(st?.spent).toBe('2680.00');
      expect(st?.remaining).toBe('28520.00');
      // Родительская карточка тут НЕ агрегируется: fast-path показывает свой конверт (§4.1)
      const parent = await envelopeForCategoryOf(
        tx,
        userA,
        { categoryId: catParent, date: today, today },
        def,
        reg,
      );
      expect(parent?.spent).toBe('0.00'); // не '1000.00', как в карточке Overview
      const none = await envelopeForCategoryOf(
        tx,
        userA,
        { categoryId: catFood, date: '2019-01-15', today },
        def,
        reg,
      );
      expect(none).toBeNull();
    });
  });

  test('categoryTrend: бакет по месяцу period_start, limit БЕЗ carryover, чужая валюта мимо', async () => {
    await engineOn(userA, async ({ tx, reg, def }) => {
      const points = await categoryTrendOf(
        tx,
        userA,
        { categoryId: catFood, months: 1, today },
        def,
        reg,
      );
      expect(points).toEqual([{ period: curMonth, spent: '2680.00', limit: '30000.00' }]);
    });
  });

  test('budgetStatus: Overview + spend_class всех категорий владельца', async () => {
    await engineOn(userA, async ({ tx, reg, def }) => {
      const status = await budgetStatusOf(tx, userA, { month: curMonth, today }, def, reg);
      const byId = new Map(status.categories.map((c) => [c.id, c]));
      expect(byId.get(catFood)).toEqual({ id: catFood, title: 'Еда', spendClass: 'discretionary' });
      expect(byId.get(catSalary)?.spendClass).toBeNull(); // доходная категория — без класса
    });
  });
});

describe('«живой конверт» §Б5-4 №5: alive: true (Important-1 гейта)', () => {
  /**
   * Мир: конверт с привязанной тратой, конверт архивирован, ребро привязки НА МЕСТЕ.
   *
   * Ребро возвращается руками намеренно. Бюджет-хук на архивации конверта привязку снимает
   * (`rebindForEnvelope`: у архивного конверта селектор комбинацию не выбирает), и через один
   * лишь исполнитель состояние «ребро на архивный конверт» недостижимо — ровно поэтому `alive`
   * и оказался незапиненным. Но состояние законно и наблюдаемо: так выглядит граф между записью
   * архивации и хуком, так же выглядят рёбра, приехавшие импортом или починкой данных. §Б5-4 №5
   * называет ответ на него частью ДЕКЛАРАЦИИ, и проверять его нужно на нём.
   */
  async function archivedWithEdge(slug: 'food' | 'transport', amount: string) {
    const user = await freshGraph();
    await seedOwnerGraph(db, personal(user));
    const cat = seedCategoryId(user, slug);
    const env = await exec(user, 'entity_create', envelope(cat, cmStart, cmEnd, '5000.00'));
    const spend = await exec(user, 'entity_create', txn(cat, amount, today));
    const before = await overviewOf(user, curMonth);
    expect(envById(before, env.id).spent).toBe(amount); // привязка встала хуком
    expect(before.unbudgeted).toHaveLength(0);

    await exec(user, 'entity_update', { id: env.id, archived: true });
    await exec(user, 'relation_create', {
      source_id: env.id,
      target_id: spend.id,
      role: ROLE_ENVELOPE_BINDING,
    });
    // Сторож обстановки: без ребра тест выродился бы в «трата без конверта», а он не про это.
    const edges = (await withIdentity(db, personal(user), (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM relations
        WHERE source_id = ${env.id}::uuid AND target_id = ${spend.id}::uuid
          AND role = ${ROLE_ENVELOPE_BINDING}`),
    )) as unknown as Array<{ n: number }>;
    expect(edges[0]?.n).toBe(1);
    return { user, cat, env: env.id };
  }

  test('ребро на АРХИВНЫЙ конверт не прячет трату от Unbudgeted', async () => {
    const { user, cat } = await archivedWithEdge('food', '777.00');
    await engineOn(user, async ({ tx, reg, def }) => {
      const mine = await budgetOverviewOf(tx, user, { month: curMonth, today }, def, reg);
      expect(mine.envelopes).toHaveLength(0); // архивный конверт карточки не даёт
      expect(mine.unbudgeted.map((u) => [u.category.id, u.total])).toEqual([[cat, '777.00']]);
    });
  });

  test('alive: false дельтой владельца ведёт себя ИНАЧЕ — то же ребро трату прячет', async () => {
    // Пин самого условия, а не его следствия: перестань движок читать `alive` — и этот тест
    // сравняет два ответа, которые обязаны различаться.
    const { user } = await archivedWithEdge('transport', '640.00');
    expect((await overviewOf(user, curMonth)).unbudgeted.map((u) => u.total)).toEqual(['640.00']);

    const def = await engineOn(user, async ({ def: d }) => d);
    const unbudgeted = def.aggregates.unbudgeted;
    if (unbudgeted?.kind !== 'sum') throw new Error('в декларации нет ведомости Unbudgeted');
    try {
      await withIdentity(db, personal(user), (tx) =>
        setSubscriptionDelta(tx, user, BUDGET_SUBSCRIPTION_ID, {
          definition: {
            ...def,
            aggregates: { ...def.aggregates, unbudgeted: { ...unbudgeted, alive: false } },
          },
        }),
      );
      // «Не живой» — значит архивность конверта не важна: ребро есть, и трата спрятана.
      expect((await overviewOf(user, curMonth)).unbudgeted).toHaveLength(0);
    } finally {
      await withIdentity(db, personal(user), (tx) =>
        removeSubscriptionDelta(tx, user, BUDGET_SUBSCRIPTION_ID),
      );
    }
    expect((await overviewOf(user, curMonth)).unbudgeted).toHaveLength(1);
  });
});

describe('фазы: остаток последним и взаимоисключаемость (Ф-Б1-37)', () => {
  test('две истинные не-остаточные фазы — отказ с их именами, а не «короткая первой»', async () => {
    // Порядок ключей из jsonb непредсказуем (длина, затем байты), поэтому выбор «первой истинной»
    // означал бы, что смысл декларации зависит от того, как владелец назвал фазу.
    const def = await engineOn(userA, async ({ def: d }) => d);
    const overlap = {
      ...def,
      phases: {
        ...def.phases,
        // Обе истинны на любом конверте текущего месяца: «начался» и «не закончился».
        upcoming: { op: '>=', args: [{ ctx: '$today' }, { slot: 'period_start' }] } as ExprNode,
        closed: { op: '<=', args: [{ ctx: '$today' }, { slot: 'period_end' }] } as ExprNode,
      },
    };
    try {
      await withIdentity(db, personal(userA), (tx) =>
        setSubscriptionDelta(tx, userA, BUDGET_SUBSCRIPTION_ID, { definition: overlap }),
      );
      const err = (await overviewOf(userA, curMonth).catch((e) => e)) as ExecError;
      expect([err.code, (err.details as { reason?: string }).reason]).toEqual([
        'VALIDATION',
        'SUBSCRIPTION_PHASES_OVERLAP',
      ]);
      expect((err.details as { phases?: string[] }).phases).toEqual(['closed', 'upcoming']);
    } finally {
      await withIdentity(db, personal(userA), (tx) =>
        removeSubscriptionDelta(tx, userA, BUDGET_SUBSCRIPTION_ID),
      );
    }
    // Встроенные `upcoming`/`closed` взаимоисключающие — норматив проходит.
    expect((await overviewOf(userA, curMonth)).envelopes.length).toBeGreaterThan(0);
  });
});

describe('семена карточки после rollup (Minor-1 гейта)', () => {
  test('формула читает сумму конверта ВНЕ rollup.applies_to — Overview не падает INVARIANT', async () => {
    // Дельта заводит вторую сумму КОНВЕРТА (без `bound_via`, поэтому числитель порога по-прежнему
    // однозначен — Ф-Б1-38) и формулу над ней. Сей карточка только `applies_to`, эта формула не
    // нашла бы своей суммы у владельца с деревом категорий — и Overview падал бы целиком.
    const def = await engineOn(userA, async ({ def: d }) => d);
    const spent = def.aggregates.spent;
    if (spent?.kind !== 'sum') throw new Error('в декларации нет суммы spent');
    const { bound_via: _drop, ...withoutEdge } = spent;
    const widened = {
      ...def,
      aggregates: {
        ...def.aggregates,
        spent_any: { ...withoutEdge, where: undefined },
        head_room: {
          kind: 'formula' as const,
          scope: 'envelope' as const,
          expr: { op: '-', args: [{ agg: 'effective_limit' }, { agg: 'spent_any' }] } as ExprNode,
        },
      },
    };
    try {
      await withIdentity(db, personal(userA), (tx) =>
        setSubscriptionDelta(tx, userA, BUDGET_SUBSCRIPTION_ID, { definition: widened }),
      );
      // `envParent` — конверт родительской категории: у него есть потомки, значит rollup идёт.
      const ov = await overviewOf(userA, curMonth);
      expect(envById(ov, envParent).effectiveLimit).toBe('15000.00');
    } finally {
      await withIdentity(db, personal(userA), (tx) =>
        removeSubscriptionDelta(tx, userA, BUDGET_SUBSCRIPTION_ID),
      );
    }
  });
});

describe('rollover: параметры перехода — из строки каталога (Р-13)', () => {
  test('exact_calendar_month даёт границы месяца; чужой carry — структурный отказ', async () => {
    const user = await freshGraph();
    await seedOwnerGraph(db, personal(user));
    const cat = seedCategoryId(user, 'food');
    const r = await rolloverCreate(db, personal(user), {
      month: nextMonth,
      batchId: newId(),
      rows: [{ categoryId: cat, limit: '1000.00', carryover: '10.00' }],
    });
    const rows = await withIdentity(db, personal(user), (tx) =>
      tx
        .select()
        .from(entities)
        .where(eq(entities.id, r.envelopeIds[0] as string)),
    );
    const props = rows[0]?.props as Record<string, unknown>;
    expect(props['orbis/period_start']).toBe(`${nextMonth}-01`); // exact_calendar_month
    expect(props['orbis/period_end']).toBe(lastDayOf(nextMonth));

    // Строка каталога называет ВЫРАЗИМУЮ валидатором, но НЕИСПОЛНИМУЮ движком величину (`spent`
    // публикуется аспектом, значит `assertRule` её примет) — движок обязан отказать, а не перенести
    // «как раньше»: тихая деградация здесь стоит владельцу денег на счёте.
    await withRule(
      'orbis/budget',
      [
        RULE_ENVELOPE_UNIQUE,
        { ...RULE_ROLLOVER, params: { source: 'exact_calendar_month', carry: { agg: 'spent' } } },
      ],
      async () => {
        const e = (await rolloverCreate(db, personal(user), {
          month: shiftMonth(nextMonth, 1),
          batchId: newId(),
          rows: [{ categoryId: cat, limit: '1000.00', carryover: '0.00' }],
        }).catch((x) => x)) as ExecError;
        expect([e.code, (e.details as { reason?: string }).reason]).toEqual([
          'VALIDATION',
          'ROLLOVER_CARRY_UNSUPPORTED',
        ]);
      },
    );
  });
});

describe('SLOT_AMBIGUOUS у Budget: без prefer — отказ, с prefer — детерминированный выбор (остаток 40)', () => {
  const TWIN = 'user/second-budget';
  const ON = ['orbis/budget', TWIN];
  /** Второй аспект, реализующий ТОТ ЖЕ контракт конверта: две законные по отдельности привязки. */
  const twoEnvelopeAspects = (base: RegistrySnapshot): RegistrySnapshot => {
    const budget = base.aspects.get('orbis/budget');
    if (budget === undefined) throw new Error('фикстура: аспекта orbis/budget нет в снимке');
    const aspects = new Map(base.aspects);
    aspects.set(TWIN, { ...budget, id: TWIN, key: TWIN, graphId: userA, rank: 900 });
    return { ...base, aspects };
  };
  test('без prefer — отказ с аспектами в details; с prefer — первый совпавший', async () => {
    await engineOn(userA, async ({ cctx, def }) => {
      const two = { ...cctx, reg: twoEnvelopeAspects(cctx.reg) };
      let caught: ExecError | null = null;
      try {
        bindingForEntity(two, 'orbis/envelope', ON, []);
      } catch (e) {
        caught = e as ExecError;
      }
      expect(caught?.code).toBe('SLOT_AMBIGUOUS');
      expect((caught?.details as { aspects?: string[] }).aspects).toEqual(ON);
      expect(bindingForEntity(two, 'orbis/envelope', ON, [TWIN])?.aspectId).toBe(TWIN);
      expect(bindingForEntity(two, 'orbis/envelope', ON, ['orbis/budget'])?.aspectId).toBe(
        'orbis/budget',
      );
      // Перечень из ДВУХ в порядке ПРОТИВ ранга (у TWIN ранг 900): решает порядок перечня, а не
      // ранг среди перечисленных (Ф-Б2-25) — и у движка, и у хука записи.
      const both = [TWIN, 'orbis/budget'];
      expect(bindingForEntity(two, 'orbis/envelope', ON, both)?.aspectId).toBe(TWIN);
      const side = budgetContourOf(
        {
          ...def,
          sources: { ...def.sources, envelope: { ...def.sources.envelope, prefer: both } },
        },
        two.reg,
      ).envelope;
      expect(bindingFor(side, ON)?.aspectId).toBe(TWIN);
      expect(bindingFor({ ...side, prefer: [] }, ON)?.aspectId).toBe('orbis/budget');
      // Аспект из prefer, которого у записи нет, выбора не делает — отказ остаётся.
      expect(() => bindingForEntity(two, 'orbis/envelope', ON, ['orbis/note'])).toThrow();
      // Перечень приезжает из ДЕКЛАРАЦИИ, а не из кода движка (Р-24).
      expect(def.sources.envelope.prefer).toEqual([]);
      expect(def.sources.movement.prefer).toEqual([]);
    });
  });
});

describe('prefer во всех половинах Budget (Ф-Б2-25): список, лимит и spent — из предпочтённого аспекта', () => {
  const TWIN_MV = 'user/twin-money';
  const TWIN_ENV = 'user/twin-envelope';
  /**
   * Двойники встроенных аспектов с РАНГОМ 900 — позже `orbis/financial`/`orbis/budget` в индексе
   * привязок, поэтому перечень, ставящий их первыми, идёт ПРОТИВ ранга. Свои у двойника движения —
   * сумма и КАТЕГОРИЯ: по категории хук выбирает конверт, и разные значения у двух аспектов делают
   * выбор хука наблюдаемым; прочие слоты — те же свойства, что у встроенного.
   */
  const TWIN_MV_ASPECT = {
    key: TWIN_MV,
    label: { ru: 'Двойник движения', en: 'Movement twin' },
    rank: 900,
    properties: [
      { key: 'twin_amount', type: { kind: 'decimal' as const } },
      {
        key: 'twin_category',
        type: { kind: 'ref' as const, target: { filter: { aspect: 'orbis/category' } } },
      },
    ],
    carries: ['orbis/direction', 'orbis/occurred_on', 'orbis/currency', 'orbis/planned'],
    implements: [
      {
        contract: 'orbis/money-movement',
        bind: {
          amount: 'user/twin_amount',
          direction: 'orbis/direction',
          category: 'user/twin_category',
          date: 'orbis/occurred_on',
          currency: 'orbis/currency',
          planned: 'orbis/planned',
        },
        value_map: [
          { slot: 'direction', variant: 'expense', class: 'outflow' },
          { slot: 'direction', variant: 'income', class: 'inflow' },
        ],
      },
    ],
  };
  const TWIN_ENV_ASPECT = {
    key: TWIN_ENV,
    label: { ru: 'Двойник конверта', en: 'Envelope twin' },
    rank: 900,
    properties: [{ key: 'twin_limit', type: { kind: 'decimal' as const } }],
    carries: ['orbis/finance_category', 'orbis/currency', 'orbis/period_start', 'orbis/period_end'],
    implements: [
      {
        contract: 'orbis/envelope',
        bind: {
          category: 'orbis/finance_category',
          limit: 'user/twin_limit',
          currency: 'orbis/currency',
          period_start: 'orbis/period_start',
          period_end: 'orbis/period_end',
        },
      },
    ],
  };
  const both = (over: Record<string, unknown>, amount: string, twinAmount: string) => ({
    title: `Двойная трата ${twinAmount}`,
    tags: [],
    aspects: ['orbis/financial', TWIN_MV],
    props: { 'orbis/amount': amount, 'user/twin_amount': twinAmount, ...over },
  });

  test('без prefer — SLOT_AMBIGUOUS; с prefer против ранга — все величины из одного аспекта', async () => {
    const g = await freshGraph();
    await seedOwnerGraph(db, personal(g));
    await seedCustomAspect(g, TWIN_MV_ASPECT);
    await seedCustomAspect(g, TWIN_ENV_ASPECT);
    const food = seedCategoryId(g, 'food');
    const transport = seedCategoryId(g, 'transport');
    // Конверт-двойник — категории ДВОЙНИКА движения; конверт еды — категории встроенного аспекта.
    const twinEnv = await exec(g, 'entity_create', {
      ...envelope(transport, cmStart, cmEnd, '1000.00', { 'user/twin_limit': '5000.00' }),
      aspects: ['orbis/budget', TWIN_ENV],
    });
    const foodEnv = await exec(g, 'entity_create', envelope(food, cmStart, cmEnd, '2000.00'));

    let caught: ExecError | null = null;
    try {
      await overviewOf(g, curMonth);
    } catch (e) {
      caught = e as ExecError;
    }
    expect(caught?.code).toBe('SLOT_AMBIGUOUS');

    const def = await withIdentity(db, personal(g), async (tx) =>
      builtinSubscription(await effectiveRegistry(tx, g), BUDGET_SUBSCRIPTION_ID),
    );
    const d = def as BudgetSubscription;
    await withIdentity(db, personal(g), (tx) =>
      setSubscriptionDelta(tx, g, BUDGET_SUBSCRIPTION_ID, {
        definition: {
          ...d,
          sources: {
            movement: { ...d.sources.movement, prefer: [TWIN_MV, 'orbis/financial'] },
            envelope: { ...d.sources.envelope, prefer: [TWIN_ENV, 'orbis/budget'] },
          },
        },
      }),
    );
    const common = {
      'orbis/direction': 'expense',
      'orbis/finance_category': food,
      'user/twin_category': transport,
    };
    await exec(
      g,
      'entity_create',
      both({ ...common, 'orbis/occurred_on': today }, '100.00', '700.00'),
    );
    const planned = await exec(
      g,
      'entity_create',
      both({ ...common, 'orbis/occurred_on': today, 'orbis/planned': true }, '50.00', '300.00'),
    );

    const first = await overviewOf(g, curMonth);
    // Лимит — JS-чтение конверта (`bindingForEntity`), spent — SQL-ведомость (`slotExpr`), конверт —
    // выбор хука (`bindingFor`): все три обязаны смотреть в двойника.
    expect(envById(first, twinEnv.id).effectiveLimit).toBe('5000.00');
    expect(envById(first, twinEnv.id).spent).toBe('700.00');
    expect(envById(first, foodEnv.id).spent).toBe('0.00');
    expect(first.planned.find((p) => p.entity.id === planned.id)?.amount).toBe('300.00');

    // Инкремент кэша `spent` новой тратой — третий путь того же слота (`spentContributionOf`).
    await exec(
      g,
      'entity_create',
      both({ ...common, 'orbis/occurred_on': today }, '10.00', '30.00'),
    );
    expect(envById(await overviewOf(g, curMonth), twinEnv.id).spent).toBe('730.00');
  });
});
