// apps/server/src/budget/aggregates.test.ts
// Интеграционные тесты Task A6 (03-budget §2.2/§2.4/§2.5/§2.9/§2.10, §3.1, §5, §7.1):
// агрегаты Budget на лету против живой БД (RLS enforced), без моков. Фикстурный граф
// брифа: категории из сида + кастомная пара родитель/ребёнок, конверты разных фаз и
// валют, транзакции всех видов (факт/planned/чужая валюта/доход/recurring-инстанс/
// unbudgeted). Все даты — ОТНОСИТЕЛЬНО реального «сегодня» (Europe/Moscow — дефолт
// сида §7.3), кроме приёмки §7.1 с фиксированными датами мая/июня 2026.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BudgetOverview, BudgetStatusResult } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { ExecuteRequest, WireEntity } from '../executor/types';
import { appRouter } from '../router';
import { seedCategoryId, seedOnboarding } from '../seed/onboarding';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';
import { budgetOverview, budgetStatus, categoryTrend, envelopeForCategory } from './aggregates';

requireEnv();

const { db, client } = appDb();
const userA = freshUserId();
const userB = freshUserId();

// «Сегодня» — как считает сервер: локальная дата в таймзоне сида (Europe/Moscow §7.3)
const TZ = 'Europe/Moscow';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

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

const curMonth = today.slice(0, 7);
const cmStart = `${curMonth}-01`;
const cmEnd = lastDayOf(curMonth);
const prevMonth = shiftMonth(curMonth, -1);
const nextMonth = shiftMonth(curMonth, 1);

function daysInclusive(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1;
}

/** Независимая (от decimal.ts) проверка деления: центы BigInt, half-away-from-zero. */
function paceOf(remaining: string, days: number): string {
  const cents = BigInt(remaining.replace('.', ''));
  const den = BigInt(days);
  let q = cents / den;
  if ((cents % den) * 2n >= den) q += 1n;
  const s = q.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

// --- сид-категории (02 §7.1) -------------------------------------------------
const catFood = seedCategoryId(userA, 'food'); // discretionary
const catTransport = seedCategoryId(userA, 'transport'); // fixed
const catHousing = seedCategoryId(userA, 'housing'); // fixed
const catHealth = seedCategoryId(userA, 'health'); // fixed
const catSubs = seedCategoryId(userA, 'subscriptions'); // fixed
const catEnt = seedCategoryId(userA, 'entertainment'); // discretionary?
const catEdu = seedCategoryId(userA, 'education');
const catSalary = seedCategoryId(userA, 'salary'); // доходная: без spend_class

// Кастомная пара для иерархии §2.10 (создаётся в beforeAll)
let catParent = '';
let catChild = '';

// Конверты
let envFood = '';
let envUsd = '';
let envHousing = '';
let envEnt = '';
let envParent = '';
let envChild = '';
let envNext = '';
let envMay = '';
let envJune = '';
// Ручная planned-покупка (§2.7) и её id для дизъюнктности planned/comingUp
let plannedTxnId = '';

async function exec(user: string, tool: string, input: unknown): Promise<WireEntity> {
  const req: ExecuteRequest = {
    actorUserId: user,
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool, input }],
  };
  const r = await execute(db, req);
  if (!r.ok) throw new Error(`${tool}: ${r.error.code} — ${r.error.message}`);
  return r.results[0] as WireEntity;
}

function envelope(
  categoryRef: string,
  periodStart: string,
  periodEnd: string,
  limit: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: `Конверт ${categoryRef.slice(0, 8)} ${periodStart}`,
    tags: [],
    aspects: {
      'orbis/budget': {
        category_ref: categoryRef,
        limit,
        period_start: periodStart,
        period_end: periodEnd,
        ...over,
      },
    },
  };
}

function txn(
  categoryRef: string,
  amount: string,
  occurredOn: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: `Транзакция ${amount}`,
    tags: [],
    aspects: {
      'orbis/financial': {
        amount,
        direction: 'expense',
        category_ref: categoryRef,
        occurred_on: occurredOn,
        ...over,
      },
    },
  };
}

function envById(ov: BudgetOverview, id: string) {
  const st = ov.envelopes.find((e) => e.envelope.id === id);
  if (!st) throw new Error(`конверт ${id} не найден в overview`);
  return st;
}

beforeAll(async () => {
  await truncateAll();
  await withIdentity(db, userA, (tx) => seedOnboarding(tx, userA));

  // Иерархия §2.10: родительская категория → дочерняя (relation parent)
  catParent = (
    await exec(userA, 'entity_create', {
      title: 'Хобби',
      tags: [],
      aspects: { 'orbis/category': { icon: '🎨', spend_class: 'discretionary' } },
    })
  ).id;
  catChild = (
    await exec(userA, 'entity_create', {
      title: 'Хобби — кино',
      tags: [],
      aspects: { 'orbis/category': { icon: '🎬', spend_class: 'discretionary' } },
    })
  ).id;
  await exec(userA, 'relation_create', {
    source_id: catParent,
    target_id: catChild,
    relation_type: 'parent',
  });

  // Конверты — ДО транзакций (авто-привязка A4 подхватывает при создании транзакций)
  envFood = (
    await exec(
      userA,
      'entity_create',
      envelope(catFood, cmStart, cmEnd, '30000.00', { carryover: '1200.00' }),
    )
  ).id;
  envUsd = (
    await exec(
      userA,
      'entity_create',
      envelope(catFood, cmStart, cmEnd, '1000.00', { currency: 'USD' }),
    )
  ).id;
  envHousing = (await exec(userA, 'entity_create', envelope(catHousing, cmStart, cmEnd, '1000.00')))
    .id;
  envEnt = (await exec(userA, 'entity_create', envelope(catEnt, cmStart, cmEnd, '100.00'))).id;
  envParent = (await exec(userA, 'entity_create', envelope(catParent, cmStart, cmEnd, '10000.00')))
    .id;
  envChild = (await exec(userA, 'entity_create', envelope(catChild, cmStart, cmEnd, '5000.00'))).id;
  // Конверты здоровья прошлого/текущего месяцев — данные categoryTrend (§3.2)
  await exec(
    userA,
    'entity_create',
    envelope(catHealth, `${prevMonth}-01`, lastDayOf(prevMonth), '2000.00'),
  );
  await exec(userA, 'entity_create', envelope(catHealth, cmStart, cmEnd, '3000.00'));
  envNext = (
    await exec(
      userA,
      'entity_create',
      envelope(catTransport, `${nextMonth}-01`, lastDayOf(nextMonth), '5000.00'),
    )
  ).id;
  // Приёмка §7.1 — фиксированные май/июнь 2026
  envMay = (
    await exec(userA, 'entity_create', envelope(catEdu, '2026-05-01', '2026-05-31', '1000.00'))
  ).id;
  envJune = (
    await exec(userA, 'entity_create', envelope(catEdu, '2026-06-01', '2026-06-30', '1000.00'))
  ).id;

  // Транзакции фикстуры (6+ видов брифа)
  await exec(userA, 'entity_create', txn(catFood, '340.00', today)); // факт
  await exec(userA, 'entity_create', txn(catFood, '2340.00', cmStart)); // факт ранее в месяце
  plannedTxnId = (
    await exec(
      userA,
      'entity_create',
      txn(catFood, '8000.00', addDaysISO(today, 3), { planned: true }),
    )
  ).id; // ручная planned-покупка §2.7
  await exec(userA, 'entity_create', txn(catFood, '500.00', today, { currency: 'USD' })); // чужая валюта §5
  await exec(userA, 'entity_create', txn(catSalary, '165000.00', today, { direction: 'income' })); // доход
  await exec(userA, 'entity_create', txn(catTransport, '3200.00', today)); // unbudgeted (конверта на месяц нет)
  await exec(userA, 'entity_create', txn(catHousing, '900.00', today)); // 90% лимита → alert
  await exec(userA, 'entity_create', txn(catEnt, '150.00', today)); // перерасход remaining<0
  await exec(userA, 'entity_create', txn(catChild, '1000.00', today)); // иерархия §2.10
  await exec(userA, 'entity_create', txn(catEdu, '340.00', '2026-05-31')); // приёмка §7.1: created_at=сейчас
  await exec(userA, 'entity_create', txn(catHealth, '150.00', `${prevMonth}-15`)); // тренд: прошлый месяц
  await exec(userA, 'entity_create', txn(catHealth, '200.00', today)); // тренд: текущий месяц

  // Recurring-шаблон (§2.8): еженедельно с завтра — инстансы только в Coming up
  await exec(userA, 'entity_create', {
    title: 'Netflix',
    tags: [],
    aspects: {
      'orbis/schedule': {
        start_at: `${addDaysISO(today, 1)}T12:00:00+03:00`,
        timezone: TZ,
        recurrence: { freq: 'weekly', interval: 1 },
      },
      'orbis/financial': {
        amount: '599.00',
        direction: 'expense',
        category_ref: catSubs,
        recurring: true,
      },
    },
  });
});

afterAll(async () => {
  await client.end();
});

describe('budget.overview: spent и формулы конверта (§2.2, §2.4)', () => {
  test('spent — только факт-расходы своей валюты до сегодня; carryover входит в effectiveLimit', async () => {
    const ov = await budgetOverview(db, userA, curMonth);
    const food = envById(ov, envFood);
    // 340 + 2340; planned 8000, USD 500, доход и unbudgeted-транспорт — НЕ входят
    expect(food.spent).toBe('2680.00');
    expect(food.effectiveLimit).toBe('31200.00'); // 30000 + carryover 1200
    expect(food.remaining).toBe('28520.00');
    expect(food.phase).toBe('active');
    expect(food.category.title).toBe('Еда');
    expect(food.category.icon).toBe('🍔');
  });

  test('чужая валюта считается СВОИМ конвертом: USD-конверт видит только USD-транзакцию (один batch-SQL, §5)', async () => {
    const ov = await budgetOverview(db, userA, curMonth);
    expect(envById(ov, envUsd).spent).toBe('500.00');
  });

  test('dailyPace: remaining / дней до конца периода включительно, 2 знака (§2.4)', async () => {
    const ov = await budgetOverview(db, userA, curMonth);
    const food = envById(ov, envFood);
    expect(food.dailyPace).toBe(paceOf('28520.00', daysInclusive(today, cmEnd)));
  });

  test('remaining < 0 → dailyPace = null («—/день», §2.4)', async () => {
    const ov = await budgetOverview(db, userA, curMonth);
    const ent = envById(ov, envEnt);
    expect(ent.remaining).toBe('-50.00');
    expect(ent.dailyPace).toBeNull();
    expect(ent.phase).toBe('active');
  });

  test('phase=upcoming (следующий месяц): spent 0, dailyPace null (§2.9а)', async () => {
    const ov = await budgetOverview(db, userA, nextMonth);
    const st = envById(ov, envNext);
    expect(st.phase).toBe('upcoming');
    expect(st.spent).toBe('0.00');
    expect(st.dailyPace).toBeNull();
  });

  test('phase=closed (май 2026): dailyPace null (§2.9б)', async () => {
    const ov = await budgetOverview(db, userA, '2026-05');
    const st = envById(ov, envMay);
    expect(st.phase).toBe('closed');
    expect(st.dailyPace).toBeNull();
  });
});

describe('budget.overview: баланс периода (§2.5) и Unbudgeted (§3.1)', () => {
  test('баланс включает unbudgeted, исключает чужую валюту, planned и другие месяцы', async () => {
    const ov = await budgetOverview(db, userA, curMonth);
    expect(ov.period).toEqual({ start: cmStart, end: cmEnd });
    expect(ov.balance.income).toBe('165000.00');
    // 340+2340 (еда) + 3200 (транспорт unbudgeted) + 900 (жильё) + 150 (развлечения)
    // + 1000 (кино) + 200 (здоровье) = 8130; USD 500 и planned 8000 — исключены
    expect(ov.balance.expense).toBe('8130.00');
    expect(ov.balance.balance).toBe('156870.00');
  });

  test('Unbudgeted: фактические траты категории без конверта, с иконкой (§2.3 шаг 5)', async () => {
    const ov = await budgetOverview(db, userA, curMonth);
    expect(ov.unbudgeted).toEqual([
      { category: { id: catTransport, title: 'Транспорт', icon: '🚕' }, total: '3200.00' },
    ]);
  });
});

describe('budget.overview: Coming up и Planned не пересекаются (§2.7, §2.8)', () => {
  test('comingUp — recurring-инстансы 14 дней (derived_from); planned — ручные покупки', async () => {
    const ov = await budgetOverview(db, userA, curMonth);

    expect(ov.comingUp.map((c) => c.occurredOn)).toEqual([
      addDaysISO(today, 1),
      addDaysISO(today, 8),
    ]);
    for (const c of ov.comingUp) {
      expect(c.amount).toBe('599.00');
      expect(c.direction).toBe('expense');
    }

    expect(ov.planned).toHaveLength(1);
    expect(ov.planned[0]?.entity.id).toBe(plannedTxnId);
    expect(ov.planned[0]?.amount).toBe('8000.00');
    expect(ov.planned[0]?.categoryTitle).toBe('Еда');

    // дискриминатор derived_from: множества не пересекаются
    const comingIds = new Set(ov.comingUp.map((c) => c.entity.id));
    expect(ov.planned.some((p) => comingIds.has(p.entity.id))).toBe(false);
  });

  test('planned-инстансы recurring НЕ входят в spent конверта категории (§2.8)', async () => {
    const ov = await budgetOverview(db, userA, curMonth);
    // у подписок конверта нет вовсе; их инстансы не всплывают и в unbudgeted (planned=true)
    expect(ov.unbudgeted.some((u) => u.category.id === catSubs)).toBe(false);
  });
});

describe('budget.overview: alertCount (§6.1) и иерархия категорий (§2.10)', () => {
  test('alertCount: конверты spent > 85% × effectiveLimit (оранжевые + красные)', async () => {
    const ov = await budgetOverview(db, userA, curMonth);
    // жильё 900/1000 = 90% (⚠) и развлечения 150/100 = 150% (🔴); еда 2680/31200 — нет
    expect(envById(ov, envHousing).spent).toBe('900.00');
    expect(ov.alertCount).toBe(2);
  });

  test('родительская категория агрегирует детей: spent и effectiveLimit суммарные', async () => {
    const ov = await budgetOverview(db, userA, curMonth);
    const parent = envById(ov, envParent);
    const child = envById(ov, envChild);
    expect(child.spent).toBe('1000.00');
    expect(child.effectiveLimit).toBe('5000.00');
    // родитель: свой конверт (0 из 10000) + дочерний (1000 из 5000)
    expect(parent.spent).toBe('1000.00');
    expect(parent.effectiveLimit).toBe('15000.00');
    expect(parent.remaining).toBe('14000.00');
    expect(parent.dailyPace).toBe(paceOf('14000.00', daysInclusive(today, cmEnd)));
  });
});

describe('приёмка §7.1: исторический импорт', () => {
  test('транзакция occurred_on=2026-05-31, созданная сегодня, — в майском конверте и НЕ в июньском', async () => {
    const may = await budgetOverview(db, userA, '2026-05');
    expect(envById(may, envMay).spent).toBe('340.00');

    const june = await budgetOverview(db, userA, '2026-06');
    expect(envById(june, envJune).spent).toBe('0.00');
    // майский конверт июньскому месяцу не принадлежит
    expect(june.envelopes.some((e) => e.envelope.id === envMay)).toBe(false);
  });
});

describe('budget.envelopeForCategory (fast-path «осталось N ₽», §4.1)', () => {
  test('находит конверт категории на дату в валюте по умолчанию', async () => {
    const st = await envelopeForCategory(db, userA, { categoryId: catFood, date: today });
    expect(st?.envelope.id).toBe(envFood); // не USD-конверт: селектор фильтрует валюту
    expect(st?.spent).toBe('2680.00');
    expect(st?.remaining).toBe('28520.00');
  });

  test('нет конверта на дату → null (Unbudgeted)', async () => {
    const st = await envelopeForCategory(db, userA, { categoryId: catFood, date: '2019-01-15' });
    expect(st).toBeNull();
  });
});

describe('budget.categoryTrend (§3.2)', () => {
  test('spent по конвертам прошлых периодов + limit; месяц без конверта — spent 0, limit null', async () => {
    const points = await categoryTrend(db, userA, { categoryId: catHealth, months: 3 });
    expect(points).toEqual([
      { period: shiftMonth(curMonth, -2), spent: '0.00', limit: null },
      { period: prevMonth, spent: '150.00', limit: '2000.00' },
      { period: curMonth, spent: '200.00', limit: '3000.00' },
    ]);
  });
});

describe('tRPC budget.overview: смоук через caller (Шаг 3 брифа)', () => {
  const createCaller = createCallerFactory(appRouter);
  const callerFor = (user: string | null) =>
    createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });

  test('владелец получает Overview; RLS: другой owner видит пустой месяц', async () => {
    const ov = await callerFor(userA).budget.overview({ month: curMonth });
    expect(envById(ov, envFood).spent).toBe('2680.00');
    expect(ov.alertCount).toBe(2);

    const empty = await callerFor(userB).budget.overview({ month: curMonth });
    expect(empty.envelopes).toEqual([]);
    expect(empty.balance).toEqual({ income: '0.00', expense: '0.00', balance: '0.00' });
    expect(empty.unbudgeted).toEqual([]);
  });

  test('без аутентификации → UNAUTHORIZED', async () => {
    await expect(callerFor(null).budget.overview({ month: curMonth })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('тул budget_status (Шаг 4 брифа: §4.3, §4.7)', () => {
  test('dispatch возвращает агрегаты + spend_class категорий; month по умолчанию — текущий', async () => {
    const r = await dispatchTool(
      { db, actorUserId: userA, actorKind: 'ai', source: 'chat', explicitCommand: false },
      'budget_status',
      {},
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    const status = r.result as BudgetStatusResult;
    expect(status.period).toEqual({ start: cmStart, end: cmEnd });
    expect(status.envelopes.find((e) => e.envelope.id === envFood)?.spent).toBe('2680.00');
    // spend_class: расходная классифицированная, доходная без класса → null (§4.3)
    const byId = new Map(status.categories.map((c) => [c.id, c]));
    expect(byId.get(catFood)).toEqual({ id: catFood, title: 'Еда', spendClass: 'discretionary' });
    expect(byId.get(catSalary)?.spendClass).toBeNull();
  });

  test('явный month уважается; невалидный input → VALIDATION', async () => {
    const r = await dispatchTool(
      { db, actorUserId: userA, actorKind: 'ai', source: 'chat', explicitCommand: false },
      'budget_status',
      { month: '2026-05' },
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    expect((r.result as BudgetStatusResult).period.start).toBe('2026-05-01');

    const bad = await dispatchTool(
      { db, actorUserId: userA, actorKind: 'ai', source: 'chat', explicitCommand: false },
      'budget_status',
      { month: 'май' },
    );
    expect(bad.status).toBe('error');
    if (bad.status === 'error') expect(bad.error.code).toBe('VALIDATION');
  });

  test('budgetStatus как функция: то же, что overview + категории', async () => {
    const status = await budgetStatus(db, userA, curMonth);
    const ov = await budgetOverview(db, userA, curMonth);
    expect(status.balance).toEqual(ov.balance);
    expect(status.categories.length).toBeGreaterThanOrEqual(14); // 12 сида + 2 кастомные
  });
});
