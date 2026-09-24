// ВСТРОЕННЫЕ ДЕЙСТВИЯ (§Б6-5): модуль сеет своё действие строкой, а не кодом.
//
// Записи объявлены ВХОДНОЙ формой и разбираются схемой ЗДЕСЬ ЖЕ: умолчания (`status`,
// `rank`-независимые поля) проставляет та же схема, что и на чтении из БД, — иначе
// сид и снимок разошлись бы на первом же умолчании, и дрейф показал бы расхождение,
// которого в коде нет.
import {
  type ActionDefinition,
  type ActionDefinitionInput,
  actionDefinitionSchema,
  BATCH_CAP_DEFAULT,
} from './action-type';

/**
 * План → факт (§Б6-5, Финансы). Пять пречеков прежнего `confirmPurchase` переписаны предикатом E
 * целиком, и с задачи 9 ручка (`budget/plan-to-fact.ts`) — обёртка над этой строкой: принадлежность
 * аспекту выражается КЛАССОМ контракта (В-1 §4-В), проба порождения — `has_relation`
 * (Е-1, `relationPredicate` в `expr/compile.ts` — бэкенд есть).
 */
const PLAN_TO_FACT: ActionDefinitionInput = {
  id: 'finance/plan-to-fact',
  graphId: null,
  key: 'finance/plan-to-fact',
  label: { ru: 'План → факт', en: 'Plan to fact' },
  description: {
    ru: 'Отметить запланированное движение денег как случившееся: снять признак плана и проставить дату.',
    en: 'Mark a planned money movement as actual: clear the plan flag and set the date.',
  },
  params: [{ name: 'occurred_on', type: { kind: 'date' } }],
  precondition: {
    op: 'and',
    args: [
      {
        op: 'in',
        args: [{ class: { contract: 'orbis/money-movement' } }, { const: ['outflow', 'inflow'] }],
      },
      { op: 'not', args: [{ op: '=', args: [{ prop: 'orbis/archived' }, { const: true }] }] },
      { op: '=', args: [{ prop: 'orbis/planned' }, { const: true }] },
      {
        op: 'not',
        args: [
          {
            op: 'in',
            args: [{ class: { contract: 'orbis/recurrence' } }, { const: ['template'] }],
          },
        ],
      },
      { op: 'not', args: [{ has_relation: { role: 'instance-of' } }] },
    ],
  },
  over: null,
  steps: [
    {
      tool: 'entity_update',
      input: {
        id: { $expr: { ctx: '$self' } },
        props: { 'orbis/planned': false, 'orbis/occurred_on': { $expr: { param: 'occurred_on' } } },
      },
    },
  ],
  sensitivity: ['touches_money'],
  offered_by: [],
  module: 'finance',
  batch_cap: null,
  rank: 0,
};

/**
 * Отложить просроченные (Р-30, Планировщик) — первое ПАКЕТНОЕ действие: множество целей
 * даёт Q, дата-цель приезжает параметром. Кап написан явно (Р-К-14: у map-действия
 * `batch_cap` обязателен, подстановки валидатором нет).
 */
const POSTPONE_OVERDUE: ActionDefinitionInput = {
  id: 'planner/postpone_overdue',
  graphId: null,
  key: 'planner/postpone_overdue',
  label: { ru: 'Отложить просроченные', en: 'Postpone overdue' },
  description: {
    ru: 'Перенести срок всех просроченных открытых задач на указанную дату.',
    en: 'Move the due date of every overdue open task to a given date.',
  },
  params: [{ name: 'to', type: { kind: 'date' } }],
  precondition: null,
  over: {
    filter: {
      and: [
        { aspect: 'orbis/task' },
        { class: { contract: 'orbis/completable', set: 'open' } },
        { prop: 'orbis/due_date', op: 'lt', value: { token: 'today' } },
      ],
    },
  },
  steps: [
    {
      tool: 'entity_update',
      input: {
        id: { $expr: { ctx: '$self' } },
        props: { 'orbis/due_date': { $expr: { param: 'to' } } },
      },
    },
  ],
  sensitivity: [],
  offered_by: [{ llm: true }],
  module: 'planner',
  batch_cap: BATCH_CAP_DEFAULT,
  rank: 1,
};

export const BUILTIN_ACTION_DEFS: readonly ActionDefinition[] = [
  PLAN_TO_FACT,
  POSTPONE_OVERDUE,
].map((d) => actionDefinitionSchema.parse(d));
