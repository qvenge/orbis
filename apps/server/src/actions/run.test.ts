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
  // Карточка называет ДЕЙСТВИЕ, его масштаб и ПОВОД подтверждения, а не «batch_execute»:
  // владелец подтверждает группу (эррата Ф-Б2-18).
  expect(out.card).toMatchObject({
    kind: 'confirmation_card',
    mode: 'explicit',
    pendingId: out.pendingId,
    summary: 'Действие «Отложить просроченные» — 11 записей (повод: больше 10 записей за раз)',
  });
  // Строки «было → станет» резолва — в карточку чата тоже, по строке на цель.
  if (out.card.kind !== 'confirmation_card') throw new Error('не та карточка');
  expect(out.card.rows).toHaveLength(11);
  expect(out.card.rows?.[0]).toEqual({
    field: 'orbis/due_date',
    before: '2026-09-01',
    after: '2026-09-30',
  });
  // Запись несёт декларацию (§Б6-7) и цели с параметрами для перепроверки предусловия.
  const rec = (
    await withIdentity(db, personal(owner), (tx) =>
      tx.execute(
        sql`SELECT metadata->'pending' AS p FROM chat_messages WHERE id = ${out.pendingId}`,
      ),
    )
  )[0]?.p as Record<string, unknown>;
  expect([rec.tool, rec.action_id, typeof rec.action_hash]).toEqual([
    'batch_execute',
    'planner/postpone_overdue',
    'string',
  ]);
  expect(rec.action_targets).toEqual([...resolved.targets]);
  expect(rec.action_params).toEqual({ to: '2026-09-30' });
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

test('act-рутина с открытыми шагами исполняет одиночное действие; пакет на explicit — в hooks.defer с разобранным конвертом (Р-К-67)', async () => {
  const allowed = ['entity_update', 'run_action', 'action_planner_postpone_overdue'];
  const ok = await dispatchTool(
    routineCtx({ mode: 'act', allowedTools: allowed }),
    'run_action',
    PLAN_TO_FACT(plannedByRoutine),
  );
  expect(ok.status).toBe('ok');
  expect((await propsOf(plannedByRoutine))['orbis/planned']).toBe(false);
  // Пакет из 11 — explicit-confirmation; фону велена отложенная единица D42 (§Б6-2), и кладёт её
  // `deferRoutineUnit` диспатча через хук. Здесь — что ветка зовёт хук РОВНО одним вызовом и с
  // разобранным конвертом; сама единица с живой рутиной — `tools/dispatch.test.ts`
  // («отложенная единица ДЕЙСТВИЯ»).
  const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  const calls: Array<{ tool: string; payload: unknown }> = [];
  const deferred = await runAction(
    routineCtx({ mode: 'act', allowedTools: allowed }),
    reg,
    [],
    'planner/postpone_overdue',
    { params: { to: '2026-09-30' } },
    {
      defer: async (tool, payload) => {
        calls.push({ tool, payload });
        return { status: 'error', error: { code: 'DEFERRED', message: 'хук позван' } };
      },
    },
  );
  expect(deferred).toMatchObject({ status: 'error', error: { code: 'DEFERRED' } });
  expect(calls).toEqual([
    {
      tool: 'run_action',
      payload: { action: 'planner/postpone_overdue', params: { to: '2026-09-30' } },
    },
  ]);
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

test('фон: единица длиннее капа — BATCH_TOO_LONG ДО пре-чека и отложки, и на уровне preview тоже (эррата Ф-Б2-18)', async () => {
  // Десять целей × одиннадцать шагов = 110 операций. Уровень по таблице — `preview` (пакет не
  // больше десяти), но фону он тоже даёт единицу (§Б6-2), и её конверт держит кап сто: такую
  // карточку «Принять» не разобрало бы никогда. Хук отложки не зовётся (`NO_DEFER` ответил бы X).
  const snap = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  const postpone = snap.actions.get('planner/postpone_overdue');
  if (postpone === undefined) throw new Error('сидового действия нет в снимке');
  const decl = synthetic({
    params: postpone.params,
    over: {
      filter: {
        and: [{ aspect: 'orbis/task' }, { prop: 'orbis/due_date', op: 'lt', value: '2026-09-11' }],
      },
    },
    batch_cap: 100,
    steps: Array.from({ length: 11 }, () => postpone.steps[0] as ActionDefinition['steps'][number]),
  });
  const reg = withAction(snap, decl);
  const resolved = await withIdentity(db, personal(owner), (tx) =>
    resolveAction(tx, reg, owner, { action: decl.key, params: { to: '2026-09-30' } }, ARGS),
  );
  const facts = actionCallFacts(reg, decl, resolved.operations, resolved.targets, {
    actorKind: 'ai',
    explicitCommand: false,
  });
  expect([resolved.targets.length, classifyToolCall(facts)]).toEqual([10, 'preview']);
  const out = await runAction(
    routineCtx({ mode: 'act', allowedTools: ['entity_update', 'run_action'] }),
    reg,
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

test('гейт шагов — по КАЖДОМУ шагу, а не по первому: запрещён ВТОРОЙ шаг act-рутины → отказ, названный им (финал Б-2 E-4)', async () => {
  // Одношаговые пробы выше держат только `steps[0]`: регрессия «проверять первый шаг» проходила бы их
  // все. Здесь первый шаг рутине открыт, второй — нет; обёртка не провозит внутрь то, чего белый список
  // не называет (§Б6-2, §С2-2; докблок `run.ts` о `batch_execute`).
  const snap = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  const decl = synthetic({
    steps: [
      {
        tool: 'entity_create',
        input: { title: 'Сопутствующая заметка', tags: [], aspects: ['orbis/note'] },
      },
      {
        tool: 'entity_update',
        input: { id: { $expr: { ctx: '$self' } }, props: { 'orbis/planned': false } },
      },
    ],
  });
  const out = await runAction(
    routineCtx({ mode: 'act', allowedTools: ['entity_create', 'run_action'] }),
    withAction(snap, decl),
    [],
    decl.key,
    { self: plannedKept },
    NO_DEFER,
  );
  expect(out).toMatchObject({
    status: 'error',
    error: {
      code: 'FORBIDDEN_LEVEL',
      details: { reason: 'action_step_forbidden', tool: 'entity_update', mode: 'act' },
    },
  });
  expect((await propsOf(plannedKept))['orbis/planned']).toBe(true);
});

test('скоуп worker — тоже по КАЖДОМУ шагу: второй шаг вне WORKER_SCOPE_TOOLS → отказ, названный им (финал Б-2 E-4)', async () => {
  // Первый шаг — имя из `WORKER_SCOPE_TOOLS`. Законная декларация такого шага не несёт (шаги —
  // `ACTION_STEP_TOOLS` и `attach_*`, `assertAction`), поэтому регрессия «только первый шаг» в ветке
  // скоупа наблюдаема лишь синтетикой: тест пинит ЦИКЛ гейта, а не форму декларации.
  const snap = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  const decl = synthetic({
    steps: [
      { tool: 'thread_post', input: { text: 'ход' } },
      {
        tool: 'entity_update',
        input: { id: { $expr: { ctx: '$self' } }, props: { 'orbis/planned': false } },
      },
    ],
  });
  const grant = { id: newId(), scope: 'worker' as const, label: 'фон' };
  const out = await runAction(
    ctx({ actorKind: 'agent', source: 'mcp', grant }),
    withAction(snap, decl),
    [],
    decl.key,
    { self: plannedKept },
    NO_DEFER,
  );
  expect(out).toMatchObject({
    status: 'error',
    error: {
      code: 'FORBIDDEN_LEVEL',
      details: { reason: 'action_step_forbidden', tool: 'entity_update', scope: 'worker' },
    },
  });
  expect((await propsOf(plannedKept))['orbis/planned']).toBe(true);
});
