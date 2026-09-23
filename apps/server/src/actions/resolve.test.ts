// apps/server/src/actions/resolve.test.ts
// Резолв действия (§Б6-3/§Б6-4) на двух сидовых декларациях: цели, предусловие, подстановка
// `{$expr}` и CAS-пункты шагов. Живая БД под RLS, без моков: мир — записи владельца, созданные
// исполнителем в `beforeAll`.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { type GraphId, newId } from '@orbis/shared';
import {
  appDb,
  executeWithFixtureCategories as execute,
  freshGraph,
  personal,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import type { WireEntity } from '../executor/types';
import { actionHash } from '../registry/actions';
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import { type RunActionInput, resolveAction } from './resolve';

requireEnv();

const { db, client } = appDb();
const TODAY = '2026-09-16';
const ARGS = { today: TODAY, timeZone: 'Europe/Moscow' };
const CATEGORY = newId();

let owner: GraphId;
let plannedId: string;
let factId: string;
let archivedPlannedId: string;
let overdueA: string;
let overdueB: string;
let routineId: string;

async function create(input: Record<string, unknown>): Promise<string> {
  const r = await execute(db, {
    identity: personal(owner),
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool: 'entity_create', input }],
  });
  if (!r.ok) throw new Error(`create: ${r.error.code} ${r.error.message}`);
  return (r.results[0] as WireEntity).id;
}

function money(title: string, planned: boolean): Record<string, unknown> {
  return {
    title,
    tags: [],
    props: {
      'orbis/amount': '8000.00',
      'orbis/direction': 'expense',
      'orbis/finance_category': CATEGORY,
      // Дата обязательна не-повторяющейся операции (правило `financial_requires_occurred_on`),
      // поэтому CAS-пункт по ней — `in: [дата плана]`, а не `absent`.
      'orbis/occurred_on': '2026-09-10',
      'orbis/planned': planned,
    },
    aspects: ['orbis/financial'],
  };
}

function task(title: string, status: string, due: string): Record<string, unknown> {
  return {
    title,
    tags: [],
    props: { 'orbis/task_status': status, 'orbis/due_date': due },
    aspects: ['orbis/task'],
  };
}

beforeAll(async () => {
  await truncateAll();
  owner = await freshGraph();
  plannedId = await create(money('Купить кроссовки', true));
  factId = await create(money('Кофе', false));
  archivedPlannedId = await create(money('Отменённая покупка', true));
  const archived = await execute(db, {
    identity: personal(owner),
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool: 'entity_update', input: { id: archivedPlannedId, archived: true } }],
  });
  if (!archived.ok) throw new Error(`archive: ${archived.error.message}`);
  overdueA = await create(task('Просрочена А', 'inbox', '2026-09-10'));
  overdueB = await create(task('Просрочена Б', 'in_progress', '2026-09-01'));
  // Не цели: срок сегодня (не «меньше сегодня»), срок в будущем, просроченная, но сделанная.
  await create(task('Сегодня', 'planned', TODAY));
  await create(task('Будущая', 'inbox', '2026-09-20'));
  await create(task('Сделана', 'done', '2026-09-05'));
  routineId = await create({
    title: 'Утренняя сводка',
    tags: [],
    aspects: ['orbis/routine'],
    props: {
      'orbis/routine_stage': 'active',
      'orbis/routine_at': '09:00',
      'orbis/routine_days': ['mo'],
      'orbis/routine_mode': 'propose',
    },
  });
});

afterAll(async () => {
  await client.end();
});

function resolveWith(
  input: RunActionInput,
  patch: (reg: RegistrySnapshot) => RegistrySnapshot = (reg) => reg,
) {
  return withIdentity(db, personal(owner), async (tx) =>
    resolveAction(tx, patch(await effectiveRegistry(tx, owner)), owner, input, ARGS),
  );
}

const resolveFor = (self: string) =>
  resolveWith({
    action: 'finance/plan-to-fact',
    self,
    params: { occurred_on: TODAY },
  });

test('plan-to-fact: одна цель, шаг с подстановками и CAS-пунктами по тронутым свойствам', async () => {
  const r = await resolveFor(plannedId);
  expect(r.targets).toEqual([plannedId]);
  expect(r.operations).toHaveLength(1);
  const op = r.operations[0];
  expect(op?.tool).toBe('entity_update');
  // `{ctx:'$self'}` подставлен id цели, `{param}` — значением параметра вызова.
  expect(op?.input.id).toBe(plannedId);
  expect(op?.input.props).toEqual({ 'orbis/planned': false, 'orbis/occurred_on': TODAY });
  // CAS: «было» снято с той же прочитанной строки (§А7-3, buildUpdate)
  expect(op?.input.precondition).toEqual([
    { property: 'orbis/planned', in: [true] },
    { property: 'orbis/occurred_on', in: ['2026-09-10'] },
  ]);
  expect(r.summary).toBe('Действие «План → факт»');
  expect(r.hash).toBe(actionHash(r.decl));
  expect(r.rows).toEqual([
    { field: 'orbis/planned', before: 'true', after: 'false' },
    { field: 'orbis/occurred_on', before: '2026-09-10', after: TODAY },
  ]);
});

test('precondition ложно → CONFLICT precondition_failed, а не тихий ноль', async () => {
  await expect(resolveFor(factId)).rejects.toMatchObject({
    code: 'CONFLICT',
    details: { reason: 'precondition_failed', action: 'finance/plan-to-fact', id: factId },
  });
});

test('архивная цель: предусловие читает core-проекцию orbis/archived из строки цели (Р-К-30)', async () => {
  // Всё остальное в предусловии у этой записи истинно (planned, класс outflow, не шаблон, без
  // порождения) — отказ даёт ровно `not(orbis/archived = true)`, то есть колонка `archived`,
  // доехавшая в область через `TargetRow`.
  await expect(resolveFor(archivedPlannedId)).rejects.toMatchObject({
    code: 'CONFLICT',
    details: { reason: 'precondition_failed', id: archivedPlannedId },
  });
});

test('нет self у одиночного действия — ACTION_SELF_REQUIRED; лишний параметр — ACTION_PARAMS', async () => {
  await expect(
    resolveWith({ action: 'finance/plan-to-fact', params: { occurred_on: TODAY } }),
  ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'ACTION_SELF_REQUIRED' } });
  await expect(
    resolveWith({
      action: 'finance/plan-to-fact',
      self: plannedId,
      params: { occurred_on: TODAY, amount: '1.00' },
    }),
  ).rejects.toMatchObject({
    code: 'VALIDATION',
    details: { reason: 'ACTION_PARAMS', param: 'amount' },
  });
  // Недостающий обязательный и значение не того рода — тот же reason с именем поля.
  await expect(
    resolveWith({ action: 'finance/plan-to-fact', self: plannedId }),
  ).rejects.toMatchObject({ details: { reason: 'ACTION_PARAMS', param: 'occurred_on' } });
  await expect(
    resolveWith({
      action: 'finance/plan-to-fact',
      self: plannedId,
      params: { occurred_on: 'завтра' },
    }),
  ).rejects.toMatchObject({ details: { reason: 'ACTION_PARAMS', param: 'occurred_on' } });
  // Пакетному действию `self` не адресуется: цели даёт его запрос.
  await expect(
    resolveWith({ action: 'planner/postpone_overdue', self: overdueA, params: { to: TODAY } }),
  ).rejects.toMatchObject({ details: { reason: 'ACTION_PARAMS', param: 'self' } });
  await expect(resolveWith({ action: 'finance/нет-такого' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test('postpone_overdue: цели — результат Q по сегодня владельца, порядок по id, операция на цель', async () => {
  const r = await resolveWith({ action: 'planner/postpone_overdue', params: { to: '2026-09-30' } });
  expect(r.targets).toEqual([overdueA, overdueB].sort()); // просроченные; сегодняшняя и будущая — нет
  expect(r.operations.map((o) => o.input.id)).toEqual([...r.targets]);
  expect(r.operations.map((o) => o.input.props)).toEqual([
    { 'orbis/due_date': '2026-09-30' },
    { 'orbis/due_date': '2026-09-30' },
  ]);
  expect(r.summary).toBe('Действие «Отложить просроченные» — 2 записи');
});

test('целей больше batch_cap — BATCH_CAP_EXCEEDED, а не усечение (§Б6-3)', async () => {
  const capped = (reg: RegistrySnapshot): RegistrySnapshot => {
    const decl = reg.actions.get('planner/postpone_overdue');
    if (decl === undefined) throw new Error('сидового действия нет в снимке');
    return { ...reg, actions: new Map([...reg.actions, [decl.id, { ...decl, batch_cap: 1 }]]) };
  };
  await expect(
    resolveWith({ action: 'planner/postpone_overdue', params: { to: '2026-09-30' } }, capped),
  ).rejects.toMatchObject({
    code: 'VALIDATION',
    details: { reason: 'BATCH_CAP_EXCEEDED', cap: 1, found: 2 },
  });
});

test('снятое (deprecated) действие не исполняется — ACTION_DEPRECATED, а не «не найдено» (М-3)', async () => {
  const deprecated = (reg: RegistrySnapshot): RegistrySnapshot => {
    const decl = reg.actions.get('finance/plan-to-fact');
    if (decl === undefined) throw new Error('сидового действия нет в снимке');
    return {
      ...reg,
      actions: new Map([...reg.actions, [decl.id, { ...decl, status: 'deprecated' as const }]]),
    };
  };
  await expect(
    resolveWith(
      { action: 'finance/plan-to-fact', self: plannedId, params: { occurred_on: TODAY } },
      deprecated,
    ),
  ).rejects.toMatchObject({
    code: 'VALIDATION',
    details: { reason: 'ACTION_DEPRECATED', action: 'finance/plan-to-fact' },
  });
});

test('цель-рутина отвергается и владельцу — отказом на языке действия, а не предложения (М-5)', async () => {
  const refused = resolveFor(routineId);
  await expect(refused).rejects.toMatchObject({
    code: 'VALIDATION',
    details: { reason: 'ACTION_TARGET_FORBIDDEN', action: 'finance/plan-to-fact', id: routineId },
  });
  // Текст предложения рутины («предложить это нельзя») владельцу в чате был бы неправдой.
  await expect(resolveFor(routineId)).rejects.toThrow('рутина или прогон; их действия не правят');
});
