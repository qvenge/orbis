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
import type { ActionSetInput } from '../../src/tools/registry-tools';

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
/**
 * Шаг ВЗВОДИТ РУТИНУ (`orbis/routine_mode: act`), а декларация `grants_autonomy` не объявила
 * (фикс-раунд 1, I-1): факт шага считается тем же `grantsRoutineAutonomy`, что поднимает уровень
 * вызова у политики (Р-И-25).
 */
export const GRANTS_AUTONOMY_UNDERDECLARED = {
  ...POSTPONE,
  key: 'planner/arm-routine',
  id: 'planner/arm-routine',
  params: [],
  over: null,
  batch_cap: null,
  offered_by: [],
  sensitivity: [],
  steps: [
    {
      tool: 'entity_update',
      input: { id: { $expr: { ctx: '$self' } }, props: { 'orbis/routine_mode': 'act' } },
    },
  ],
};
/**
 * Снятие выражением на месте ВСЕГО `unset` (фикс-раунд 2, N-1): тип позиции `list<text>`, конверт
 * такой вход пропускает, а какие свойства снимутся — до прогона неизвестно. Худший случай Р-9: и
 * деньги, и доверенность рутины; декларация без фактов — недообъявлена.
 */
export const UNSET_BY_EXPR_UNDERDECLARED = {
  ...GRANTS_AUTONOMY_UNDERDECLARED,
  key: 'planner/unset-by-expr',
  id: 'planner/unset-by-expr',
  steps: [
    {
      tool: 'entity_update',
      input: {
        id: { $expr: { ctx: '$self' } },
        unset: { $expr: { const: ['orbis/allowed_tools'] } },
      },
    },
  ],
};
/** Тип подстановки не сходится со свойством-целью: date-параметр в boolean `orbis/planned` (I-2). */
export const ACTION_VALUE_TYPE_MISMATCH = {
  ...P2F,
  key: 'finance/value-type',
  id: 'finance/value-type',
  steps: [
    {
      tool: 'entity_update',
      input: {
        id: { $expr: { ctx: '$self' } },
        props: { 'orbis/planned': { $expr: { param: 'occurred_on' } } },
      },
    },
  ],
};
/** Шаг пишет свойство, которого в реестре нет (I-2): записать его не выйдет ни на одном прогоне. */
export const ACTION_VALUE_UNKNOWN_PROPERTY = {
  ...P2F,
  key: 'finance/unknown-property',
  id: 'finance/unknown-property',
  steps: [
    {
      tool: 'entity_update',
      input: {
        id: { $expr: { ctx: '$self' } },
        props: { 'orbis/nope': 1, 'orbis/occurred_on': { $expr: { param: 'occurred_on' } } },
      },
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
  {
    name: 'шаг взводит рутину, grants_autonomy не объявлен',
    decl: GRANTS_AUTONOMY_UNDERDECLARED,
    verdict: { ok: false, code: 'SENSITIVITY_UNDERDECLARED' },
  },
  {
    name: 'шаг взводит рутину, grants_autonomy объявлен (позитив)',
    decl: {
      ...GRANTS_AUTONOMY_UNDERDECLARED,
      key: 'planner/arm-declared',
      id: 'planner/arm-declared',
      sensitivity: ['grants_autonomy'],
    },
    verdict: { ok: true },
  },
  {
    name: 'весь unset выражением, факты не объявлены',
    decl: UNSET_BY_EXPR_UNDERDECLARED,
    verdict: { ok: false, code: 'SENSITIVITY_UNDERDECLARED' },
  },
  {
    name: 'весь unset выражением, оба факта объявлены (позитив)',
    decl: {
      ...UNSET_BY_EXPR_UNDERDECLARED,
      key: 'planner/unset-declared',
      id: 'planner/unset-declared',
      sensitivity: ['touches_money', 'grants_autonomy'],
    },
    verdict: { ok: true },
  },
  {
    name: 'тип подстановки не сходится со свойством',
    decl: ACTION_VALUE_TYPE_MISMATCH,
    verdict: { ok: false, code: 'VALIDATION', reason: 'ACTION_VALUE_TYPE' },
  },
  {
    name: 'свойства шага нет в реестре',
    decl: ACTION_VALUE_UNKNOWN_PROPERTY,
    verdict: { ok: false, code: 'VALIDATION', reason: 'ACTION_VALUE_TYPE' },
  },
  {
    name: 'json-параметр',
    decl: {
      ...POSTPONE,
      key: 'planner/json-param',
      id: 'planner/json-param',
      params: [...POSTPONE.params, { name: 'blob', type: { kind: 'json' }, required: true }],
    },
    verdict: { ok: false, code: 'VALIDATION', reason: 'ACTION_MALFORMED' },
  },
  {
    name: 'маркер {$expr} с соседним ключом',
    decl: {
      ...P2F,
      key: 'finance/junk-marker',
      id: 'finance/junk-marker',
      steps: [
        {
          tool: 'entity_update',
          input: {
            id: { $expr: { ctx: '$self' }, junk: 1 },
            props: { 'orbis/occurred_on': { $expr: { param: 'occurred_on' } } },
          },
        },
      ],
    },
    verdict: { ok: false, code: 'VALIDATION', reason: 'ACTION_STEP_INPUT' },
  },
];

/**
 * СВОЯ ДЕКЛАРАЦИЯ ВЛАДЕЛЬЦА — вход тула `action_set` (задача 10: §Б6-1, Р-И-34). Форма — ВХОД ТУЛА, а
 * не строка реестра: `id`/`graphId`/`status`/`rank`/`module` проставляет операция (`setOwnAction`), и
 * фикстура, несущая их, проверяла бы не ту дверь. Одиночное действие над `$self`: срок задачи
 * переезжает на дату параметра — ни денег, ни доверенности, то есть позитив без побочных фактов.
 */
export const OWN_ACTION_DECL: ActionSetInput = {
  key: 'user/close-month',
  label: { ru: 'Закрыть месяц', en: 'Close month' },
  description: {
    ru: 'Перенести срок задачи на первое число следующего месяца.',
    en: 'Move the task due date to the first day of the next month.',
  },
  params: [{ name: 'on', type: { kind: 'date' }, required: true }],
  precondition: null,
  over: null,
  steps: [
    {
      tool: 'entity_update',
      input: {
        id: { $expr: { ctx: '$self' } },
        props: { 'orbis/due_date': { $expr: { param: 'on' } } },
      },
    },
  ],
  sensitivity: [],
  offered_by: [],
  batch_cap: null,
};
