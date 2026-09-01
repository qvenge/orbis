// apps/server/src/budget/aggregates.test.ts
// Интеграционные тесты Task A6 (03-budget §2.2/§2.4/§2.5/§2.9/§2.10, §3.1, §5, §7.1):
// агрегаты Budget на лету против живой БД (RLS enforced), без моков. Фикстурный граф
// брифа: категории из сида + кастомная пара родитель/ребёнок, конверты разных фаз и
// валют, транзакции всех видов (факт/planned/чужая валюта/доход/recurring-инстанс/
// unbudgeted). Все даты — ОТНОСИТЕЛЬНО реального «сегодня» (Europe/Moscow — дефолт
// сида §7.3), кроме приёмки §7.1 с фиксированными датами мая/июня 2026.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type BudgetOverview, type BudgetStatusResult, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  appDb,
  divergentEntityRow,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { entities, relations } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import type { ExecuteRequest, WireEntity } from '../executor/types';
import { appRouter } from '../router';
import { seedCategoryId, seedOnboarding } from '../seed/onboarding';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';
import {
  budgetAlertCount,
  budgetOverview,
  budgetStatus,
  categoryTrend,
  envelopeForCategory,
  rolloverPreview,
} from './aggregates';

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
let envChildUsd = '';
let envNext = '';
let envMay = '';
let envJune = '';
let envBoundary = ''; // ровно 85% лимита — граница включительно (sign-off 2026-07-23)
// Ручная planned-покупка (§2.7) и её id для дизъюнктности planned/comingUp
let plannedTxnId = '';

/**
 * Фикстура через executor. `mechanism: 'seed'` (§А4-4): сид кладёт ГОТОВОЕ состояние, в том
 * числе перенесённый остаток `orbis/carryover`, который в проде пишет правило rollover
 * (`system_writable`, §А2-5). Без механизма фикстура падала бы `COMPUTED_WRITE` на
 * подготовке, а не на проверяемом поведении.
 */
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
    props: {
      'orbis/finance_category': categoryRef,
      'orbis/limit': limit,
      'orbis/period_start': periodStart,
      'orbis/period_end': periodEnd,
      ...over,
    },
    aspects: ['orbis/budget'],
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
    props: {
      'orbis/amount': amount,
      'orbis/direction': 'expense',
      'orbis/finance_category': categoryRef,
      'orbis/occurred_on': occurredOn,
      ...over,
    },
    aspects: ['orbis/financial'],
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
      props: { 'orbis/icon': '🎨', 'orbis/spend_class': 'discretionary' },
      aspects: ['orbis/category'],
    })
  ).id;
  catChild = (
    await exec(userA, 'entity_create', {
      title: 'Хобби — кино',
      tags: [],
      props: { 'orbis/icon': '🎬', 'orbis/spend_class': 'discretionary' },
      aspects: ['orbis/category'],
    })
  ).id;
  await exec(userA, 'relation_create', {
    source_id: catParent,
    target_id: catChild,
    role: 'category-parent',
  });

  // Конверты — ДО транзакций (авто-привязка A4 подхватывает при создании транзакций)
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
  // USD-конверт дочерней категории — fix round: агрегация §2.10 не смешивает валюты
  envChildUsd = (
    await exec(
      userA,
      'entity_create',
      envelope(catChild, cmStart, cmEnd, '500.00', { 'orbis/currency': 'USD' }),
    )
  ).id;
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
  // Граница 85% включительно (sign-off 2026-07-23): изолированный фикс-месяц 2026-03,
  // чтобы не менять alertCount=2 текущего месяца в остальных тестах.
  envBoundary = (
    await exec(userA, 'entity_create', envelope(catEdu, '2026-03-01', '2026-03-31', '10000.00'))
  ).id;

  // Транзакции фикстуры (6+ видов брифа)
  await exec(userA, 'entity_create', txn(catFood, '340.00', today)); // факт
  await exec(userA, 'entity_create', txn(catFood, '2340.00', cmStart)); // факт ранее в месяце
  plannedTxnId = (
    await exec(
      userA,
      'entity_create',
      txn(catFood, '8000.00', addDaysISO(today, 3), { 'orbis/planned': true }),
    )
  ).id; // ручная planned-покупка §2.7
  await exec(userA, 'entity_create', txn(catFood, '500.00', today, { 'orbis/currency': 'USD' })); // чужая валюта §5
  await exec(
    userA,
    'entity_create',
    txn(catSalary, '165000.00', today, { 'orbis/direction': 'income' }),
  ); // доход
  await exec(userA, 'entity_create', txn(catTransport, '3200.00', today)); // unbudgeted (конверта на месяц нет)
  await exec(userA, 'entity_create', txn(catHousing, '900.00', today)); // 90% лимита → alert
  await exec(userA, 'entity_create', txn(catEnt, '150.00', today)); // перерасход remaining<0
  await exec(userA, 'entity_create', txn(catChild, '1000.00', today)); // иерархия §2.10
  await exec(userA, 'entity_create', txn(catChild, '100.00', today, { 'orbis/currency': 'USD' })); // → envChildUsd
  await exec(userA, 'entity_create', txn(catEdu, '340.00', '2026-05-31')); // приёмка §7.1: created_at=сейчас
  await exec(userA, 'entity_create', txn(catEdu, '8500.00', '2026-03-15')); // ровно 85% envBoundary
  await exec(userA, 'entity_create', txn(catHealth, '150.00', `${prevMonth}-15`)); // тренд: прошлый месяц
  await exec(userA, 'entity_create', txn(catHealth, '200.00', today)); // тренд: текущий месяц

  // Recurring-шаблон (§2.8): еженедельно с завтра — инстансы только в Coming up
  await exec(userA, 'entity_create', {
    title: 'Netflix',
    tags: [],
    props: {
      'orbis/start_at': `${addDaysISO(today, 1)}T12:00:00+03:00`,
      'orbis/timezone': TZ,
      'orbis/recurrence': { freq: 'weekly', interval: 1 },
      'orbis/amount': '599.00',
      'orbis/direction': 'expense',
      'orbis/finance_category': catSubs,
      'orbis/recurring': true,
    },
    aspects: ['orbis/schedule', 'orbis/financial'],
  });
});

afterAll(async () => {
  await client.end();
});

/**
 * ИНТЕРВАЛ 7a→0017 (урок C1 Задачи 7a). Конвертом-родителем транзакции до contract-миграции
 * считается ЛЮБАЯ связь от конверта, проецирующаяся в старый `parent`, — так её видят и хук
 * привязки (`budgetParentsOfMany`), и инвариант «один budget-parent»
 * (`assertSingleLegacyBudgetParent`). Агрегаты обязаны считать ТО ЖЕ множество: сузив их до
 * одной роли `envelope-binding`, мы получили бы расход, которого владелец в конверте не
 * видит, и «свободно» больше реального.
 *
 * Проба идёт ролью `subitem` — той самой, которой владелец связывает записи руками.
 */
describe('множество «конверт-родитель» на интервале до 0017 (§13.7)', () => {
  const userC = freshUserId();
  const catC = seedCategoryId(userC, 'food');
  const catOther = seedCategoryId(userC, 'entertainment');
  let envC = '';
  let txnManual = '';

  beforeAll(async () => {
    await withIdentity(db, userC, (tx) => seedOnboarding(tx, userC));
    envC = (await exec(userC, 'entity_create', envelope(catC, cmStart, cmEnd, '10000.00'))).id;
    // Транзакция ЧУЖОЙ категории — авто-привязка (A4) её к этому конверту не ставит…
    txnManual = (await exec(userC, 'entity_create', txn(catOther, '700.00', today))).id;
    // …а владелец связывает её с конвертом руками, обычной иерархической ролью
    await exec(userC, 'relation_create', {
      source_id: envC,
      target_id: txnManual,
      role: 'subitem',
    });
  });

  test('связь роли владельца от конверта к транзакции входит в spent конверта', async () => {
    const ov = await budgetOverview(db, userC, curMonth);
    expect(envById(ov, envC).spent).toBe('700.00');
  });

  test('та же связь выводит транзакцию из unbudgeted: у обоих читателей одно множество', async () => {
    const ov = await budgetOverview(db, userC, curMonth);
    expect(ov.unbudgeted.map((u) => u.category.id)).not.toContain(catOther);
  });

  // НАЗВАННАЯ ПЕРЕМЕНА реформы (§А4-3): дерево категорий §2.10 собирает роль
  // `category-parent`, а не любая связь, проецировавшаяся в старый `parent`. «Часть внутри
  // целого» между двумя категориями связью остаётся, но родительскую карточку не наполняет.
  test('дерево категорий собирает только роль category-parent: subitem между категориями агрегат не наполняет', async () => {
    const top = (
      await exec(userC, 'entity_create', {
        title: 'Верхняя категория',
        tags: [],
        props: { 'orbis/spend_class': 'discretionary' },
        aspects: ['orbis/category'],
      })
    ).id;
    const nested = (
      await exec(userC, 'entity_create', {
        title: 'Вложенная категория',
        tags: [],
        props: { 'orbis/spend_class': 'discretionary' },
        aspects: ['orbis/category'],
      })
    ).id;
    await exec(userC, 'relation_create', { source_id: top, target_id: nested, role: 'subitem' });
    const envTop = (await exec(userC, 'entity_create', envelope(top, cmStart, cmEnd, '5000.00')))
      .id;
    const envNested = (
      await exec(userC, 'entity_create', envelope(nested, cmStart, cmEnd, '4000.00'))
    ).id;
    await exec(userC, 'entity_create', txn(nested, '1500.00', today));

    const ov = await budgetOverview(db, userC, curMonth);
    expect(envById(ov, envNested).spent).toBe('1500.00');
    // Роль связи — не `category-parent`, значит для §2.10 это НЕ дерево
    expect(envById(ov, envTop).spent).toBe('0.00');
    expect(envById(ov, envTop).effectiveLimit).toBe('5000.00');
  });

  test('связь от НЕ-конверта конвертом-родителем не делает: в spent её нет', async () => {
    const plain = (await exec(userC, 'entity_create', { title: 'Просто запись', tags: [] })).id;
    const free = (await exec(userC, 'entity_create', txn(catOther, '900.00', today))).id;
    await exec(userC, 'relation_create', { source_id: plain, target_id: free, role: 'subitem' });
    const ov = await budgetOverview(db, userC, curMonth);
    expect(envById(ov, envC).spent).toBe('700.00');
    // …и она осталась unbudgeted — родителя-конверта у неё нет
    expect(ov.unbudgeted.map((u) => u.category.id)).toContain(catOther);
  });
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
    // родитель: свой конверт (0 из 10000) + дочерний RUB (1000 из 5000)
    expect(parent.spent).toBe('1000.00');
    expect(parent.effectiveLimit).toBe('15000.00');
    expect(parent.remaining).toBe('14000.00');
    expect(parent.dailyPace).toBe(paceOf('14000.00', daysInclusive(today, cmEnd)));
  });

  test('fix round: агрегация §2.10 не смешивает валюты — USD-конверт ребёнка не входит в RUB-карточку родителя (§5)', async () => {
    const ov = await budgetOverview(db, userA, curMonth);
    // USD-конверт ребёнка живёт своей карточкой…
    const childUsd = envById(ov, envChildUsd);
    expect(childUsd.spent).toBe('100.00');
    expect(childUsd.effectiveLimit).toBe('500.00');
    // …но НЕ суммируется в RUB-карточку родителя (100 USD ≠ 100 RUB)
    const parent = envById(ov, envParent);
    expect(parent.spent).toBe('1000.00'); // не 1100.00
    expect(parent.effectiveLimit).toBe('15000.00'); // не 15500.00
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

  test('fix round: тренд не смешивает валюты — USD-конверт категории (envUsd) не входит в бакет месяца (§5)', async () => {
    // у еды в текущем месяце ДВА конверта: RUB (30000, spent 2680) и USD (1000, spent 500);
    // бакет считает только валюту по умолчанию — иначе limit 31000 и spent 3180 бессмысленны
    const points = await categoryTrend(db, userA, { categoryId: catFood, months: 1 });
    expect(points).toEqual([{ period: curMonth, spent: '2680.00', limit: '30000.00' }]);
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

// ---------------------------------------------------------------------------
// Шаблоны recurring и spent (финальное ревью фазы A): шаблон — не операция (§3.1),
// в spent он не входит НИ при какой привязке; считаются только его инстансы, по разу.
// ---------------------------------------------------------------------------
describe('spent не считает recurring-шаблон (§2.2, §2.8)', () => {
  test('конверсия факт-транзакции в шаблон: связь снята, spent — только posted-инстанс, один раз', async () => {
    const user = freshUserId();
    const cat = newId();
    const env = await exec(user, 'entity_create', envelope(cat, cmStart, cmEnd, '10000.00'));
    const fact = await exec(user, 'entity_create', txn(cat, '500.00', today));

    // «Пометить повторяющейся»: attach orbis/schedule.recurrence на привязанный факт
    await exec(user, 'attach_orbis_schedule', {
      entity_id: fact.id,
      data: {
        'orbis/start_at': `${today}T12:00:00+03:00`,
        'orbis/timezone': TZ,
        'orbis/recurrence': { freq: 'monthly', interval: 1 },
      },
    });

    // Конвейер §2.8 дважды: первый прогон материализует окно (postDue идёт ДО
    // материализации), второй постит сегодняшний инстанс (planned→fact).
    // spent = 500.00 ровно один раз (posted-инстанс); шаблон не считается —
    // до фикса выходило 1000.00 (шаблон с висящей привязкой + инстанс, двойной счёт).
    await budgetOverview(db, user, curMonth);
    const ov = await budgetOverview(db, user, curMonth);
    expect(envById(ov, env.id).spent).toBe('500.00');
  });

  test('висящая parent-связь на шаблон (защита в SQL): spent = 0', async () => {
    const user = freshUserId();
    const cat = newId();
    await exec(user, 'entity_create', envelope(cat, cmStart, cmEnd, '10000.00'));
    // Шаблон с occurred_on (валиден §3.3: recurrence на той же сущности); until в прошлом —
    // инстансы не материализуются, изоляция ровно на SQL-фильтр spentByEnvelope
    const tpl = await exec(user, 'entity_create', {
      title: 'Шаблон с висящей связью',
      tags: [],
      props: {
        'orbis/start_at': `${today}T12:00:00+03:00`,
        'orbis/timezone': TZ,
        'orbis/recurrence': { freq: 'monthly', interval: 1, until: addDaysISO(today, -1) },
        'orbis/amount': '700.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': cat,
        'orbis/occurred_on': today,
      },
      aspects: ['orbis/schedule', 'orbis/financial'],
    });
    // Висящая связь (легаси-данные/ручной relation_create): бюджет-хук на relation_create
    // не срабатывает — связь остаётся, spent обязан отфильтровать шаблон сам
    const st = await envelopeForCategory(db, user, { categoryId: cat, date: today });
    if (st === null) throw new Error('конверт не найден');
    await exec(user, 'relation_create', {
      source_id: st.envelope.id,
      target_id: tpl.id,
      role: 'envelope-binding',
    });
    const after = await envelopeForCategory(db, user, { categoryId: cat, date: today });
    expect(after?.spent).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
// Task B7: лёгкий count-запрос бейджа вкладки Budget (§6.1) — только чтение
// агрегата, БЕЗ конвейера §2.8 (postDue/материализация не запускаются).
// ---------------------------------------------------------------------------
describe('budget.alertCount (§6.1): count-only бейдж вкладки', () => {
  const createCaller = createCallerFactory(appRouter);
  const callerFor = (user: string | null) =>
    createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });

  test('дефолтный месяц (текущий): то же число, что overview.alertCount — ⚠ 85–100% и 🔴 ≥100% вместе', async () => {
    // жильё 900/1000 = 90% (⚠) и развлечения 150/100 = 150% (🔴) — см. фикстуру
    expect(await budgetAlertCount(db, userA)).toBe(2);
  });

  test('sign-off 2026-07-23: граница ровно 85% — ВКЛЮЧИТЕЛЬНО, бейдж = ⚠-порог карточки §3.1', async () => {
    // Конверт 8500/10000 (изолированный месяц 2026-03): при строгом > выпадал из бейджа,
    // хотя карточка уже ⚠ (>=85, §3.1) — спековая коллизия §3.1 vs §6.1 решена владельцем
    // в пользу «включительно ≥ везде». Обе точки (overview и count-only) — общий countAlerts.
    const ov = await budgetOverview(db, userA, '2026-03');
    expect(envById(ov, envBoundary).spent).toBe('8500.00');
    expect(ov.alertCount).toBe(1);
    expect(await budgetAlertCount(db, userA, '2026-03')).toBe(1);
  });

  test('месяц без тревог → 0; upcoming-конверты порогами не считаются (§2.9а)', async () => {
    expect(await budgetAlertCount(db, userA, '2026-05')).toBe(0); // envMay: 340/1000 = 34%
    expect(await budgetAlertCount(db, userA, nextMonth)).toBe(0); // envNext: фаза upcoming
  });

  test('count-only: НЕ материализует recurring-инстансы (в отличие от overview)', async () => {
    const user = freshUserId();
    await exec(user, 'entity_create', {
      title: 'Подписка',
      tags: [],
      props: {
        'orbis/start_at': `${addDaysISO(today, 1)}T12:00:00+03:00`,
        'orbis/timezone': TZ,
        'orbis/recurrence': { freq: 'weekly', interval: 1 },
        'orbis/amount': '599.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': newId(),
        'orbis/recurring': true,
      },
      aspects: ['orbis/schedule', 'orbis/financial'],
    });
    const instanceCount = () =>
      withIdentity(db, user, async (tx) => {
        const rows = (await tx.execute(sql`
          SELECT count(*)::int AS n FROM entities e
          WHERE e.owner_id = ${user}
            AND EXISTS (SELECT 1 FROM relations r
                        WHERE r.target_id = e.id AND r.relation_type = 'derived_from')
        `)) as unknown as Array<{ n: number }>;
        return rows[0]?.n ?? 0;
      });

    expect(await budgetAlertCount(db, user)).toBe(0);
    expect(await instanceCount()).toBe(0); // лёгкое чтение ничего не породило

    await budgetOverview(db, user, curMonth); // контраст: конвейер §2.8 материализует
    expect(await instanceCount()).toBeGreaterThan(0);
  });

  test('tRPC budget.alertCount: владелец — число; RLS чужого owner — 0; без auth — UNAUTHORIZED', async () => {
    expect(await callerFor(userA).budget.alertCount({})).toBe(2);
    expect(await callerFor(userA).budget.alertCount({ month: '2026-05' })).toBe(0);
    expect(await callerFor(userB).budget.alertCount({})).toBe(0);
    await expect(callerFor(null).budget.alertCount({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

// ---------------------------------------------------------------------------
// Task A1 (слайс 3): шов подмены «сегодня» — clock последним параметром агрегатов.
// Даты ФИКСИРОВАННЫЕ (сентябрь 2026), поэтому у сценариев собственный владелец:
// общая фикстура файла привязана к реальному «сегодня» и смешению не подлежит.
// Таймзона — DEFAULT_TIMEZONE (Europe/Moscow §2.3): строки user_settings у свежего
// владельца нет, «сегодня» деградирует к дефолту — как в проде до онбординга.
// ---------------------------------------------------------------------------
describe('clock-шов: границы дат (Task A1)', () => {
  test('граница суток: recurring-инстанс становится фактом в день наступления даты (§2.8)', async () => {
    const user = freshUserId();
    const cat = newId();
    const env = await exec(
      user,
      'entity_create',
      envelope(cat, '2026-09-01', '2026-09-30', '10000.00'),
    );
    await exec(user, 'entity_create', {
      title: 'Подписка 5-го числа',
      tags: [],
      props: {
        'orbis/start_at': '2026-09-05T12:00:00+03:00',
        'orbis/timezone': TZ,
        'orbis/recurrence': { freq: 'monthly', interval: 1 },
        'orbis/amount': '1000.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': cat,
        'orbis/recurring': true,
      },
      aspects: ['orbis/schedule', 'orbis/financial'],
    });

    // 23:00 04.09 по Москве: инстанс материализован, но ещё planned — только Coming up
    const before = await budgetOverview(
      db,
      user,
      '2026-09',
      () => new Date('2026-09-04T20:00:00Z'),
    );
    expect(before.comingUp.map((c) => c.occurredOn)).toEqual(['2026-09-05']);
    expect(envById(before, env.id).spent).toBe('0.00');

    // 00:30 05.09 по Москве — ТОТ ЖЕ календарный день по UTC: сменилась именно
    // локальная дата владельца (§2.3), и postDue перевёл инстанс в факт
    const after = await budgetOverview(db, user, '2026-09', () => new Date('2026-09-04T21:30:00Z'));
    expect(after.comingUp).toEqual([]);
    expect(envById(after, env.id).spent).toBe('1000.00');
    expect(after.balance.expense).toBe('1000.00');
  });

  test('последний день закрывающегося месяца: остаток к переносу меняется на локальной полуночи (§2.6, §3.5)', async () => {
    const user = freshUserId();
    const cat = newId();
    await exec(user, 'entity_create', envelope(cat, '2026-08-01', '2026-08-31', '10000.00'));
    // Трата ПОСЛЕДНЕГО дня августа: только она отличает две стороны границы
    await exec(user, 'entity_create', txn(cat, '7000.00', '2026-08-31'));

    // Оба клока — одни сутки по UTC (30.08), но по разные стороны московской полуночи,
    // как в тесте выше: сравниваются не «прошлое и будущее», а две локальные даты
    // владельца. 23:00 30.08 МСК — 31-е ещё не наступило, траты этого дня в spent не
    // входят (occurred_on ≤ сегодня, §2.2), переносится весь лимит
    const before = await rolloverPreview(
      db,
      user,
      '2026-09',
      () => new Date('2026-08-30T20:00:00Z'),
    );
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]?.prevSpent).toBe('0.00');
    expect(before.rows[0]?.carryover).toBe('10000.00');

    // 00:30 31.08 МСК — та же дата по UTC, сменилась именно локальная дата владельца
    const after = await rolloverPreview(
      db,
      user,
      '2026-09',
      () => new Date('2026-08-30T21:30:00Z'),
    );
    expect(after.needsSetup).toBe(false);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.prevSpent).toBe('7000.00');
    expect(after.rows[0]?.carryover).toBe('3000.00'); // 10000 − 7000 (§2.6)
  });
});

// ---------------------------------------------------------------------------
// Задача 10a: агрегаты читают НОВУЮ правду строки (§А1-1) — `props` и `aspects[]`
// ---------------------------------------------------------------------------
/**
 * ПРОБА РАСХОЖДЕНИЕМ КОЛОНОК. Фикстура кладёт строки, у которых `props`/`aspects[]` и старая
 * карта аспектов говорят РАЗНОЕ, и спрашивает у агрегатов, чей ответ они дают.
 *
 * Такого состояния прод не производит: на интервале §А1-1 обе колонки пишет один писатель
 * (`projectLegacyAspects`), и они равны по построению. Ровно поэтому проба и нужна: пока они
 * равны, ЛЮБОЙ перевод читателя с одной колонки на другую зелёный, и «переведено» отличить
 * от «не переведено» поведением нельзя. Расхождение — единственный способ спросить про
 * ИСТОЧНИК, а источник и есть предмет этой задачи.
 *
 * Строки пишутся прямым INSERT'ом (как датасет компилятора `compile.dataset.test.ts`): через
 * исполнителя разойтись колонками невозможно по построению.
 *
 * Даты фиксированы (октябрь 2026) и «сегодня» подменяется clock-швом: общая фикстура файла
 * привязана к реальному сегодня и смешению не подлежит. Онбординг НЕ сеется намеренно —
 * `budgetStatus` перечисляет ВСЕ категории владельца, и двенадцать сидовых заслонили бы
 * пробу; валюта по умолчанию при этом деградирует к фолбэку RUB (`defaultCurrencyOf`).
 */
describe('источник значений Финансов — props/aspects[], а не старая карта (§А1-1, Задача 10a)', () => {
  const userD = freshUserId();
  const octClock = () => new Date('2026-10-15T09:00:00Z'); // 12:00 15.10 по Москве
  const OCT = '2026-10';

  const catA = newId(); // категория ТОЛЬКО по списку аспектов (в старой карте ключа нет)
  const catB = newId(); // категория, у которой props и карта дают разные icon/color/class
  const catNoEnv = newId(); // категория без конверта — вход Unbudgeted
  const catTreeChild = newId(); // дочерняя категория дерева §2.10
  const envA = newId(); // конверт catB: период/лимит в props ≠ период/лимит в карте
  const envTreeParent = newId();
  const envTreeChild = newId();
  const envGhost = newId(); // «конверт» только по списку аспектов — вход NOT EXISTS Unbudgeted

  type Row = typeof entities.$inferInsert;

  function entityRow(
    id: string,
    title: string,
    props: Record<string, unknown>,
    aspects: string[],
    legacy: Record<string, Record<string, unknown>>,
  ): Row {
    return divergentEntityRow({ ownerId: userD, id, title, props, aspects, legacy });
  }

  /** Транзакция: props — левая колонка пробы, `legacyFin` — правая (та же форма полей). */
  function txnRow(
    id: string,
    title: string,
    props: Record<string, unknown>,
    legacyFin: Record<string, unknown>,
    extra: { aspects?: string[]; legacy?: Record<string, Record<string, unknown>> } = {},
  ): Row {
    return entityRow(id, title, props, extra.aspects ?? ['orbis/financial'], {
      'orbis/financial': legacyFin,
      ...(extra.legacy ?? {}),
    });
  }

  const txnAmount = newId();
  const txnEnvCurrency = newId();
  const txnPlannedProps = newId();
  const txnFactProps = newId();
  const txnCurrency = newId();
  const txnDirection = newId();
  const txnTemplate = newId();
  const txnFuture = newId();
  const txnTreeChild = newId();
  const txnGhostBound = newId();
  // Значения БЕЗ аспекта-носителя: так выглядит запись после detach (Р9 — снятие аспекта
  // значений не трогает). В старой карте их не было вовсе, в `props` они остаются, и
  // читатель без признака аспекта посчитал бы по ним деньги.
  const txnDetached = newId();
  const txnDetachedBound = newId();
  const envDetached = newId();
  // «Категория» без аспекта категории и конверт на неё: сторожат признак носителя на ОБОИХ
  // концах ребра дерева §2.10.
  const pseudoCat = newId();
  const envPseudo = newId();

  beforeAll(async () => {
    const rows: Row[] = [
      // Категории. catA несёт аспект ТОЛЬКО списком — проба containment
      // (носитель ищется элементом списка `aspects`, а не ключом старой карты).
      entityRow(catA, 'Категория списком', { 'orbis/icon': '🟢' }, ['orbis/category'], {}),
      entityRow(
        catB,
        'Категория с расхождением',
        { 'orbis/icon': '🟩', 'orbis/color': '#00aa00', 'orbis/spend_class': 'fixed' },
        ['orbis/category'],
        { 'orbis/category': { icon: '🟥', color: '#aa0000', spend_class: 'discretionary' } },
      ),
      entityRow(catNoEnv, 'Категория без конверта', { 'orbis/icon': '🧺' }, ['orbis/category'], {}),
      entityRow(catTreeChild, 'Дочерняя категория', { 'orbis/icon': '🌿' }, ['orbis/category'], {}),

      // Конверт catB: в props — октябрь 2026 и лимит 5000, в карте — январь 2025 и лимит 1.
      entityRow(
        envA,
        'Конверт расхождения',
        {
          'orbis/finance_category': catB,
          'orbis/limit': '5000.00',
          'orbis/currency': 'RUB',
          'orbis/period_start': '2026-10-01',
          'orbis/period_end': '2026-10-31',
        },
        ['orbis/budget'],
        {
          'orbis/budget': {
            category_ref: catB,
            limit: '1.00',
            currency: 'RUB',
            period_start: '2025-01-01',
            period_end: '2025-01-31',
          },
        },
      ),
      // Дерево §2.10: родитель catA (аспект только списком) и его ребёнок.
      entityRow(
        envTreeParent,
        'Конверт родителя дерева',
        {
          'orbis/finance_category': catA,
          'orbis/limit': '1000.00',
          'orbis/currency': 'RUB',
          'orbis/period_start': '2026-10-01',
          'orbis/period_end': '2026-10-31',
        },
        ['orbis/budget'],
        {
          'orbis/budget': {
            category_ref: catA,
            limit: '1000.00',
            currency: 'RUB',
            period_start: '2026-10-01',
            period_end: '2026-10-31',
          },
        },
      ),
      entityRow(
        envTreeChild,
        'Конверт ребёнка дерева',
        {
          'orbis/finance_category': catTreeChild,
          'orbis/limit': '2000.00',
          'orbis/currency': 'RUB',
          'orbis/period_start': '2026-10-01',
          'orbis/period_end': '2026-10-31',
        },
        ['orbis/budget'],
        {
          // Лимит в карте занижен НАМЕРЕННО: по нему трата 300 даёт перерасход и бейдж
          // §6.1 считает конверт тревожным, по props (2000) — нет. Это единственное, что
          // отличает две стороны в тесте бейджа ниже.
          'orbis/budget': {
            category_ref: catTreeChild,
            limit: '100.00',
            currency: 'RUB',
            period_start: '2026-10-01',
            period_end: '2026-10-31',
          },
        },
      ),
      // «Конверт» только по списку аспектов: период вне октября, чтобы карточкой он не был,
      // — его роль в пробе одна, быть источником связи для NOT EXISTS Unbudgeted.
      entityRow(
        envGhost,
        'Конверт списком',
        {
          'orbis/finance_category': catNoEnv,
          'orbis/limit': '10.00',
          'orbis/currency': 'RUB',
          'orbis/period_start': '2024-01-01',
          'orbis/period_end': '2024-01-31',
        },
        ['orbis/budget'],
        {},
      ),

      // Транзакции: у каждой ОДНО расхождение, чтобы красное указывало на конкретное чтение.
      txnRow(
        txnAmount,
        'Сумма из props',
        {
          'orbis/amount': '700.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': catB,
          'orbis/occurred_on': '2026-10-10',
        },
        {
          amount: '70000.00',
          direction: 'expense',
          category_ref: catB,
          occurred_on: '2026-10-10',
        },
      ),
      txnRow(
        txnEnvCurrency,
        'Валюта против валюты конверта',
        {
          'orbis/amount': '999.00',
          'orbis/currency': 'USD',
          'orbis/direction': 'expense',
          'orbis/finance_category': catB,
          'orbis/occurred_on': '2026-10-10',
        },
        {
          amount: '999.00',
          currency: 'RUB',
          direction: 'expense',
          category_ref: catB,
          occurred_on: '2026-10-10',
        },
      ),
      txnRow(
        txnPlannedProps,
        'План по props, факт по карте',
        {
          'orbis/amount': '111.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': catB,
          'orbis/occurred_on': '2026-10-20',
          'orbis/planned': true,
        },
        {
          amount: '111.00',
          direction: 'expense',
          category_ref: catB,
          occurred_on: '2026-10-20',
          planned: false,
        },
      ),
      // РП-9: в props свойства НЕТ вовсе — «отсутствие = false», то есть факт.
      txnRow(
        txnFactProps,
        'Факт по props (свойства нет), план по карте',
        {
          'orbis/amount': '222.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': catNoEnv,
          'orbis/occurred_on': '2026-10-11',
        },
        {
          amount: '222.00',
          direction: 'expense',
          category_ref: catNoEnv,
          occurred_on: '2026-10-11',
          planned: true,
        },
      ),
      txnRow(
        txnCurrency,
        'Чужая валюта по props',
        {
          'orbis/amount': '333.00',
          'orbis/currency': 'USD',
          'orbis/direction': 'expense',
          'orbis/finance_category': catNoEnv,
          'orbis/occurred_on': '2026-10-12',
        },
        {
          amount: '333.00',
          currency: 'RUB',
          direction: 'expense',
          category_ref: catNoEnv,
          occurred_on: '2026-10-12',
        },
      ),
      txnRow(
        txnDirection,
        'Направление из props',
        {
          'orbis/amount': '444.00',
          'orbis/direction': 'income',
          'orbis/finance_category': catNoEnv,
          'orbis/occurred_on': '2026-10-13',
        },
        {
          amount: '444.00',
          direction: 'expense',
          category_ref: catNoEnv,
          occurred_on: '2026-10-13',
        },
      ),
      // Шаблон повторения: `orbis/recurrence` есть в props и нет в старой карте.
      txnRow(
        txnTemplate,
        'Шаблон по props',
        {
          'orbis/amount': '555.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': catNoEnv,
          'orbis/occurred_on': '2026-10-14',
          'orbis/recurrence': { freq: 'weekly', interval: 1 },
        },
        {
          amount: '555.00',
          direction: 'expense',
          category_ref: catNoEnv,
          occurred_on: '2026-10-14',
        },
        {
          aspects: ['orbis/financial', 'orbis/schedule'],
          legacy: { 'orbis/schedule': {} },
        },
      ),
      txnRow(
        txnFuture,
        'Будущая дата по props',
        {
          'orbis/amount': '666.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': catNoEnv,
          'orbis/occurred_on': '2026-10-25',
        },
        {
          amount: '666.00',
          direction: 'expense',
          category_ref: catNoEnv,
          occurred_on: '2026-10-05',
        },
      ),
      txnRow(
        txnTreeChild,
        'Трата дочерней категории',
        {
          'orbis/amount': '300.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': catTreeChild,
          'orbis/occurred_on': '2026-10-10',
        },
        {
          amount: '300.00',
          direction: 'expense',
          category_ref: catTreeChild,
          occurred_on: '2026-10-10',
        },
      ),
      // Транзакция без аспекта `orbis/financial`: значения в props остались, носителя нет.
      entityRow(
        txnDetached,
        'Расход без аспекта',
        {
          'orbis/amount': '4321.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': catNoEnv,
          'orbis/occurred_on': '2026-10-08',
        },
        [],
        {},
      ),
      // То же, но под конвертом envA: сторожит признак аспекта в spent конверта.
      entityRow(
        txnDetachedBound,
        'Расход без аспекта под конвертом',
        {
          'orbis/amount': '5432.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': catB,
          'orbis/occurred_on': '2026-10-08',
        },
        [],
        {},
      ),
      entityRow(pseudoCat, 'Не категория', { 'orbis/icon': '❌' }, [], {}),
      entityRow(
        envPseudo,
        'Конверт не-категории',
        {
          'orbis/finance_category': pseudoCat,
          'orbis/limit': '400.00',
          'orbis/currency': 'RUB',
          'orbis/period_start': '2026-10-01',
          'orbis/period_end': '2026-10-31',
        },
        ['orbis/budget'],
        {},
      ),
      // Конверт без аспекта `orbis/budget`: свойства периода и лимита в props остались.
      entityRow(
        envDetached,
        'Конверт без аспекта',
        {
          'orbis/finance_category': catB,
          'orbis/limit': '9999.00',
          'orbis/currency': 'RUB',
          'orbis/period_start': '2026-10-01',
          'orbis/period_end': '2026-10-31',
        },
        [],
        {},
      ),
      txnRow(
        txnGhostBound,
        'Трата под конвертом-списком',
        {
          'orbis/amount': '888.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': catNoEnv,
          'orbis/occurred_on': '2026-10-09',
        },
        {
          amount: '888.00',
          direction: 'expense',
          category_ref: catNoEnv,
          occurred_on: '2026-10-09',
        },
      ),
    ];

    // Связи кладутся прямо: `relation_type` — проекция роли, ровно как её пишет исполнитель.
    const edges = [
      { source: envA, target: txnAmount, role: 'envelope-binding', type: 'parent' },
      { source: envA, target: txnEnvCurrency, role: 'envelope-binding', type: 'parent' },
      { source: envA, target: txnPlannedProps, role: 'envelope-binding', type: 'parent' },
      { source: envTreeChild, target: txnTreeChild, role: 'envelope-binding', type: 'parent' },
      { source: envGhost, target: txnGhostBound, role: 'subitem', type: 'parent' },
      { source: envA, target: txnDetachedBound, role: 'envelope-binding', type: 'parent' },
      { source: catA, target: catTreeChild, role: 'category-parent', type: 'parent' },
      // Ребро дерева к НЕ-категории: агрегат родителя его собирать не должен.
      { source: catB, target: pseudoCat, role: 'category-parent', type: 'parent' },
    ];

    await withIdentity(db, userD, async (tx) => {
      await tx.insert(entities).values(rows);
      await tx.insert(relations).values(
        edges.map((e) => ({
          id: newId(),
          sourceId: e.source,
          targetId: e.target,
          role: e.role,
          relationType: e.type,
        })),
      );
    });
  });

  test('карточка конверта берёт период и лимит из props: конверт октября, лимит 5000', async () => {
    const ov = await budgetOverview(db, userD, OCT, octClock);
    const st = ov.envelopes.find((e) => e.envelope.id === envA);
    expect(st).toBeDefined();
    expect(st?.effectiveLimit).toBe('5000.00');
    expect(st?.phase).toBe('active');
    // Старая карта поставила бы конверт в январь 2025 — в октябрьской выдаче его бы не было.
  });

  /**
   * Вторая сторона границы: значения читаются ТОЛЬКО под приложенным аспектом. Строка после
   * detach несёт полный набор свойств конверта/транзакции и обязана быть невидимой для всех
   * агрегатов — иначе снятие аспекта перестало бы что-либо значить для денег.
   */
  test('значения без аспекта-носителя не считаются ни конвертом, ни транзакцией', async () => {
    const ov = await budgetOverview(db, userD, OCT, octClock);
    expect(ov.envelopes.map((e) => e.envelope.id)).not.toContain(envDetached);
    // 4321 (без аспекта) не попал ни в баланс, ни в Unbudgeted; 5432 — не попал в spent
    // конверта, хотя связь `envelope-binding` от envA к нему есть.
    expect(ov.balance.expense).toBe('2110.00');
    expect(ov.envelopes.find((e) => e.envelope.id === envA)?.spent).toBe('700.00');
    expect(ov.unbudgeted.map((u) => u.total)).toEqual(['222.00']);

    // Селектор §2.3 такую строку конвертом тоже не считает: иначе он выбрал бы её вместо
    // envA (тот же период, меньший uuid решал бы tie-break произвольно).
    const st = await envelopeForCategory(
      db,
      userD,
      { categoryId: catB, date: '2026-10-10' },
      octClock,
    );
    expect(st?.envelope.id).toBe(envA);
  });

  test('spent конверта считает сумму и валюту из props (§2.2, §5)', async () => {
    const ov = await budgetOverview(db, userD, OCT, octClock);
    const st = ov.envelopes.find((e) => e.envelope.id === envA);
    // 700 (сумма из props) — и НЕ 70000 из карты; USD-транзакция в RUB-конверт не входит,
    // хотя карта называет её рублёвой; план по props в spent не входит, хотя карта зовёт
    // его фактом.
    expect(st?.spent).toBe('700.00');
  });

  test('баланс периода собран по props: направление, валюта, дата и «нет planned = факт»', async () => {
    const ov = await budgetOverview(db, userD, OCT, octClock);
    // expense: 700 (txnAmount) + 222 (факт по props) + 888 (под конвертом-списком) = 1810.
    // Не входят: 999 и 333 (USD по props), 111 (план по props), 444 (доход по props),
    // 555 (шаблон по props), 666 (будущая дата по props), 300 — входит, это тоже расход.
    expect(ov.balance.expense).toBe('2110.00');
    expect(ov.balance.income).toBe('444.00');
    expect(ov.balance.balance).toBe('-1666.00');
  });

  test('planned собирает план по props, а не по карте (§2.7, РП-9)', async () => {
    const ov = await budgetOverview(db, userD, OCT, octClock);
    expect(ov.planned.map((p) => p.entity.id)).toEqual([txnPlannedProps]);
    expect(ov.planned[0]?.amount).toBe('111.00');
    expect(ov.planned[0]?.categoryTitle).toBe('Категория с расхождением');
  });

  test('Unbudgeted: группировка по категории props, а конверт-родитель — по списку аспектов', async () => {
    const ov = await budgetOverview(db, userD, OCT, octClock);
    // Единственная строка — catNoEnv на 222.00: 888.00 увёл конверт, несомый ТОЛЬКО
    // списком аспектов; 333.00 — чужая валюта, 555.00 — шаблон, 666.00 — будущая дата.
    expect(ov.unbudgeted).toEqual([
      {
        category: { id: catNoEnv, title: 'Категория без конверта', icon: '🧺' },
        total: '222.00',
      },
    ]);
  });

  test('карточка категории берёт icon/color из props', async () => {
    const ov = await budgetOverview(db, userD, OCT, octClock);
    const st = ov.envelopes.find((e) => e.envelope.id === envA);
    expect(st?.category).toEqual({
      id: catB,
      title: 'Категория с расхождением',
      icon: '🟩',
      color: '#00aa00',
    });
  });

  test('дерево категорий §2.10 собрано по списку аспектов и роли category-parent', async () => {
    const ov = await budgetOverview(db, userD, OCT, octClock);
    const parent = ov.envelopes.find((e) => e.envelope.id === envTreeParent);
    // Родитель показывает СВОЙ лимит плюс лимит ребёнка и расход ребёнка (§2.10).
    expect(parent?.effectiveLimit).toBe('3000.00');
    expect(parent?.spent).toBe('300.00');

    // Вторая сторона: ребро `category-parent` к НЕ-категории деревом не считается —
    // иначе конверт catB собрал бы ещё 400.00 лимита конверта не-категории.
    expect(ov.envelopes.find((e) => e.envelope.id === envA)?.effectiveLimit).toBe('5000.00');
  });

  test('budget_status: категории и spend_class — из списка аспектов и props', async () => {
    const st = await budgetStatus(db, userD, OCT, octClock);
    // Порядок — `ORDER BY title, id` запроса; список полный, потому что онбординг не сеялся.
    expect(st.categories).toEqual([
      { id: catTreeChild, title: 'Дочерняя категория', spendClass: null },
      { id: catNoEnv, title: 'Категория без конверта', spendClass: null },
      { id: catB, title: 'Категория с расхождением', spendClass: 'fixed' },
      { id: catA, title: 'Категория списком', spendClass: null },
    ]);
  });

  test('селектор конверта (§2.3) выбирает по периоду из props', async () => {
    const st = await envelopeForCategory(
      db,
      userD,
      { categoryId: catB, date: '2026-10-10' },
      octClock,
    );
    expect(st?.envelope.id).toBe(envA);
    expect(st?.effectiveLimit).toBe('5000.00');
  });

  test('мини-тренд категории (§3.2) читает конверты по props', async () => {
    const trend = await categoryTrend(db, userD, { categoryId: catB, months: 1 }, octClock);
    expect(trend).toEqual([{ period: OCT, spent: '700.00', limit: '5000.00' }]);
  });

  test('превью rollover (§3.5) видит месячный конверт октября по props', async () => {
    const preview = await rolloverPreview(db, userD, '2026-11', octClock);
    expect(preview.needsSetup).toBe(false);
    // Порядок строк — title → id; catNoEnv попадает сюда без конверта: его октябрьские
    // траты по props видит запрос «категории с тратами БЕЗ конверта прошлого месяца».
    // pseudoCat замыкает список: `categoriesById` берёт title из СТРОКИ (как и до перевода),
    // признак аспекта гасит только карточку — icon/color/spend_class.
    expect(preview.rows.map((r) => r.categoryId)).toEqual([
      catTreeChild,
      catNoEnv,
      catB,
      catA,
      pseudoCat,
    ]);
    // carryover = effectiveLimit − spent (§2.6): 5000 − 700 у catB.
    expect(preview.rows.find((r) => r.categoryId === catB)?.carryover).toBe('4300.00');
    // Категория без конверта: переносить нечего, suggestedLimit — трата вверх до сотни.
    // 1110 = 222 + 888: оба октябрьских факта по props. Не вошли 333 (USD по props),
    // 555 (шаблон по props) и 666 (дата 25.10 по props — позже «сегодня»).
    // Конверт-родитель здесь роли не играет: этот запрос смотрит на конверты КАТЕГОРИИ,
    // а период envGhost (январь 2024) октябрь не пересекает.
    expect(preview.rows.find((r) => r.categoryId === catNoEnv)).toMatchObject({
      prevSpent: '1110.00',
      carryover: '0.00',
      suggestedLimit: '1200.00',
    });
  });

  test('бейдж §6.1 берёт лимит конверта из props', async () => {
    // По props ни один октябрьский конверт не в тревоге: 700 из 5000, 300 из 2000, 0 из 1000.
    // По старой карте лимит envTreeChild — 100, и та же трата 300 дала бы ровно одну тревогу.
    expect(await budgetAlertCount(db, userD, OCT, octClock)).toBe(0);
  });
});
