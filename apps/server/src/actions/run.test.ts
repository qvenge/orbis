// apps/server/src/actions/run.test.ts
// Исполнение действия (§Б6-2/§Б6-4, §С2-2): уровень по свёртке резолвленных шагов ∪ фактов
// декларации, гейты полномочий по КАЖДОМУ шагу, маска модулей и строка журнала `type:'action'`.
//
// Мока в репозитории нет ни одного, и заводить его здесь не за чем: факты вызова — ЧИСТАЯ функция
// от резолва (`actionCallFacts`), её тест спрашивает напрямую, а у диспатча — только НАБЛЮДАЕМЫЙ
// исход (статус и строка журнала). Живая БД под RLS.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { type ActionDefinition, type GraphId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  appDb,
  executeWithFixtureCategories as execute,
  freshGraph,
  personal,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import type { ActionRecord, WireEntity } from '../executor/types';
import { classifyToolCall } from '../policy/confirmation';
import { approvePending } from '../policy/pending';
import { effectiveRegistry } from '../registry/cache';
import { setModuleDisabled } from '../registry/modules';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import { resolveAction } from './resolve';
import { actionCallFacts, runAction } from './run';

requireEnv();

const { db, client } = appDb();
const TODAY = '2026-09-16';
// Полдень по Москве (зона владельца по умолчанию): «сегодня» резолва — ровно TODAY.
const NOW = new Date(`${TODAY}T09:00:00.000Z`);
const ARGS = { today: TODAY, timeZone: 'Europe/Moscow' };
const CATEGORY = newId();

let owner: GraphId;
/** Исполняется первым тестом — после него уже факт. */
let plannedExecuted: string;
/** Не исполняется никем: цель отказов по гейтам и маске (резолв проходит, до записи не доходит). */
let plannedKept: string;
/** Исполняется act-рутиной с открытыми шагами. */
let plannedByRoutine: string;

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

const planned = (title: string) =>
  create({
    title,
    tags: [],
    props: {
      'orbis/amount': '8000.00',
      'orbis/direction': 'expense',
      'orbis/finance_category': CATEGORY,
      'orbis/occurred_on': '2026-09-10',
      'orbis/planned': true,
    },
    aspects: ['orbis/financial'],
  });

beforeAll(async () => {
  await truncateAll();
  owner = await freshGraph();
  plannedExecuted = await planned('Кроссовки');
  plannedKept = await planned('Велосипед');
  plannedByRoutine = await planned('Абонемент');
  // Одиннадцать просроченных открытых задач: пакет больше 10 — ряд масштаба §7.10.
  for (let i = 1; i <= 11; i++) {
    const day = String(i).padStart(2, '0');
    await create({
      title: `Просрочена ${i}`,
      tags: [],
      props: { 'orbis/task_status': 'inbox', 'orbis/due_date': `2026-09-${day}` },
      aspects: ['orbis/task'],
    });
  }
});

afterAll(async () => {
  await client.end();
});

function ctx(over: Partial<ToolCallCtx> = {}): ToolCallCtx {
  return {
    db,
    identity: personal(owner),
    actorKind: 'ai',
    source: 'chat',
    explicitCommand: false,
    clock: () => NOW,
    ...over,
  };
}
const ownerCtx = () => ctx({ actorKind: 'owner' });
const aiCtx = () => ctx();
function routineCtx(routine: { mode: 'propose' | 'act'; allowedTools: string[] }): ToolCallCtx {
  const runId = newId();
  return ctx({
    source: 'routine',
    runId,
    routine: {
      id: newId(),
      runId,
      mode: routine.mode,
      allowedTools: new Set(routine.allowedTools),
    },
  });
}

const PLAN_TO_FACT = (self: string) => ({
  action: 'finance/plan-to-fact',
  self,
  params: { occurred_on: TODAY },
});

/** Строка журнала §7.8 по её id — журнал живёт в `metadata` audit-сообщения. */
async function actionOf(actionId: string): Promise<ActionRecord> {
  const rows = await withIdentity(db, personal(owner), (tx) =>
    tx.execute(sql`SELECT m.metadata->'actions'->0 AS action FROM chat_messages m
      WHERE m.metadata->'actions'->0->>'id' = ${actionId}`),
  );
  const action = rows[0]?.action as ActionRecord | undefined;
  if (action === undefined) throw new Error(`строки журнала ${actionId} нет`);
  return action;
}

async function propsOf(id: string): Promise<Record<string, unknown>> {
  const rows = await withIdentity(db, personal(owner), (tx) =>
    tx.execute(sql`SELECT props FROM entities WHERE id = ${id}`),
  );
  return rows[0]?.props as Record<string, unknown>;
}

test('уровень одиночного действия — по свёртке шагов; факт декларации доезжает в sensitivity', async () => {
  const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  const resolved = await withIdentity(db, personal(owner), (tx) =>
    resolveAction(tx, reg, owner, PLAN_TO_FACT(plannedExecuted), ARGS),
  );
  const facts = actionCallFacts(reg, resolved.decl, resolved.operations, resolved.targets, {
    actorKind: 'owner',
    explicitCommand: false,
  });
  expect([facts.isBatch, facts.reconfigures, facts.archives, facts.grantsAutonomy]).toEqual([
    false,
    'none',
    false,
    false,
  ]);
  // `touches_money` — и из декларации, и из шага (`orbis/planned` — слот money-movement);
  // множество, а не список: факт один.
  expect([...facts.sensitivity]).toEqual(['touches_money']);
  expect(facts.tool).toBe('run_action');
  expect(classifyToolCall(facts)).toBe('execute');

  // И наблюдаемый исход того же вызова через диспатч — строка журнала, а не «наверное execute».
  const out = await dispatchTool(ownerCtx(), 'run_action', PLAN_TO_FACT(plannedExecuted));
  expect(out.status).toBe('ok');
  if (out.status !== 'ok' || out.actionId === undefined) throw new Error('ожидался actionId');
  const action = await actionOf(out.actionId);
  expect([action.type, action.action_id, action.module]).toEqual([
    'action',
    'finance/plan-to-fact',
    'finance',
  ]);
  // Одна строка — один inverse: откат вернёт план и прежнюю дату одной записью журнала.
  expect(action.inverse.map((op) => op.op)).toEqual(['entity_update']);
  expect(action.inverse[0]?.payload).toMatchObject({
    id: plannedExecuted,
    props: { 'orbis/planned': true, 'orbis/occurred_on': '2026-09-10' },
  });
  const after = await propsOf(plannedExecuted);
  expect([after['orbis/planned'], after['orbis/occurred_on']]).toEqual([false, TODAY]);

  // Повтор того же вызова — честный CONFLICT предусловия, а не второе исполнение (§Б6-4).
  const again = await dispatchTool(ownerCtx(), 'run_action', PLAN_TO_FACT(plannedExecuted));
  expect(again).toMatchObject({
    status: 'error',
    error: { code: 'CONFLICT', details: { reason: 'precondition_failed' } },
  });
});

test('map с 11 целями → isBatch:true и explicit-confirmation по ряду масштаба таблицы §7.10', async () => {
  const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  const resolved = await withIdentity(db, personal(owner), (tx) =>
    resolveAction(
      tx,
      reg,
      owner,
      { action: 'planner/postpone_overdue', params: { to: '2026-09-30' } },
      ARGS,
    ),
  );
  expect(resolved.targets).toHaveLength(11);
  // Пачка ли это — решает НАЛИЧИЕ `over`, а не имя тула (О7 опровержения `verify-b2-policy`).
  const facts = actionCallFacts(reg, resolved.decl, resolved.operations, resolved.targets, {
    actorKind: 'ai',
    explicitCommand: false,
  });
  expect([facts.isBatch, facts.batchSize]).toEqual([true, 11]);
  expect([...facts.sensitivity]).toEqual([]);
  expect(classifyToolCall(facts)).toBe('explicit-confirmation');
  const out = await dispatchTool(aiCtx(), 'action_planner_postpone_overdue', { to: '2026-09-30' });
  expect(out.status).toBe('pending_confirmation');
  if (out.status !== 'pending_confirmation') return;
  // Карточка называет ДЕЙСТВИЕ и его масштаб, а не «batch_execute»: владелец подтверждает группу.
  expect(out.card).toMatchObject({
    kind: 'confirmation_card',
    mode: 'explicit',
    summary: 'Действие «Отложить просроченные» — 11 записей',
  });
  // Ничего не записано: сроки на месте до решения владельца.
  expect(
    (
      await withIdentity(db, personal(owner), (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM entities
          WHERE props->>'orbis/due_date' = '2026-09-30'`),
      )
    )[0]?.n,
  ).toBe(0);
});

test('§С2-2: шаг вне allowed_tools act-рутины → FORBIDDEN_LEVEL, названный шагом', async () => {
  // Имя каталога рутине открыто (`run_action` в белом списке), а ШАГ действия — нет: гейт по
  // внешнему имени тут пропустил бы, и ровно поэтому он смотрит на резолвленные шаги (§Б6-2).
  const out = await dispatchTool(
    routineCtx({ mode: 'act', allowedTools: ['entity_create', 'run_action'] }),
    'run_action',
    PLAN_TO_FACT(plannedKept),
  );
  expect(out).toMatchObject({
    status: 'error',
    error: {
      code: 'FORBIDDEN_LEVEL',
      details: { reason: 'action_step_forbidden', tool: 'entity_update' },
    },
  });
  // Без имени каталога в белом списке рутина до шагов не доходит: первая линия — общий гейт
  // режима по имени вызова (`routineGate`), как у любого другого тула.
  const unnamed = await dispatchTool(
    routineCtx({ mode: 'act', allowedTools: ['entity_create', 'entity_update'] }),
    'run_action',
    PLAN_TO_FACT(plannedKept),
  );
  expect(unnamed).toMatchObject({
    status: 'error',
    error: { code: 'FORBIDDEN_LEVEL', details: { tool: 'run_action', mode: 'act' } },
  });
  // Режим propose: ни один шаг действия (графовые тулы) ему не открыт.
  const propose = await dispatchTool(
    routineCtx({ mode: 'propose', allowedTools: ['run_action'] }),
    'run_action',
    PLAN_TO_FACT(plannedKept),
  );
  expect(propose).toMatchObject({ status: 'error', error: { code: 'FORBIDDEN_LEVEL' } });
  expect((await propsOf(plannedKept))['orbis/planned']).toBe(true);
});

test('act-рутина с открытыми шагами исполняет одиночное действие; пакет на explicit — fail-closed до задачи 8', async () => {
  const allowed = ['entity_update', 'run_action', 'action_planner_postpone_overdue'];
  const ok = await dispatchTool(
    routineCtx({ mode: 'act', allowedTools: allowed }),
    'run_action',
    PLAN_TO_FACT(plannedByRoutine),
  );
  expect(ok.status).toBe('ok');
  expect((await propsOf(plannedByRoutine))['orbis/planned']).toBe(false);
  // Пакет из 11 — explicit-confirmation; фону здесь велена отложенная единица D42, и её кладёт
  // задача 8. До неё — отказ тем же текстом, что инвариант 5, а не тишина (Р-К-29).
  const batch = await dispatchTool(
    routineCtx({ mode: 'act', allowedTools: allowed }),
    'action_planner_postpone_overdue',
    { to: '2026-09-30' },
  );
  expect(batch).toMatchObject({
    status: 'error',
    error: {
      code: 'FORBIDDEN_LEVEL',
      // Текст — дословно инвариант 5 (`runMutation`): фон получает один отказ на все пути.
      message:
        'в фоне откладывается только одиночное небезопасное действие — уровень «explicit-confirmation» не исполняется и не откладывается (V1.10)',
      details: { action: 'planner/postpone_overdue', level: 'explicit-confirmation' },
    },
  });
});

test('скоуп worker: шаг вне WORKER_SCOPE_TOOLS → FORBIDDEN_LEVEL и во второй линии (runAction)', async () => {
  // Первая линия — гейт скоупа диспатча по имени: `run_action` не в `WORKER_SCOPE_TOOLS`.
  const grant = { id: newId(), scope: 'worker' as const, label: 'фон' };
  const first = await dispatchTool(
    ctx({ actorKind: 'agent', source: 'mcp', grant }),
    'run_action',
    PLAN_TO_FACT(plannedKept),
  );
  expect(first).toMatchObject({ status: 'error', error: { code: 'FORBIDDEN_LEVEL' } });
  // Вторая линия — по ШАГАМ, в самой ветке: зовём её напрямую, мимо первой.
  const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  const second = await runAction(
    ctx({ actorKind: 'agent', source: 'mcp', grant }),
    reg,
    [],
    'finance/plan-to-fact',
    { self: plannedKept, params: { occurred_on: TODAY } },
    { defer: async () => ({ status: 'error', error: { code: 'X', message: 'не зовётся' } }) },
  );
  expect(second).toMatchObject({
    status: 'error',
    error: {
      code: 'FORBIDDEN_LEVEL',
      details: { reason: 'action_step_forbidden', tool: 'entity_update', scope: 'worker' },
    },
  });
});

test('run_action действия выключенного модуля → MODULE_DISABLED (Р-20)', async () => {
  const mask = (modules: string[], disabled: boolean) =>
    withIdentity(db, personal(owner), async (tx) => {
      for (const m of modules) await setModuleDisabled(tx, owner, m, disabled);
    });
  await mask(['finance', 'planner'], true);
  try {
    const out = await dispatchTool(ownerCtx(), 'run_action', PLAN_TO_FACT(plannedKept));
    expect(out).toMatchObject({
      status: 'error',
      error: {
        code: 'MODULE_DISABLED',
        details: { action: 'finance/plan-to-fact', module: 'finance' },
      },
    });
    // Тул действия выключенного модуля скрыт маской, и вызов по имени — тот же MODULE_DISABLED,
    // а не «неизвестный тул» (вторая линия §Б8-3 диспатча).
    const tool = await dispatchTool(ownerCtx(), 'action_planner_postpone_overdue', {
      to: '2026-09-30',
    });
    expect(tool).toMatchObject({
      status: 'error',
      error: { code: 'MODULE_DISABLED', details: { module: 'planner' } },
    });
  } finally {
    await mask(['finance', 'planner'], false);
  }
  expect((await propsOf(plannedKept))['orbis/planned']).toBe(true);
});

/**
 * Синтетическая декларация поверх снимка: ветка `runAction` берёт снимок параметром, и проба
 * «уровень — по шагам» не требует строки реестра (её запись — тулы задачи 10).
 */
function withAction(
  reg: Awaited<ReturnType<typeof effectiveRegistry>>,
  decl: ActionDefinition,
): Awaited<ReturnType<typeof effectiveRegistry>> {
  return { ...reg, actions: new Map([...reg.actions, [decl.id, decl]]) };
}
const synthetic = (over: Partial<ActionDefinition>): ActionDefinition => ({
  id: 'user/synthetic',
  graphId: null,
  key: 'user/synthetic',
  label: { ru: 'Синтетика' },
  description: { ru: 'Проба уровня по шагам' },
  params: [],
  precondition: null,
  over: null,
  steps: [],
  sensitivity: [],
  offered_by: [],
  module: null,
  batch_cap: null,
  status: 'active',
  rank: 99,
  ...over,
});
const NO_DEFER = {
  defer: async () => ({ status: 'error', error: { code: 'X', message: 'не зовётся' } }) as const,
};

test('уровень — по РЕЗОЛВЛЕННЫМ шагам, а не по декларации: архивация выражением поднимает до explicit-confirmation', async () => {
  // В декларации фактов нет, а в шаблоне шага архивация — ВЫРАЖЕНИЕМ: ни имя тула, ни шаблон
  // (`{$expr}` ≠ true) её не видят, видит только резолвленная операция (§Б6-2, риск О7).
  const decl = synthetic({
    steps: [
      {
        tool: 'entity_update',
        input: { id: { $expr: { ctx: '$self' } }, archived: { $expr: { const: true } } },
      },
    ],
  });
  const reg = withAction(
    await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner)),
    decl,
  );
  const out = await runAction(aiCtx(), reg, [], decl.key, { self: plannedKept }, NO_DEFER);
  expect(out.status).toBe('pending_confirmation');
  const resolved = await withIdentity(db, personal(owner), (tx) =>
    resolveAction(tx, reg, owner, { action: decl.key, self: plannedKept }, ARGS),
  );
  const facts = actionCallFacts(reg, decl, resolved.operations, resolved.targets, {
    actorKind: 'ai',
    explicitCommand: false,
  });
  expect([facts.archives, facts.isBatch, classifyToolCall(facts)]).toEqual([
    true,
    false,
    'explicit-confirmation',
  ]);
  // До решения владельца ничего не записано.
  expect(
    (
      await withIdentity(db, personal(owner), (tx) =>
        tx.execute(sql`SELECT archived FROM entities WHERE id = ${plannedKept}`),
      )
    )[0]?.archived,
  ).toBe(false);
});

test('факты шагов доезжают в sensitivity, даже когда декларация их не назвала (§Б6-1 «только добавлять»)', async () => {
  // Недообъявленную декларацию отвергает `assertAction` (SENSITIVITY_UNDERDECLARED) при записи;
  // на исполнении факт шага всё равно объединяется — уровень не считается по неполному набору.
  const decl = synthetic({
    params: [{ name: 'sum', type: { kind: 'decimal' }, required: true }],
    steps: [
      {
        tool: 'entity_update',
        input: {
          id: { $expr: { ctx: '$self' } },
          props: { 'orbis/amount': { $expr: { param: 'sum' } } },
        },
      },
    ],
  });
  const reg = withAction(
    await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner)),
    decl,
  );
  const resolved = await withIdentity(db, personal(owner), (tx) =>
    resolveAction(
      tx,
      reg,
      owner,
      { action: decl.key, self: plannedKept, params: { sum: '1.00' } },
      ARGS,
    ),
  );
  const facts = actionCallFacts(reg, decl, resolved.operations, resolved.targets, {
    actorKind: 'ai',
    explicitCommand: false,
  });
  expect([...facts.sensitivity]).toEqual(['touches_money']);
});

test('карточка подтверждения длиннее капа пачки — BATCH_TOO_LONG до постановки (В-9, Р-11)', async () => {
  // Пакет из 11 целей × 10 шагов = 110 операций: уровень — подтверждение (масштаб), а конверт
  // единицы `batch_execute` держит кап 100 — такую карточку `approvePending` не принял бы никогда.
  const snap = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  const postpone = snap.actions.get('planner/postpone_overdue');
  if (postpone === undefined) throw new Error('сидового действия нет в снимке');
  const decl = synthetic({
    params: postpone.params,
    over: postpone.over,
    batch_cap: 100,
    steps: Array.from({ length: 10 }, () => postpone.steps[0] as ActionDefinition['steps'][number]),
  });
  const out = await runAction(
    aiCtx(),
    withAction(snap, decl),
    [],
    decl.key,
    { params: { to: '2026-09-30' } },
    NO_DEFER,
  );
  expect(out).toMatchObject({
    status: 'error',
    error: { code: 'VALIDATION', details: { reason: 'BATCH_TOO_LONG', cap: 100, found: 110 } },
  });
});

test('карточка действия исполнима approvePending уже сегодня: 11 целей — одной пачкой', async () => {
  // Последний в файле: принятие переносит сроки, и просроченных после него не остаётся.
  const out = await dispatchTool(aiCtx(), 'action_planner_postpone_overdue', { to: '2026-09-30' });
  if (out.status !== 'pending_confirmation') throw new Error(`ожидалась карточка: ${out.status}`);
  const applied = await approvePending(db, { identity: personal(owner), pendingId: out.pendingId });
  expect(applied.ok).toBe(true);
  const moved = await withIdentity(db, personal(owner), (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM entities
      WHERE props->>'orbis/due_date' = '2026-09-30'`),
  );
  expect(moved[0]?.n).toBe(11);
});

test('гейт шагов — ДО резолва: рутина без шага в allowed_tools и пустой Q → отказ, а не ok [] (М-2)', async () => {
  // Пакет, чей запрос пуст (ни одной записи `orbis/goal` у владельца нет): при гейте ПОСЛЕ
  // резолва ранний `ok []` ответил бы рутине без права раньше, чем «нельзя», — отказ по правам
  // зависел бы от данных.
  const snap = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  const postpone = snap.actions.get('planner/postpone_overdue');
  if (postpone === undefined) throw new Error('сидового действия нет в снимке');
  const decl = synthetic({
    params: postpone.params,
    over: { filter: { aspect: 'orbis/goal' } },
    batch_cap: 100,
    steps: postpone.steps,
  });
  const out = await runAction(
    routineCtx({ mode: 'act', allowedTools: ['run_action'] }),
    withAction(snap, decl),
    [],
    decl.key,
    { params: { to: '2026-09-30' } },
    NO_DEFER,
  );
  expect(out).toMatchObject({
    status: 'error',
    error: {
      code: 'FORBIDDEN_LEVEL',
      details: { reason: 'action_step_forbidden', tool: 'entity_update' },
    },
  });
  // Контроль: то же действие владельцу — пустой пакет, честный `ok []` без записи.
  const owned = await runAction(
    ownerCtx(),
    withAction(snap, decl),
    [],
    decl.key,
    { params: { to: '2026-09-30' } },
    NO_DEFER,
  );
  expect(owned).toEqual({ status: 'ok', result: [] });
});
