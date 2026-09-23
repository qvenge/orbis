// apps/server/src/subscriptions/budget-golden.test.ts
// Эталон вывода ДВИЖКА ведомостей Budget (§С8-15 после сноса оракула, Р-32/В-10). До Б-2 «ноль
// расхождений» доказывалось второй реализацией; теперь — снимком, и пересдача его ЯВНАЯ: расхождение
// разбирается, а не записывается (тот же режим, что у `tool-registry.json` и `validator-verdicts.json`).
//
// Мир — СВОЙ, а не живая фикстура `budget.test.ts` (решение 6): та привязана к СИСТЕМНЫМ часам
// (`today` из `Intl.DateTimeFormat`, `curMonth = today.slice(0, 7)`), и `period`, `phase`, `dailyPace`
// в её выводе меняются каждую полночь. Здесь сеется КОПИЯ той же обстановки (конверты месяца и
// соседних, дерево категорий, USD-конверты, пограничный 85 %, траты без конверта, planned и
// recurring-инстансы) от прибитого «сегодня». Копия, а не импорт: тест-файл импортировать нельзя —
// его тесты зарегистрировались бы в этом сьюте (тот же довод, что в шапке `budget.test.ts`).
//
// ВЛАДЕЛЕЦ И ID СУЩНОСТЕЙ ДЕТЕРМИНИРОВАНЫ (uuidv5 от имени), и это не косметика: порядок карточек
// кончается `id` (`order_by` декларации), а у пары конвертов одной категории и одного периода
// (RUB и USD) он и решает. Со случайными id снимок менял бы порядок от прогона к прогону.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  type BudgetSubscription,
  canonicalJson,
  type GraphId,
  ORBIS_NAMESPACE,
  ROLE_CATEGORY_PARENT,
} from '@orbis/shared';
import { v5 as uuidv5 } from 'uuid';
import GOLDEN from '../../test/golden/budget-engine.json';
import {
  appDb,
  executeWithFixtureCategories as execute,
  mintGraph,
  personal,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { budgetOverview } from '../budget/aggregates';
import { type Tx, withIdentity } from '../db/with-identity';
import type { ExecuteRequest, WireEntity } from '../executor/types';
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import { seedCategoryId, seedOwnerGraph } from '../seed/onboarding';
import { normalizeOverview } from '../test/overview-golden';
import { BUDGET_SUBSCRIPTION_ID, budgetOverviewOf } from './budget';
import { builtinSubscription } from './registry';

requireEnv();
const { db, client } = appDb();

// Часы ПРИБИТЫ (решение 6): даты обстановки выведены из них, и с системным «сегодня» снимок протухал
// бы каждую полночь — ровно тот довод, по которому у корпуса volume есть `VOLUME_TODAY`.
const GOLDEN_TODAY = '2026-02-17';
/** Полдень по Москве — зона владельца по умолчанию; локальная дата от него = `GOLDEN_TODAY`. */
const GOLDEN_CLOCK = () => new Date(`${GOLDEN_TODAY}T12:00:00+03:00`);
/**
 * Имена = ключи снимка. Роли месяцев — те же, что у четырёх месяцев сверки `budget.test.ts`:
 * текущий (фаза active), следующий (upcoming), закрытый с тратой в последний день (у него
 * `days_inclusive(today, period_end)` = 0 — ленивое плечо `if` у `daily_pace`) и закрытый
 * пограничный — ровно 85 % лимита, порог ВКЛЮЧИТЕЛЬНО. Закрытые месяцы лежат ДО прибитого
 * «сегодня»: после него трата не факт (`date <= $today`), а фаза — `upcoming`, и половина снимка
 * выродилась бы в нули.
 */
const MONTHS = ['2026-02', '2026-03', '2025-12', '2025-11'] as const; // имена = ключи снимка
const [CUR, NEXT, CLOSED_EDGE, BOUNDARY] = MONTHS;
const TZ = 'Europe/Moscow';

const owner: GraphId = mintGraph(uuidv5('budget-golden:owner', ORBIS_NAMESPACE));
/** Детерминированный id сущности мира (см. шапку). */
const gid = (name: string) => uuidv5(`budget-golden:${name}`, ORBIS_NAMESPACE);

function addDaysISO(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Фикстура через исполнитель. `mechanism: 'seed'` (§А4-4): сид кладёт ГОТОВОЕ состояние, в том
 *  числе перенесённый остаток `orbis/carryover`, который в проде пишет правило rollover. */
async function exec(tool: string, input: unknown): Promise<WireEntity> {
  const req: ExecuteRequest = {
    identity: personal(owner),
    actorKind: 'owner',
    source: 'ui',
    mechanism: 'seed',
    clock: GOLDEN_CLOCK,
    operations: [{ tool, input }],
  };
  const r = await execute(db, req);
  if (!r.ok) throw new Error(`${tool}: ${r.error.code} — ${r.error.message}`);
  return r.results[0] as WireEntity;
}

const envelope = (
  name: string,
  categoryRef: string,
  month: string,
  limit: string,
  over: Record<string, unknown> = {},
) => ({
  id: gid(`envelope:${name}`),
  title: `Конверт ${name} ${month}`,
  tags: [],
  aspects: ['orbis/budget'],
  props: {
    'orbis/finance_category': categoryRef,
    'orbis/limit': limit,
    'orbis/period_start': `${month}-01`,
    'orbis/period_end': lastDayOf(month),
    ...over,
  },
});
const txn = (
  name: string,
  categoryRef: string,
  amount: string,
  occurredOn: string,
  over: Record<string, unknown> = {},
) => ({
  id: gid(`txn:${name}`),
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

const catFood = seedCategoryId(owner, 'food');
const catTransport = seedCategoryId(owner, 'transport');
const catHousing = seedCategoryId(owner, 'housing');
const catEnt = seedCategoryId(owner, 'entertainment');
const catEdu = seedCategoryId(owner, 'education');
const catSalary = seedCategoryId(owner, 'salary');
const catSubs = seedCategoryId(owner, 'subscriptions');

beforeAll(async () => {
  await truncateAll();
  await seedOwnerGraph(db, personal(owner), GOLDEN_CLOCK);
  const catParent = (
    await exec('entity_create', {
      id: gid('category:hobby'),
      title: 'Хобби',
      tags: [],
      aspects: ['orbis/category'],
      props: { 'orbis/icon': '🎨', 'orbis/spend_class': 'discretionary' },
    })
  ).id;
  const catChild = (
    await exec('entity_create', {
      id: gid('category:hobby-cinema'),
      title: 'Хобби — кино',
      tags: [],
      aspects: ['orbis/category'],
      props: { 'orbis/icon': '🎬', 'orbis/spend_class': 'discretionary' },
    })
  ).id;
  await exec('relation_create', {
    source_id: catParent,
    target_id: catChild,
    role: ROLE_CATEGORY_PARENT,
  });
  // Конверты — ДО транзакций: авто-привязку (ребро `envelope-binding`) ставит хук при создании траты.
  await exec(
    'entity_create',
    envelope('food', catFood, CUR, '30000.00', { 'orbis/carryover': '1200.00' }),
  );
  await exec(
    'entity_create',
    envelope('food-usd', catFood, CUR, '1000.00', { 'orbis/currency': 'USD' }),
  );
  await exec('entity_create', envelope('housing', catHousing, CUR, '1000.00'));
  await exec('entity_create', envelope('entertainment', catEnt, CUR, '100.00'));
  await exec('entity_create', envelope('hobby', catParent, CUR, '10000.00'));
  await exec('entity_create', envelope('hobby-cinema', catChild, CUR, '5000.00'));
  await exec(
    'entity_create',
    envelope('hobby-cinema-usd', catChild, CUR, '500.00', { 'orbis/currency': 'USD' }),
  );
  await exec('entity_create', envelope('transport-next', catTransport, NEXT, '5000.00'));
  await exec('entity_create', envelope('education-closed', catEdu, CLOSED_EDGE, '1000.00'));
  await exec('entity_create', envelope('education-boundary', catEdu, BOUNDARY, '10000.00'));

  const cmStart = `${CUR}-01`;
  await exec('entity_create', txn('food-today', catFood, '340.00', GOLDEN_TODAY));
  await exec('entity_create', txn('food-start', catFood, '2340.00', cmStart));
  await exec(
    'entity_create',
    txn('food-planned', catFood, '8000.00', addDaysISO(GOLDEN_TODAY, 3), { 'orbis/planned': true }),
  );
  await exec(
    'entity_create',
    txn('food-usd', catFood, '500.00', GOLDEN_TODAY, { 'orbis/currency': 'USD' }),
  );
  await exec(
    'entity_create',
    txn('salary', catSalary, '165000.00', GOLDEN_TODAY, { 'orbis/direction': 'income' }),
  );
  await exec('entity_create', txn('transport', catTransport, '3200.00', GOLDEN_TODAY)); // unbudgeted
  await exec('entity_create', txn('housing', catHousing, '900.00', GOLDEN_TODAY)); // 90 % → alert
  await exec('entity_create', txn('entertainment', catEnt, '150.00', GOLDEN_TODAY)); // перерасход
  await exec('entity_create', txn('hobby-cinema', catChild, '1000.00', GOLDEN_TODAY));
  await exec(
    'entity_create',
    txn('hobby-cinema-usd', catChild, '100.00', GOLDEN_TODAY, { 'orbis/currency': 'USD' }),
  );
  await exec('entity_create', txn('education-closed', catEdu, '340.00', lastDayOf(CLOSED_EDGE)));
  // ровно 85 % пограничного конверта
  await exec('entity_create', txn('education-boundary', catEdu, '8500.00', `${BOUNDARY}-15`));
  await exec('entity_create', {
    id: gid('schedule:netflix'),
    title: 'Netflix',
    tags: [],
    aspects: ['orbis/schedule', 'orbis/financial'],
    props: {
      'orbis/start_at': `${addDaysISO(GOLDEN_TODAY, 1)}T12:00:00+03:00`,
      'orbis/timezone': TZ,
      'orbis/recurrence': { freq: 'weekly', interval: 1 },
      'orbis/amount': '599.00',
      'orbis/direction': 'expense',
      'orbis/finance_category': catSubs,
      'orbis/recurring': true,
    },
  });
  // Конвейер §2.8 (postDue + материализация окна) движку НЕ принадлежит — он живёт в обёртке, и
  // инстансы Coming up кладёт он. Часы — те же прибитые: окно материализации [today; today+14]
  // обязано совпасть с окном списка, которое движок спросит от `GOLDEN_TODAY`.
  await budgetOverview(db, personal(owner), CUR, GOLDEN_CLOCK);
  await budgetOverview(db, personal(owner), CUR, GOLDEN_CLOCK);
  // @ts-expect-error bun-types 1.2.7 не объявляет второй аргумент beforeAll — таймаут
}, 120_000);

afterAll(async () => {
  await client.end();
});

/** Снимок реестра + разобранная декларация — один вход на все тесты сьюта. */
async function engineOn<T>(
  user: GraphId,
  fn: (a: { tx: Tx; reg: RegistrySnapshot; def: BudgetSubscription }) => Promise<T>,
): Promise<T> {
  return withIdentity(db, personal(user), async (tx) => {
    const reg = await effectiveRegistry(tx, user);
    const def = builtinSubscription(reg, BUDGET_SUBSCRIPTION_ID) as BudgetSubscription;
    return fn({ tx, reg, def });
  });
}

test('§С8-15: движок на юнит-фикстурах равен снимку по canonicalJson', async () => {
  for (const month of MONTHS) {
    const ov = await engineOn(owner, ({ tx, reg, def }) =>
      budgetOverviewOf(tx, owner, { month, today: GOLDEN_TODAY }, def, reg),
    );
    expect([month, canonicalJson(normalizeOverview(ov))]).toEqual([
      month,
      canonicalJson(GOLDEN.fixtures[month]),
    ]);
  }
});

test('снимок не выродился: конверты, ведомости периода и списки в нём есть', () => {
  // Сторож той же породы, что сторож непустоты корпуса в `perf/volume.test.ts`: сверка с пустым
  // объектом зелена всегда.
  const cur = GOLDEN.fixtures['2026-02'] as {
    envelopes: unknown[];
    unbudgeted: unknown[];
    alertCount: number;
  };
  expect(cur.envelopes.length).toBeGreaterThan(3);
  expect(cur.unbudgeted.length).toBeGreaterThan(0);
  expect(cur.alertCount).toBeGreaterThan(0);
});
