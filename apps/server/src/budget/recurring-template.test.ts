// apps/server/src/budget/recurring-template.test.ts
// Task A2, решение D20: сущность-шаблон повторяющейся операции (задан
// orbis/schedule.recurrence) С полем orbis/financial.occurred_on — ВАЛИДНОЕ состояние:
// именно так выглядит результат флоу «Сделать повторяющейся» (recurrence приезжает на
// уже существующий факт/плановую покупку, occurred_on остаётся). Но шаблон — не операция
// (03-budget §3.1): ни один агрегат его не считает.
//
// Тест-сторож на углы D20, НЕ покрытые describe «spent не считает recurring-шаблон»
// (aggregates.test.ts): unbudgeted и баланс периода (§2.3 шаг 5, §2.5, §3.1) и список
// planned-покупок (§2.7). Каждый случай с положительным контролем — настоящей операцией
// рядом: иначе «агрегат пуст» доказывал бы не фильтр шаблонов, а пустого пользователя.
//
// «Сегодня» фиксировано подменяемым Clock (Task A1) — прогон не зависит от даты запуска.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { execute } from '../executor/executor';
import type { ExecuteRequest, WireEntity } from '../executor/types';
import type { Clock } from './aggregates';
import { budgetOverview, budgetStatus } from './aggregates';

requireEnv();

const { db, client } = appDb();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

const MONTH = '2026-09';
// 10 сентября 2026, 13:00 в Europe/Moscow (дефолт §7.3 — у fresh-пользователя настроек нет).
// Якорь серии — 5-е число: следующий инстанс 2026-10-05, ЗА окном материализации
// [сегодня; +14] (§2.8), так что конвейер overview фикстуру не дополняет.
const clock: Clock = () => new Date('2026-09-10T10:00:00Z');
const SERIES_START = '2026-09-05T12:00:00+03:00';
const RECURRENCE = { freq: 'monthly', interval: 1 } as const;

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

/** Расход без конверта: попал бы в unbudgeted и в баланс периода, будь он операцией. */
function expense(
  categoryRef: string,
  amount: string,
  occurredOn: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: `Операция ${amount}`,
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

test('шаблон с occurred_on не попадает ни в unbudgeted, ни в баланс периода (D20, §2.3/§2.5)', async () => {
  const user = freshUserId();
  const catRent = newId();
  const catFood = newId();

  // Шаблон «Аренда» — конвертов у пользователя нет вовсе, поэтому единственная защита
  // от попадания в unbudgeted/баланс — фильтр шаблонов в самих запросах агрегатов.
  await exec(user, 'entity_create', {
    title: 'Аренда',
    tags: [],
    aspects: {
      'orbis/schedule': {
        start_at: SERIES_START,
        timezone: 'Europe/Moscow',
        recurrence: RECURRENCE,
      },
      'orbis/financial': {
        amount: '50000.00',
        direction: 'expense',
        category_ref: catRent,
        occurred_on: '2026-09-05',
      },
    },
  });
  // Положительный контроль: обычный факт того же месяца обязан остаться в обоих агрегатах
  await exec(user, 'entity_create', expense(catFood, '340.00', '2026-09-05'));

  const ov = await budgetOverview(db, user, MONTH, clock);

  // В unbudgeted — только категория настоящего факта; 50000.00 шаблона нет ни строкой,
  // ни слагаемым (иначе тут была бы и пара [catRent, '50000.00'])
  expect(ov.unbudgeted.map((u) => [u.category.id, u.total])).toEqual([[catFood, '340.00']]);
  expect(ov.balance).toEqual({ income: '0.00', expense: '340.00', balance: '-340.00' });
});

test('шаблон не попадает в список planned-покупок §2.7 (D20)', async () => {
  const user = freshUserId();
  const catRent = newId();
  const catGift = newId();

  // Флоу «Сделать повторяющейся» поверх ПЛАНОВОЙ покупки: planned=true остаётся на
  // сущности, сверху приезжает recurrence — без фильтра шаблон висел бы в planned вечно
  const tpl = await exec(
    user,
    'entity_create',
    expense(catRent, '50000.00', '2026-09-20', { planned: true }),
  );
  await exec(user, 'attach_orbis_schedule', {
    entity_id: tpl.id,
    data: { start_at: SERIES_START, timezone: 'Europe/Moscow', recurrence: RECURRENCE },
  });
  // Положительный контроль: ручная planned-покупка §2.7 в списке остаётся
  const purchase = await exec(
    user,
    'entity_create',
    expense(catGift, '1200.00', '2026-09-25', { planned: true }),
  );

  const status = await budgetStatus(db, user, MONTH, clock);

  expect(status.planned.map((p) => p.entity.id)).toEqual([purchase.id]);
});
