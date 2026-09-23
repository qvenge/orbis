/**
 * Корпус деклараций действий (§С8-24, жанр «декларация»): на каждый отказ `assertAction` —
 * вход и ожидаемый код. Данные, а не тесты: прогон живёт в `registry/actions.test.ts`, а
 * строки 3/15/18 корпуса 21 отказа (`test/fixtures/refusals.ts`) берут их же.
 *
 * Каждая порча — ОДНА правка сидовой декларации (ключ меняется вместе с ней: `assertAction` сверяет
 * занятость `key`, и порча под ключом встроенного действия мерила бы не то). Позитив — сами сидовые
 * декларации: корпус проверяет валидатор на том, что реально уезжает в базу, а не на своей копии.
 */
import { type ActionDefinition, actionToolName, BUILTIN_ACTION_DEFS } from '@orbis/shared';

/** Сидовая декларация по ключу; её отсутствие — дефект фикстуры, а не ветка пробы. */
function builtin(key: string): ActionDefinition {
  const d = BUILTIN_ACTION_DEFS.find((a) => a.key === key);
  if (d === undefined) throw new Error(`нет встроенного действия ${key}`);
  return d;
}
export const P2F = builtin('finance/plan-to-fact');
export const POSTPONE = builtin('planner/postpone_overdue');

export const ACTION_NESTED = {
  ...P2F,
  key: 'finance/nested',
  id: 'finance/nested',
  steps: [{ tool: 'run_action', input: { action: 'finance/plan-to-fact' } }],
};
/** Рулинг 6-1: имя тула действия — та же вложенность, что `run_action`. */
export const ACTION_NESTED_BY_TOOL = {
  ...P2F,
  key: 'finance/nested-tool',
  id: 'finance/nested-tool',
  steps: [{ tool: actionToolName(POSTPONE.key), input: { to: '2026-10-01' } }],
};
export const ACTION_BRANCH = {
  ...P2F,
  key: 'finance/branch',
  id: 'finance/branch',
  steps: [{ ...P2F.steps[0], when: { const: true } }],
};
export const BATCH_UNBOUNDED = {
  ...POSTPONE,
  key: 'planner/unbounded',
  id: 'planner/unbounded',
  batch_cap: null,
};
export const ACTION_CAP_WITHOUT_QUERY = {
  ...P2F,
  key: 'finance/capped',
  id: 'finance/capped',
  batch_cap: 10,
};
export const SENSITIVITY_UNDERDECLARED = {
  ...P2F,
  key: 'finance/silent',
  id: 'finance/silent',
  sensitivity: [],
};
/**
 * Тот же недообъявленный факт, но шагом `attach_*`: деньги пишутся в `data` КЛЮЧАМИ свойств (§А9-1),
 * и факт обязан считаться и там, а не только в `props` графового тула.
 */
export const SENSITIVITY_UNDERDECLARED_ATTACH = {
  ...P2F,
  key: 'finance/silent-attach',
  id: 'finance/silent-attach',
  params: [],
  precondition: null,
  sensitivity: [],
  steps: [
    {
      tool: 'attach_orbis_financial',
      input: { entity_id: { $expr: { ctx: '$self' } }, data: { 'orbis/amount': '1.00' } },
    },
  ],
};
export const ACTION_PARAM_UNUSED = {
  ...POSTPONE,
  key: 'planner/unused',
  id: 'planner/unused',
  params: [...POSTPONE.params, { name: 'reason', type: { kind: 'text' }, required: true }],
};
export const ACTION_STEP_TOOL = {
  ...P2F,
  key: 'finance/registry-step',
  id: 'finance/registry-step',
  steps: [{ tool: 'property_update', input: { id: 'orbis/amount', status: 'active' } }],
};
/** Рулинг 6-1: реестровый тул действий (задача 10) в шаге — «шаг вне словаря», а не вложенность. */
export const ACTION_STEP_REGISTRY_ACTION_TOOL = {
  ...P2F,
  key: 'finance/action-set-step',
  id: 'finance/action-set-step',
  steps: [{ tool: 'action_set', input: { key: 'user/x' } }],
};

export const ACTION_FIXTURES: readonly {
  name: string;
  decl: unknown;
  verdict: { ok: true } | { ok: false; code: string; reason?: string };
}[] = [
  { name: 'plan-to-fact (позитив)', decl: P2F, verdict: { ok: true } },
  { name: 'postpone_overdue (позитив)', decl: POSTPONE, verdict: { ok: true } },
  // Лишний объявленный факт законен (§Б6-1: декларация факты только ДОБАВЛЯЕТ) — это позитив, а не порча.
  {
    name: 'лишний объявленный факт (позитив)',
    decl: {
      ...P2F,
      key: 'finance/loud',
      id: 'finance/loud',
      sensitivity: ['touches_money', 'external'],
    },
    verdict: { ok: true },
  },
  {
    name: 'вложенное действие',
    decl: ACTION_NESTED,
    verdict: { ok: false, code: 'ACTION_NESTED' },
  },
  {
    name: 'тул действия в шаге',
    decl: ACTION_NESTED_BY_TOOL,
    verdict: { ok: false, code: 'ACTION_NESTED' },
  },
  { name: 'условие на шаге', decl: ACTION_BRANCH, verdict: { ok: false, code: 'ACTION_BRANCH' } },
  {
    name: 'пачка без капа',
    decl: BATCH_UNBOUNDED,
    verdict: { ok: false, code: 'BATCH_UNBOUNDED' },
  },
  {
    name: 'кап у одиночного',
    decl: ACTION_CAP_WITHOUT_QUERY,
    verdict: { ok: false, code: 'VALIDATION', reason: 'ACTION_CAP_WITHOUT_QUERY' },
  },
  {
    name: 'факт шага не объявлен',
    decl: SENSITIVITY_UNDERDECLARED,
    verdict: { ok: false, code: 'SENSITIVITY_UNDERDECLARED' },
  },
  {
    name: 'факт шага attach не объявлен',
    decl: SENSITIVITY_UNDERDECLARED_ATTACH,
    verdict: { ok: false, code: 'SENSITIVITY_UNDERDECLARED' },
  },
  {
    name: 'параметр никто не читает',
    decl: ACTION_PARAM_UNUSED,
    verdict: { ok: false, code: 'VALIDATION', reason: 'ACTION_PARAM_UNUSED' },
  },
  {
    name: 'реестровый тул в шаге',
    decl: ACTION_STEP_TOOL,
    verdict: { ok: false, code: 'VALIDATION', reason: 'ACTION_STEP_TOOL' },
  },
  {
    name: 'реестровый тул действий в шаге',
    decl: ACTION_STEP_REGISTRY_ACTION_TOOL,
    verdict: { ok: false, code: 'VALIDATION', reason: 'ACTION_STEP_TOOL' },
  },
];
