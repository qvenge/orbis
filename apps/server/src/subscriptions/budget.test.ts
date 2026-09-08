// apps/server/src/subscriptions/budget.test.ts
// Движок ведомостей Budget (§Б5-4) против ОРАКУЛА `computeOverview` (§С8-15, Р-К-5): обе реализации
// считают ОДНУ И ТУ ЖЕ tx, поэтому расхождение здесь — расхождение движков, а не данных.
//
// Мир — КОПИЯ фикстуры `budget/aggregates.test.ts`: её пины и есть ожидания этого файла, а сверка
// «ноль расхождений» имеет смысл только на том мире, на котором оракул уже пропинен. Копия, а не
// импорт: тест-файл импортировать нельзя — его тесты зарегистрировались бы в этом сьюте.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type BudgetOverview,
  type BudgetSubscription,
  bindingIndexOf,
  canonicalJson,
  newId,
  ROLE_INSTANCE_OF,
} from '@orbis/shared';
import type { ExprNode } from '@orbis/shared/expr';
import { eq, type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  appDb,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { budgetOverview, computeOverview, rolloverCreate } from '../budget/aggregates';
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
  budgetAlertCountOf,
  budgetOverviewOf,
  budgetStatusOf,
  categoryTrendOf,
  envelopeForCategoryOf,
  planLedgers,
  propertyDefaultsOf,
} from './budget';
import { builtinSubscription } from './registry';

requireEnv();
const { db, client } = appDb();
const userA = freshUserId();
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
async function exec(user: string, tool: string, input: unknown): Promise<WireEntity> {
  const req: ExecuteRequest = {
    actorUserId: user,
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
  await seedOwnerGraph(db, userA);
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
  // прогонов список был бы пуст у ОБЕИХ реализаций — сверка вышла бы на пустоте.
  await budgetOverview(db, userA, curMonth);
  await budgetOverview(db, userA, curMonth);
  // @ts-expect-error bun-types 1.2.7 не объявляет второй аргумент beforeAll — таймаут
}, 120_000);

afterAll(async () => {
  await client.end();
});

/** Снимок + разобранная декларация + контекст компиляции — один вход на все тесты сьюта. */
async function engineOn<T>(
  user: string,
  fn: (a: {
    tx: Tx;
    reg: RegistrySnapshot;
    def: BudgetSubscription;
    cctx: CompileCtx;
  }) => Promise<T>,
): Promise<T> {
  return withIdentity(db, user, async (tx) => {
    const reg = await effectiveRegistry(tx, user);
    const def = builtinSubscription(reg, BUDGET_SUBSCRIPTION_ID) as BudgetSubscription;
    return fn({
      tx,
      reg,
      def,
      cctx: { ownerId: user, today, timeZone: DEFAULT_TIMEZONE, reg, thisEntityId: null },
    });
  });
}
const overviewOf = (user: string, month: string) =>
  engineOn(user, ({ tx, reg, def }) => budgetOverviewOf(tx, user, { month, today }, def, reg));

describe('двухфазный план §Б5-3', () => {
  test('фаза 1 отдаёт ровно те конверты, что видит оракул', async () => {
    await engineOn(userA, async ({ tx, def, cctx }) => {
      const plan = planLedgers(def, cctx, {
        month: curMonth,
        today,
        defaultCurrency: 'RUB',
        defaults: propertyDefaultsOf(cctx.reg),
      });
      const rows = (await tx.execute(plan.sources.envelopeIds)) as unknown as Array<{ id: string }>;
      const oracle = await computeOverview(tx, userA, curMonth, today);
      expect(rows.map((r) => r.id).sort()).toEqual(
        oracle.envelopes.map((e) => e.envelope.id).sort(),
      );
    });
  });

  test('ведомость spent ограничена `= ANY($ids)`, конверт другого конца — из entities, не из CTE', async () => {
    await engineOn(userA, async ({ def, cctx }) => {
      const plan = planLedgers(def, cctx, {
        month: curMonth,
        today,
        defaultCurrency: 'RUB',
        defaults: propertyDefaultsOf(cctx.reg),
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

describe('ведомость spent (§2.2, П2 №1)', () => {
  test('совпадает с оракулом по каждому конверту на одной tx', async () => {
    await engineOn(userA, async ({ tx, reg, def }) => {
      const oracle = await computeOverview(tx, userA, curMonth, today);
      const mine = await budgetOverviewOf(tx, userA, { month: curMonth, today }, def, reg);
      for (const st of oracle.envelopes) {
        expect([st.envelope.id, envById(mine, st.envelope.id).spent]).toEqual([
          st.envelope.id,
          st.spent,
        ]);
      }
    });
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
    const user = freshUserId();
    await seedOwnerGraph(db, user);
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

  test('порядок карточек = deref(category).title → period_start → id, поэлементно как у оракула', async () => {
    await engineOn(userA, async ({ tx, reg, def }) => {
      const oracle = await computeOverview(tx, userA, curMonth, today);
      const mine = await budgetOverviewOf(tx, userA, { month: curMonth, today }, def, reg);
      expect(mine.envelopes.map((e) => e.envelope.id)).toEqual(
        oracle.envelopes.map((e) => e.envelope.id),
      );
    });
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
        (await tx.execute(sql`SELECT e.id, e.props FROM entities e WHERE e.owner_id = ${userA}
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

describe('списки и сверка с оракулом', () => {
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

  test('НОЛЬ РАСХОЖДЕНИЙ: budgetOverviewOf ≡ computeOverview на одной tx', async () => {
    for (const month of [curMonth, nextMonth, '2026-05', '2026-03']) {
      await engineOn(userA, async ({ tx, reg, def }) => {
        const oracle = await computeOverview(tx, userA, month, today);
        const mine = await budgetOverviewOf(tx, userA, { month, today }, def, reg);
        expect([month, canonicalJson(mine)]).toEqual([month, canonicalJson(oracle)]);
      });
    }
  });

  test('мутационная проверка: warn_at "0.99" дельтой владельца МЕНЯЕТ alertCount', async () => {
    // Сверка «оба дают одно и то же» тавтологична, пока не показано, что ответ ЗАВИСИТ от
    // декларации: подвинь порог — и движок обязан разойтись с оракулом, у которого порог в коде.
    const def = await engineOn(userA, async ({ def: d }) => d);
    const tighter = { ...def, alerts: { ...def.alerts, warn_at: '0.99' } };
    try {
      await withIdentity(db, userA, (tx) =>
        setSubscriptionDelta(tx, userA, BUDGET_SUBSCRIPTION_ID, { definition: tighter }),
      );
      // Жильё 900/1000 = 90 % из бейджа выпадает, развлечения 150/100 = 150 % остаются.
      expect((await overviewOf(userA, curMonth)).alertCount).toBe(1);
    } finally {
      // Дельта живёт у ВЛАДЕЛЬЦА и пережила бы этот тест, сдвинув все следующие.
      await withIdentity(db, userA, (tx) =>
        removeSubscriptionDelta(tx, userA, BUDGET_SUBSCRIPTION_ID),
      );
    }
    expect((await overviewOf(userA, curMonth)).alertCount).toBe(2);
  });
});

describe('четыре читателя движка помимо карточки', () => {
  test('alertCount движка = alertCount оракула на всех четырёх месяцах фикстуры', async () => {
    for (const month of [curMonth, nextMonth, '2026-05', '2026-03']) {
      await engineOn(userA, async ({ tx, reg, def }) => {
        const oracle = await computeOverview(tx, userA, month, today);
        expect([month, await budgetAlertCountOf(tx, userA, { month, today }, def, reg)]).toEqual([
          month,
          oracle.alertCount,
        ]);
      });
    }
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

describe('rollover: параметры перехода — из декларации (Р12)', () => {
  test('exact_calendar_month даёт границы месяца; чужой carry — структурный отказ', async () => {
    const user = freshUserId();
    await seedOwnerGraph(db, user);
    const cat = seedCategoryId(user, 'food');
    const r = await rolloverCreate(db, user, {
      month: nextMonth,
      batchId: newId(),
      rows: [{ categoryId: cat, limit: '1000.00', carryover: '10.00' }],
    });
    const rows = await withIdentity(db, user, (tx) =>
      tx
        .select()
        .from(entities)
        .where(eq(entities.id, r.envelopeIds[0] as string)),
    );
    const props = rows[0]?.props as Record<string, unknown>;
    expect(props['orbis/period_start']).toBe(`${nextMonth}-01`); // exact_calendar_month
    expect(props['orbis/period_end']).toBe(lastDayOf(nextMonth));

    // Дельта владельца называет НЕВЫРАЗИМЫЙ параметр переноса. Правило обязано отказать, а не
    // перенести «как раньше»: тихая деградация здесь стоит владельцу денег на счёте.
    const def = await engineOn(user, async ({ def: d }) => d);
    await withIdentity(db, user, (tx) =>
      setSubscriptionDelta(tx, user, BUDGET_SUBSCRIPTION_ID, {
        definition: { ...def, rollover: { ...def.rollover, carry: { agg: 'spent' } } },
      }),
    );
    try {
      const err = (await rolloverCreate(db, user, {
        month: shiftMonth(nextMonth, 1),
        batchId: newId(),
        rows: [{ categoryId: cat, limit: '1000.00', carryover: '0.00' }],
      }).catch((e) => e)) as ExecError;
      expect([err.code, (err.details as { reason?: string }).reason]).toEqual([
        'VALIDATION',
        'ROLLOVER_CARRY_UNSUPPORTED',
      ]);
    } finally {
      await withIdentity(db, user, (tx) =>
        removeSubscriptionDelta(tx, user, BUDGET_SUBSCRIPTION_ID),
      );
    }
  });
});
