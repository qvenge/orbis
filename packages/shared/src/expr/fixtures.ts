/**
 * КОРПУС §С8-28 — единственное место, где вердикт тайп-чекера объявлен ДАННЫМИ, а не кодом
 * теста. Читают его `check.test.ts` (вердикт и полнота), `print.test.ts` (тексты положительных
 * фикстур обязаны различаться) и валидатор подписок сервера (задача 5).
 *
 * Мерка полноты — не «сколько фикстур», а «у каждой из 17 форм узла есть и позитив, и негатив,
 * и у каждого из четырёх кодов отказа есть фикстура»; проверяет её сам тест через
 * `exprFormsOf`. Поэтому строки ниже идут ПО ФОРМАМ в порядке `EXPR_FORMS`, а четыре именные
 * стоят в конце: две — про коды, которых формой не выразить, две — эталонные выражения спеки
 * целиком (набор `facts` §Б5-4 и `daily_pace` §Б5-4), на которых меряется и глубина дерева.
 *
 * Область («scope») пишется без `reg`: словари подставляет читатель — так корпус не тянет за
 * собой встроенные реестры и остаётся данными, а не сборкой.
 */
import type { ExprScope, ExprType } from './check';
import type { ExprCheckCode } from './codes';
import { EXPR_NOT_TOTAL, EXPR_RECURSION, EXPR_TYPE, SECOND_LANGUAGE } from './codes';

export interface ExprFixture {
  name: string;
  expr: unknown;
  scope: Partial<ExprScope>;
  verdict: { ok: true; type: ExprType } | { ok: false; code: ExprCheckCode };
}

const ok = (type: ExprType): { ok: true; type: ExprType } => ({ ok: true, type });
const no = (code: ExprCheckCode): { ok: false; code: ExprCheckCode } => ({ ok: false, code });

const MONEY: Partial<ExprScope> = { contract: 'orbis/money-movement' };
const ENV: Partial<ExprScope> = { contract: 'orbis/envelope' };
const WHEN: Partial<ExprScope> = { contract: 'orbis/when' };

const BOOLEAN = ok({ kind: 'boolean' });
const NUMBER = ok({ kind: 'number' });
const DATE = ok({ kind: 'date' });
const DECIMAL = ok({ kind: 'decimal' });

/**
 * Самоссылка литералом не записывается — только сборкой. Ради неё фикстуры и объявлены
 * функцией-строителем: цикл в JSON невыразим, и код `EXPR_RECURSION` иначе остался бы без
 * единого примера.
 */
function selfReferencing(): unknown {
  const cyclic: Record<string, unknown> = { op: 'not', args: [] };
  (cyclic.args as unknown[]).push(cyclic);
  return cyclic;
}

/**
 * Предикат набора `orbis/money-movement.sets.facts` (§Б5-4) — «случившееся движение денег».
 * Первый конъюнкт — `not(planned = true)`, а не `planned = false` (Р-К-29): он тотален в
 * обоих бэкендах одинаково и не требует, чтобы слот `planned` был связан у КАЖДОЙ привязки —
 * отсутствующее значение даёт `false` у сравнения и `true` у отрицания, ровно как оракул
 * `coalesce(planned, false) = false`.
 */
const FACTS_EXPR = {
  op: 'and',
  args: [
    { op: 'not', args: [{ op: '=', args: [{ slot: 'planned' }, { const: true }] }] },
    { op: '<=', args: [{ slot: 'date' }, { ctx: '$today' }] },
    {
      op: 'not',
      args: [
        { op: 'in', args: [{ class: { contract: 'orbis/recurrence' } }, { const: 'templates' }] },
      ],
    },
  ],
};

/** `daily_pace` §Б5-4 целиком — самое глубокое выражение спеки (7 уровней JSON). */
const DAILY_PACE = {
  op: 'if',
  args: [
    { phase: 'active' },
    {
      op: '/',
      args: [{ agg: 'remaining' }, { days_inclusive: [{ ctx: '$today' }, { slot: 'period_end' }] }],
    },
    { const: null },
  ],
};

export const EXPR_FIXTURES: readonly ExprFixture[] = [
  // const
  {
    name: 'const: строка — текст, decimal доводится соседом',
    expr: { const: '0.85' },
    scope: {},
    verdict: ok({ kind: 'text' }),
  },
  {
    name: 'const: дробное JSON-число — не decimal, а ошибка типа',
    expr: { op: '>=', args: [{ slot: 'amount' }, { const: 0.85 }] },
    scope: MONEY,
    verdict: no(EXPR_TYPE),
  },
  // duration
  {
    name: 'duration: сдвиг даты длительностью',
    expr: { date_add: [{ ctx: '$today' }, { duration: 'P1D' }] },
    scope: {},
    verdict: DATE,
  },
  {
    name: 'duration: длительность не сравнивается с числом',
    expr: { op: '>', args: [{ duration: 'P1D' }, { const: 1 }] },
    scope: {},
    verdict: no(EXPR_TYPE),
  },
  // prop
  {
    name: 'prop: свойство реестра сравнивается с ключом варианта',
    expr: { op: '=', args: [{ prop: 'orbis/task_status' }, { const: 'done' }] },
    scope: {},
    verdict: BOOLEAN,
  },
  {
    name: 'prop: свойства нет в реестре',
    expr: { prop: 'orbis/нет' },
    scope: {},
    verdict: no(EXPR_TYPE),
  },
  // slot
  {
    name: 'slot: слот контракта области',
    expr: { slot: 'amount' },
    scope: MONEY,
    verdict: DECIMAL,
  },
  {
    name: 'slot: слот вне области с контрактом невыразим',
    expr: { slot: 'amount' },
    scope: {},
    verdict: no(EXPR_TYPE),
  },
  // param
  {
    name: 'param: граница периода параметром подписки',
    expr: { op: '>=', args: [{ slot: 'date' }, { param: 'period_start' }] },
    scope: { contract: 'orbis/money-movement', params: { period_start: { kind: 'date' } } },
    verdict: BOOLEAN,
  },
  {
    name: 'param: параметра в области нет',
    expr: { param: 'нет' },
    scope: {},
    verdict: no(EXPR_TYPE),
  },
  // ctx
  { name: 'ctx: $today — дата', expr: { ctx: '$today' }, scope: {}, verdict: DATE },
  {
    name: 'ctx: $sensitivity вне assign_level',
    expr: { ctx: '$sensitivity' },
    scope: {},
    verdict: no(EXPR_TYPE),
  },
  // agg
  {
    name: 'agg: величина той же ведомости',
    expr: { agg: 'spent' },
    scope: { aggs: { spent: { kind: 'decimal' } } },
    verdict: DECIMAL,
  },
  {
    name: 'agg: величины в области нет',
    expr: { agg: 'spent' },
    scope: {},
    verdict: no(EXPR_TYPE),
  },
  // phase
  {
    name: 'phase: фаза ведомости — булев признак',
    expr: { phase: 'active' },
    scope: { phases: ['active'] },
    verdict: BOOLEAN,
  },
  {
    name: 'phase: признак фазы не складывается с числом',
    expr: { op: '+', args: [{ phase: 'active' }, { const: 1 }] },
    scope: { phases: ['active'] },
    verdict: no(EXPR_TYPE),
  },
  // agg_via
  {
    name: 'agg_via: опубликованная величина по ребру роли',
    expr: { agg_via: { role: 'envelope-binding', name: 'remaining' } },
    scope: {},
    verdict: DECIMAL,
  },
  {
    name: 'agg_via: ребра может не быть — арифметика над ним не тотальна',
    expr: {
      op: '+',
      args: [{ agg_via: { role: 'envelope-binding', name: 'remaining' } }, { const: '1' }],
    },
    scope: {},
    verdict: no(EXPR_NOT_TOTAL),
  },
  // deref
  {
    name: 'deref: чтение поля по ссылке там, где оно разрешено',
    expr: {
      op: '=',
      args: [{ deref: { slot: 'category', read: 'orbis/title' } }, { const: 'Еда' }],
    },
    scope: { contract: 'orbis/envelope', allowDeref: true },
    verdict: BOOLEAN,
  },
  {
    name: 'deref: в области без разрешения разыменования',
    expr: {
      op: '=',
      args: [{ deref: { slot: 'category', read: 'orbis/title' } }, { const: 'Еда' }],
    },
    scope: ENV,
    verdict: no(EXPR_TYPE),
  },
  // op
  {
    name: 'op: булева связка над двумя предикатами',
    expr: { op: 'and', args: [{ const: true }, { const: false }] },
    scope: {},
    verdict: BOOLEAN,
  },
  {
    name: 'op: аргумент связки — не предикат',
    expr: { op: 'and', args: [{ const: true }, { const: 1 }] },
    scope: {},
    verdict: no(EXPR_TYPE),
  },
  // has
  {
    name: 'has: наличие значения у необязательного слота',
    expr: { has: 'carryover' },
    scope: ENV,
    verdict: BOOLEAN,
  },
  {
    name: 'has: имени нет ни у свойства, ни у слота',
    expr: { has: 'нет-слота' },
    scope: ENV,
    verdict: no(EXPR_TYPE),
  },
  // has_relation
  {
    name: 'has_relation: входящее ребро роли с живым дальним концом',
    expr: { has_relation: { role: 'instance-of', alive: true } },
    scope: {},
    verdict: BOOLEAN,
  },
  {
    name: 'has_relation: набора у контракта дальнего конца нет',
    expr: { has_relation: { role: 'r', in_set: { contract: 'orbis/completable', set: 'нет' } } },
    scope: {},
    verdict: no(EXPR_TYPE),
  },
  // class
  {
    name: 'class: членство в именованном наборе контракта',
    expr: { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: 'open' }] },
    scope: {},
    verdict: BOOLEAN,
  },
  {
    name: 'class: у контракта фактов классов нет',
    expr: { class: { contract: 'orbis/sensitivity' } },
    scope: {},
    verdict: no(EXPR_TYPE),
  },
  // date_add
  {
    name: 'date_add: сдвиг сохраняет род даты',
    expr: { date_add: [{ ctx: '$today' }, { duration: 'P7D' }] },
    scope: {},
    verdict: DATE,
  },
  {
    name: 'date_add: число не длительность',
    expr: { date_add: [{ ctx: '$today' }, { const: 7 }] },
    scope: {},
    verdict: no(EXPR_TYPE),
  },
  // date_diff
  {
    name: 'date_diff: разность дат — число дней',
    expr: { date_diff: [{ ctx: '$today' }, { ctx: '$today' }] },
    scope: {},
    verdict: NUMBER,
  },
  {
    name: 'date_diff: срок задачи есть не всегда',
    expr: { date_diff: [{ slot: 'deadline' }, { ctx: '$today' }] },
    scope: WHEN,
    verdict: no(EXPR_NOT_TOTAL),
  },
  // days_inclusive
  {
    name: 'days_inclusive: дни периода с включёнными границами',
    expr: { days_inclusive: [{ ctx: '$today' }, { param: 'period_end' }] },
    scope: { params: { period_end: { kind: 'date' } } },
    verdict: NUMBER,
  },
  {
    name: 'days_inclusive: длительность вместо второй даты',
    expr: { days_inclusive: [{ ctx: '$today' }, { duration: 'P1D' }] },
    scope: {},
    verdict: no(EXPR_TYPE),
  },
  // Именные: коды, которые формой узла не выражаются, и два эталона спеки целиком.
  {
    name: 'второй язык: строка вместо дерева',
    expr: 'amount > 100',
    scope: MONEY,
    verdict: no(SECOND_LANGUAGE),
  },
  {
    name: 'самоссылка невыразима',
    expr: selfReferencing(),
    scope: {},
    verdict: no(EXPR_RECURSION),
  },
  { name: 'facts money-movement целиком', expr: FACTS_EXPR, scope: MONEY, verdict: BOOLEAN },
  {
    name: 'бюджет: daily_pace целиком',
    expr: DAILY_PACE,
    scope: {
      contract: 'orbis/envelope',
      aggs: { remaining: { kind: 'decimal' } },
      phases: ['active', 'upcoming', 'closed'],
    },
    verdict: DECIMAL,
  },
];
