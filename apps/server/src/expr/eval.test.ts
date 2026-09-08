// apps/server/src/expr/eval.test.ts
// Decimal-бэкенд языка E (§Б3-5, задача 8): интерпретатор формул ведомостей. Тесты чистые —
// значения приходят готовыми (props/params/aggs), БД не нужна. Эталон бит-в-бит — четыре формулы
// `budget/aggregates.ts` (:342, :363, :365-368, :390-392), они переписаны здесь дословно, а не
// импортированы: `aggregates.ts` тянет за собой db/client и executor, а сверять надо АРИФМЕТИКУ.
import { describe, expect, test } from 'bun:test';
import { BUDGET_DEF, daysInclusive, type ResolvedBinding } from '@orbis/shared';
import {
  EXPR_TREE_DEPTH_CAP,
  type ExprNode,
  type ExprScalar,
  exprNodeSchema,
} from '@orbis/shared/expr';
import { decAdd, decCmp, decDivBy, decMulInt, decSub } from '../budget/decimal';
import { ExecError } from '../errors';
import { type ExprEvalScope, evalExpr } from './eval';

const TODAY = '2026-05-15';

/** Привязка `orbis/financial` → `orbis/money-movement` — та же, что сеет задача 2 (реестр §1.4). */
const MOVEMENT_BINDING: ResolvedBinding = {
  aspectId: 'orbis/financial',
  contract: 'orbis/money-movement',
  bind: {
    amount: 'orbis/amount',
    direction: 'orbis/direction',
    category: 'orbis/finance_category',
    date: 'orbis/occurred_on',
    planned: 'orbis/planned',
  },
  fixed: {},
  classOfVariant: new Map([
    [
      'direction',
      new Map([
        ['expense', 'outflow'],
        ['income', 'inflow'],
      ]),
    ],
  ]),
  variantsOfClass: new Map([
    [
      'direction',
      new Map([
        ['outflow', ['expense']],
        ['inflow', ['income']],
      ]),
    ],
  ]),
  requiredSlots: ['amount', 'direction', 'category', 'date'],
};

/** Привязка `orbis/budget` → `orbis/envelope` (реестр §1.4). */
const ENVELOPE_BINDING: ResolvedBinding = {
  aspectId: 'orbis/budget',
  contract: 'orbis/envelope',
  bind: {
    category: 'orbis/finance_category',
    limit: 'orbis/limit',
    currency: 'orbis/currency',
    period_start: 'orbis/period_start',
    period_end: 'orbis/period_end',
    carryover: 'orbis/carryover',
  },
  fixed: {},
  classOfVariant: new Map(),
  variantsOfClass: new Map(),
  requiredSlots: ['category', 'limit', 'period_start', 'period_end'],
};

function scopeOf(over: Partial<ExprEvalScope> = {}): ExprEvalScope {
  return { params: {}, aggs: {}, phase: null, props: {}, today: TODAY, ...over };
}

/** Код и причина структурного отказа — ровно так, как их читает executor (§9.2). */
function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExecError)
      return `${e.code}/${String((e.details as { reason?: string }).reason)}`;
    throw e;
  }
  throw new Error('отказа не было, а ожидался');
}

describe('evalExpr: значения-листья', () => {
  test('const и duration — как написаны; decimal-литерал остаётся строкой (ревизия 3)', () => {
    expect(evalExpr({ const: '0.85' }, scopeOf())).toBe('0.85');
    expect(evalExpr({ const: 14 }, scopeOf())).toBe(14);
    expect(evalExpr({ const: null }, scopeOf())).toBeNull();
    expect(evalExpr({ const: ['template'] }, scopeOf())).toEqual(['template']);
    expect(evalExpr({ duration: 'P1D' }, scopeOf())).toBe('P1D');
  });

  test('prop — значение props по id; отсутствующее — null, а не отказ (§Б3-4)', () => {
    const scope = scopeOf({ props: { 'orbis/amount': '1200.00', 'orbis/planned': false } });
    expect(evalExpr({ prop: 'orbis/amount' }, scope)).toBe('1200.00');
    expect(evalExpr({ prop: 'orbis/planned' }, scope)).toBe(false);
    expect(evalExpr({ prop: 'orbis/currency' }, scope)).toBeNull();
  });

  test('slot — через привязку области: bind → свойство, fixed → значение декларации', () => {
    const scope = scopeOf({
      props: { 'orbis/amount': '1200.00' },
      binding: { ...MOVEMENT_BINDING, fixed: { origin_role: 'instance-of' } },
    });
    expect(evalExpr({ slot: 'amount' }, scope)).toBe('1200.00');
    expect(evalExpr({ slot: 'origin_role' }, scope)).toBe('instance-of');
    // Слот, который привязка не реализует (§Б2-3 — необязательный можно не связывать), —
    // ОТСУТСТВИЕ значения: `has(slot)` обязан ответить «нет», а не упасть.
    expect(evalExpr({ slot: 'currency' }, scope)).toBeNull();
    // Слот вне области с контрактом — дефект декларации, а не отсутствие значения.
    expect(reasonOf(() => evalExpr({ slot: 'amount' }, scopeOf()))).toBe('VALIDATION/EXPR_SCOPE');
  });

  test('param и agg — из ведомости; имя вне области — структурный отказ, не null', () => {
    const scope = scopeOf({ params: { period_end: '2026-05-31' }, aggs: { spent: '2680.00' } });
    expect(evalExpr({ param: 'period_end' }, scope)).toBe('2026-05-31');
    expect(evalExpr({ agg: 'spent' }, scope)).toBe('2680.00');
    expect(reasonOf(() => evalExpr({ param: 'horizon_end' }, scope))).toBe('VALIDATION/EXPR_SCOPE');
    expect(reasonOf(() => evalExpr({ agg: 'remaining' }, scope))).toBe('VALIDATION/EXPR_SCOPE');
  });

  test('phase — БУЛЕВ узел «ведомость в этой фазе» (Р-И-16), а не строка', () => {
    expect(evalExpr({ phase: 'active' }, scopeOf({ phase: 'active' }))).toBe(true);
    expect(evalExpr({ phase: 'active' }, scopeOf({ phase: 'closed' }))).toBe(false);
    expect(evalExpr({ phase: 'active' }, scopeOf({ phase: null }))).toBe(false);
  });

  test('ctx: $today — из области; три остальных контекста этот бэкенд не отдаёт', () => {
    expect(evalExpr({ ctx: '$today' }, scopeOf())).toBe(TODAY);
    for (const ctx of ['$owner', '$self', '$sensitivity'] as const) {
      expect(`${ctx}: ${reasonOf(() => evalExpr({ ctx }, scopeOf()))}`).toBe(
        `${ctx}: VALIDATION/EXPR_BACKEND_UNSUPPORTED`,
      );
    }
  });

  test('узлы графа (class/has_relation/agg_via) — отказ бэкенда, а не тихое значение (§С8-3)', () => {
    const nodes: ExprNode[] = [
      { class: { contract: 'orbis/recurrence' } },
      { has_relation: { role: 'instance-of' } },
      { agg_via: { role: 'envelope-binding', name: 'remaining' } },
    ];
    for (const node of nodes) {
      expect(reasonOf(() => evalExpr(node, scopeOf()))).toBe('VALIDATION/EXPR_BACKEND_UNSUPPORTED');
    }
  });
});

describe('evalExpr: сравнения и семантика отсутствия (§Б3-4)', () => {
  test('decimal сравнивается численно, а не лексикографически', () => {
    const s = scopeOf({ aggs: { spent: '900.00', limit: '850' } });
    expect(evalExpr({ op: '>', args: [{ agg: 'spent' }, { agg: 'limit' }] }, s)).toBe(true);
    expect(evalExpr({ op: '=', args: [{ const: '850.0' }, { const: '850.00' }] }, scopeOf())).toBe(
      true,
    );
    // Числа и decimal-строки рядом в `=` не пинятся: чекер такую пару не пускает до рантайма вовсе —
    // отказ приходит на унификации типов («операнды одного типа»: `coerce` доводит строковый литерал до
    // decimal/date, но не до number), а не из множества EQUATABLE; пин здесь обещал бы контракт, которого нет.
  });

  test('даты сравниваются лексикографически — у ISO это и есть хронология (phaseOf, :350-353)', () => {
    const s = scopeOf({
      props: { 'orbis/period_start': '2026-05-01', 'orbis/period_end': '2026-05-31' },
      binding: ENVELOPE_BINDING,
    });
    expect(evalExpr({ op: '<', args: [{ ctx: '$today' }, { slot: 'period_start' }] }, s)).toBe(
      false,
    );
    expect(evalExpr({ op: '>', args: [{ ctx: '$today' }, { slot: 'period_end' }] }, s)).toBe(false);
    expect(evalExpr({ op: '<=', args: [{ slot: 'period_start' }, { ctx: '$today' }] }, s)).toBe(
      true,
    );
  });

  test('сравнение с отсутствующим — ЛОЖЬ у всех шести операторов, `!=` включительно (fail-closed)', () => {
    const s = scopeOf({ props: {} });
    for (const op of ['=', '!=', '>', '<', '>=', '<='] as const) {
      expect(
        `${op}: ${String(evalExpr({ op, args: [{ prop: 'orbis/amount' }, { const: '0' }] }, s))}`,
      ).toBe(`${op}: false`);
    }
  });

  test('boolean: равенство работает, порядковое сравнение — отказ, а не приведение к 0/1', () => {
    const s = scopeOf({ props: { 'orbis/planned': false }, binding: MOVEMENT_BINDING });
    expect(evalExpr({ op: '=', args: [{ slot: 'planned' }, { const: false }] }, s)).toBe(true);
    expect(evalExpr({ op: '!=', args: [{ slot: 'planned' }, { const: true }] }, s)).toBe(true);
    expect(
      reasonOf(() => evalExpr({ op: '>', args: [{ slot: 'planned' }, { const: false }] }, s)),
    ).toBe('VALIDATION/EXPR_VALUE');
  });

  test('арность бинарного оператора проверяется до вычисления аргументов', () => {
    expect(reasonOf(() => evalExpr({ op: '=', args: [{ const: 1 }] }, scopeOf()))).toBe(
      'VALIDATION/EXPR_VALUE',
    );
  });
});

describe('evalExpr: арифметика', () => {
  test('decimal — через budget/decimal.ts, без float', () => {
    expect(evalExpr({ op: '+', args: [{ const: '0.1' }, { const: '0.2' }] }, scopeOf())).toBe(
      '0.30',
    );
    expect(
      evalExpr({ op: '-', args: [{ const: '31200.00' }, { const: '2680.00' }] }, scopeOf()),
    ).toBe('28520.00');
    expect(evalExpr({ op: '*', args: [{ const: '1000.00' }, { const: '0.85' }] }, scopeOf())).toBe(
      '850.0000',
    );
  });

  test('целые остаются целыми: дни складываются числом, а не decimal-строкой', () => {
    expect(evalExpr({ op: '+', args: [{ const: 14 }, { const: 1 }] }, scopeOf())).toBe(15);
    expect(evalExpr({ op: '-', args: [{ const: 17 }, { const: 1 }] }, scopeOf())).toBe(16);
    expect(evalExpr({ op: '*', args: [{ const: 7 }, { const: 2 }] }, scopeOf())).toBe(14);
  });

  test('деление ВСЕГДА даёт decimal (§Б5-4 daily_pace) и совпадает с decDivBy', () => {
    expect(evalExpr({ op: '/', args: [{ const: '28520.00' }, { const: 17 }] }, scopeOf())).toBe(
      decDivBy('28520.00', 17),
    );
    expect(evalExpr({ op: '/', args: [{ const: '1' }, { const: '3' }] }, scopeOf())).toBe('0.33');
  });

  test('RangeError арифметики — структурный отказ VALIDATION/EXPR_ARITH, а не пятисотка', () => {
    expect(
      reasonOf(() => evalExpr({ op: '/', args: [{ const: '10' }, { const: 0 }] }, scopeOf())),
    ).toBe('VALIDATION/EXPR_ARITH');
    expect(
      reasonOf(() => evalExpr({ op: '+', args: [{ const: 'банан' }, { const: '1' }] }, scopeOf())),
    ).toBe('VALIDATION/EXPR_ARITH');
  });

  test('арифметика над отсутствующим — отказ, а не подстановка нуля (§Б3-4: ловит чекер)', () => {
    expect(
      reasonOf(() =>
        evalExpr({ op: '+', args: [{ prop: 'orbis/carryover' }, { const: '1' }] }, scopeOf()),
      ),
    ).toBe('VALIDATION/EXPR_ARITH');
  });

  test('бюджет вычисления §Б3-2: дерево глубже EXPR_TREE_DEPTH_CAP — отказ, а не переполнение стека', () => {
    let node: ExprNode = { const: '1' };
    for (let i = 0; i <= EXPR_TREE_DEPTH_CAP; i += 1)
      node = { op: '+', args: [node, { const: '0' }] };
    expect(reasonOf(() => evalExpr(node, scopeOf()))).toBe('VALIDATION/EXPR_DEPTH');
  });
});

describe('evalExpr: булева логика, in, has', () => {
  test('and/or короткозамкнуты: правое плечо не считается, если левое решило', () => {
    // Правое плечо — деление на ноль: посчитайся оно, был бы отказ вместо false/true.
    const bomb: ExprNode = {
      op: '>',
      args: [{ op: '/', args: [{ const: '1' }, { const: 0 }] }, { const: '0' }],
    };
    expect(evalExpr({ op: 'and', args: [{ const: false }, bomb] }, scopeOf())).toBe(false);
    expect(evalExpr({ op: 'or', args: [{ const: true }, bomb] }, scopeOf())).toBe(true);
    expect(
      evalExpr(
        { op: 'and', args: [{ const: true }, { const: true }, { const: false }] },
        scopeOf(),
      ),
    ).toBe(false);
  });

  test('not и отсутствующее булево: null в булевой позиции — ложь (fail-closed §Б3-4)', () => {
    expect(evalExpr({ op: 'not', args: [{ const: false }] }, scopeOf())).toBe(true);
    expect(
      evalExpr({ op: 'and', args: [{ prop: 'orbis/planned' }, { const: true }] }, scopeOf()),
    ).toBe(false);
    expect(reasonOf(() => evalExpr({ op: 'not', args: [{ const: '1' }] }, scopeOf()))).toBe(
      'VALIDATION/EXPR_VALUE',
    );
    expect(
      reasonOf(() => evalExpr({ op: 'not', args: [{ const: true }, { const: true }] }, scopeOf())),
    ).toBe('VALIDATION/EXPR_VALUE');
  });

  test('in — членство в явном списке классов/тегов; отсутствующее слева — false', () => {
    const s = scopeOf({ props: { 'orbis/direction': 'expense' } });
    expect(
      evalExpr(
        { op: 'in', args: [{ prop: 'orbis/direction' }, { const: ['expense', 'transfer'] }] },
        s,
      ),
    ).toBe(true);
    expect(
      evalExpr({ op: 'in', args: [{ prop: 'orbis/direction' }, { const: ['income'] }] }, s),
    ).toBe(false);
    expect(evalExpr({ op: 'in', args: [{ prop: 'orbis/currency' }, { const: ['RUB'] }] }, s)).toBe(
      false,
    );
    expect(
      reasonOf(() => evalExpr({ op: 'in', args: [{ const: 'x' }, { const: 'x' }] }, scopeOf())),
    ).toBe('VALIDATION/EXPR_VALUE');
  });

  test('has — единственный предикат присутствия (§Б3-4): по id свойства и по имени слота', () => {
    const s = scopeOf({ props: { 'orbis/limit': '1000.00' }, binding: ENVELOPE_BINDING });
    expect(evalExpr({ has: 'orbis/limit' }, s)).toBe(true);
    expect(evalExpr({ has: 'limit' }, s)).toBe(true);
    expect(evalExpr({ has: 'carryover' }, s)).toBe(false);
    expect(evalExpr({ has: 'orbis/carryover' }, s)).toBe(false);
  });
});

describe('evalExpr: умолчание реестра — семантика ЧТЕНИЯ (РП-9, §Б3-4)', () => {
  /**
   * Ровно то, что построит движок ведомостей (задача 9) из `reg.properties`: единственные два свойства
   * с объявленным умолчанием сегодня — `orbis/planned` и `orbis/may_close`
   * (`builtin-properties.ts:427/:772`, `type: { kind: 'boolean', default: false }`).
   */
  const DEFAULTS: ReadonlyMap<string, ExprScalar> = new Map<string, ExprScalar>([
    ['orbis/planned', false],
  ]);

  test('свойство с объявленным default читается умолчанием — и по id, и через слот', () => {
    const s = scopeOf({ props: {}, binding: MOVEMENT_BINDING, defaults: DEFAULTS });
    expect(evalExpr({ prop: 'orbis/planned' }, s)).toBe(false);
    expect(evalExpr({ slot: 'planned' }, s)).toBe(false);
  });

  test('паритет с SQL-бэкендом: `planned = false` у движения БЕЗ свойства — истина у обоих', () => {
    // SQL пишет `COALESCE((e.props->>'orbis/planned')::boolean, false) = false` (`castedExpr`
    // `query/compile-ast.ts`) и на движении без `orbis/planned` отвечает TRUE. Пока умолчания
    // здесь не было, интерпретатор на том же выражении отвечал FALSE: одна декларация — два ответа,
    // и `spent` конверта расходился бы с оракулом (`aggregates.ts` коалесит так же).
    const s = scopeOf({ props: {}, binding: MOVEMENT_BINDING, defaults: DEFAULTS });
    expect(evalExpr({ op: '=', args: [{ slot: 'planned' }, { const: false }] }, s)).toBe(true);
    expect(
      evalExpr({ op: 'not', args: [{ op: '=', args: [{ slot: 'planned' }, { const: true }] }] }, s),
    ).toBe(true);
    // Записанное значение умолчание не перебивает.
    const planned = scopeOf({
      props: { 'orbis/planned': true },
      binding: MOVEMENT_BINDING,
      defaults: DEFAULTS,
    });
    expect(evalExpr({ op: '=', args: [{ slot: 'planned' }, { const: false }] }, planned)).toBe(
      false,
    );
  });

  test('свойство БЕЗ объявленного default живёт по §Б3-4: сравнение с отсутствующим — ложь', () => {
    // `orbis/all_day` умолчания не объявляет, и приписать ему `false` значило бы выдать «поля нет» за
    // «выключено» (докблок `compile-ast.ts` — тот же довод в SQL-бэкенде).
    const s = scopeOf({ props: {}, defaults: DEFAULTS });
    expect(evalExpr({ prop: 'orbis/all_day' }, s)).toBeNull();
    expect(evalExpr({ op: '=', args: [{ prop: 'orbis/all_day' }, { const: false }] }, s)).toBe(
      false,
    );
    // Арифметика над отсутствующим БЕЗ умолчания — по-прежнему отказ (§Б3-4 дословно: «без `default`»).
    expect(
      reasonOf(() => evalExpr({ op: '+', args: [{ prop: 'orbis/carryover' }, { const: '1' }] }, s)),
    ).toBe('VALIDATION/EXPR_ARITH');
  });

  test('`has` умолчания НЕ видит: спрашивают про ЗАПИСАННОЕ значение, а не про прочитанное', () => {
    // `registry/types.ts:153-155`: «на записи он не материализуется, иначе `has(orbis/planned)` стал бы
    // истинным у каждой транзакции». Бэкенд обязан дать тот же ответ, иначе `if(has(x), …)` деклараций
    // §Б5-4 поехал бы у каждого свойства с умолчанием.
    const s = scopeOf({ props: {}, binding: MOVEMENT_BINDING, defaults: DEFAULTS });
    expect(evalExpr({ has: 'planned' }, s)).toBe(false);
    expect(evalExpr({ has: 'orbis/planned' }, s)).toBe(false);
    const written = scopeOf({
      props: { 'orbis/planned': false },
      binding: MOVEMENT_BINDING,
      defaults: DEFAULTS,
    });
    expect(evalExpr({ has: 'planned' }, written)).toBe(true);
  });

  test('карты умолчаний в области нет — прежняя семантика §Б3-4 без единого изменения', () => {
    const s = scopeOf({ props: {}, binding: MOVEMENT_BINDING });
    expect(evalExpr({ slot: 'planned' }, s)).toBeNull();
    expect(evalExpr({ op: '=', args: [{ slot: 'planned' }, { const: false }] }, s)).toBe(false);
  });
});

describe('evalExpr: арифметика дат (§Б3-2: date_add / date_diff / days_inclusive)', () => {
  test('date_diff — знаковое число дней ОТ первой даты К второй (тот же порядок, что у days_inclusive)', () => {
    expect(
      evalExpr({ date_diff: [{ const: '2026-05-01' }, { const: '2026-05-31' }] }, scopeOf()),
    ).toBe(30);
    expect(
      evalExpr({ date_diff: [{ const: '2026-05-31' }, { const: '2026-05-01' }] }, scopeOf()),
    ).toBe(-30);
    expect(evalExpr({ date_diff: [{ ctx: '$today' }, { ctx: '$today' }] }, scopeOf())).toBe(0);
  });

  test('days_inclusive — ТА ЖЕ функция, что у Budget: одна календарная арифметика', () => {
    expect(
      evalExpr({ days_inclusive: [{ ctx: '$today' }, { const: '2026-05-31' }] }, scopeOf()),
    ).toBe(daysInclusive(TODAY, '2026-05-31'));
    expect(
      evalExpr({ days_inclusive: [{ const: '2026-05-31' }, { ctx: '$today' }] }, scopeOf()),
    ).toBe(0);
  });

  test('date_add дневной гранулярности: дни и недели; у момента сдвигается календарная голова', () => {
    expect(evalExpr({ date_add: [{ const: '2026-05-15' }, { duration: 'P1D' }] }, scopeOf())).toBe(
      '2026-05-16',
    );
    expect(evalExpr({ date_add: [{ const: '2026-02-28' }, { duration: 'P1D' }] }, scopeOf())).toBe(
      '2026-03-01',
    );
    expect(evalExpr({ date_add: [{ const: '2026-05-15' }, { duration: 'P2W' }] }, scopeOf())).toBe(
      '2026-05-29',
    );
    expect(
      evalExpr({ date_add: [{ const: '2026-05-15T09:30:00Z' }, { duration: 'P1D' }] }, scopeOf()),
    ).toBe('2026-05-16T09:30:00Z');
  });

  test('годы, месяцы и время суток этот бэкенд не сдвигает — отказ с причиной, а не тихий результат', () => {
    for (const duration of ['P1M', 'P1Y', 'PT1H', 'P1DT12H']) {
      expect(
        `${duration}: ${reasonOf(() => evalExpr({ date_add: [{ const: '2026-05-15' }, { duration }] }, scopeOf()))}`,
      ).toBe(`${duration}: VALIDATION/EXPR_BACKEND_UNSUPPORTED`);
    }
  });

  test('что схема узла принимает, то бэкенд либо считает, либо отказывает названной причиной', () => {
    // Пин против расхождения разбора длительности с формой схемы (`expr/ast.ts`, задача 3).
    expect(exprNodeSchema.safeParse({ duration: 'P1D' }).success).toBe(true);
    expect(exprNodeSchema.safeParse({ duration: 'P' }).success).toBe(false);
    expect(
      reasonOf(() =>
        evalExpr({ date_add: [{ const: '2026-05-15' }, { duration: 'P' }] }, scopeOf()),
      ),
    ).toBe('VALIDATION/EXPR_ARITH');
  });

  test('несуществующая дата и отсутствующий операнд — EXPR_ARITH, а не тихая нормализация', () => {
    expect(
      reasonOf(() =>
        evalExpr({ days_inclusive: [{ const: '2026-02-30' }, { ctx: '$today' }] }, scopeOf()),
      ),
    ).toBe('VALIDATION/EXPR_ARITH');
    expect(
      reasonOf(() =>
        evalExpr({ date_diff: [{ prop: 'orbis/due_date' }, { ctx: '$today' }] }, scopeOf()),
      ),
    ).toBe('VALIDATION/EXPR_ARITH');
  });
});

/**
 * Формулы берутся ИЗ САМОЙ ДЕКЛАРАЦИИ (`BUDGET_DEF`, норматив §Б5-4), а не переписываются рядом:
 * копия рядом делала бы заголовок «то, что сеет задача 9» обещанием, а не фактом, и расхождение
 * декларации с оракулом (охрана `remaining >= "0"` у `daily_pace` — рулинг Ф-Б1-34) этот сьют бы
 * проспал. Порог тревоги декларация задаёт не выражением, а числом (`alerts.warn_at`), и сравнение
 * из него собирает движок — здесь собрано так же, из того же поля.
 */
function seededFormula(name: string): ExprNode {
  const agg = BUDGET_DEF.aggregates[name];
  if (agg === undefined || agg.kind !== 'formula') {
    throw new Error(`величина '${name}' в BUDGET_DEF не формула`);
  }
  return agg.expr;
}

const EFFECTIVE_LIMIT = seededFormula('effective_limit');
const REMAINING = seededFormula('remaining');
const DAILY_PACE = seededFormula('daily_pace');
const ALERT: ExprNode = {
  op: '>=',
  args: [
    { agg: 'spent' },
    { op: '*', args: [{ agg: 'effective_limit' }, { const: BUDGET_DEF.alerts.warn_at }] },
  ],
};

describe('evalExpr: формулы Budget §Б5-4 бит-в-бит с aggregates.ts', () => {
  const ENVELOPES = [
    {
      name: 'активный с carryover',
      limit: '30000.00',
      carryover: '1200.00',
      spent: '2680.00',
      periodEnd: '2026-05-31',
      phase: 'active',
    },
    {
      name: 'без carryover',
      limit: '30000.00',
      carryover: undefined,
      spent: '2680.00',
      periodEnd: '2026-05-31',
      phase: 'active',
    },
    {
      name: 'отрицательный carryover (§2.6)',
      limit: '30000.00',
      carryover: '-800.00',
      spent: '29500.00',
      periodEnd: '2026-05-31',
      phase: 'active',
    },
    {
      name: 'перерасход — pace null',
      limit: '1000.00',
      carryover: undefined,
      spent: '1500.00',
      periodEnd: '2026-05-31',
      phase: 'active',
    },
    {
      name: 'закрытый период',
      limit: '1000.00',
      carryover: undefined,
      spent: '500.00',
      periodEnd: '2026-04-30',
      phase: 'closed',
    },
    {
      name: 'upcoming',
      limit: '1000.00',
      carryover: undefined,
      spent: '0.00',
      periodEnd: '2026-06-30',
      phase: 'upcoming',
    },
    {
      name: 'ровно 85 % — бейдж включительно',
      limit: '1000.00',
      carryover: undefined,
      spent: '850.00',
      periodEnd: '2026-05-31',
      phase: 'active',
    },
    {
      // Свидетель запрета округлять `decMul`: 0.85 · 100.04 = 85.034, округлённое — 85.03, и
      // spent = 85.03 из «не тревога» (оракул: 20·85.03 = 1700.60 < 17·100.04 = 1700.68) стал бы
      // «тревога». На 100.01 вердикт не менялся бы — округление там идёт ВВЕРХ.
      name: 'копеечный лимит: 0.85 · 100.04 = 85.034 — округление сменило бы вердикт',
      limit: '100.04',
      carryover: undefined,
      spent: '85.03',
      periodEnd: '2026-05-31',
      phase: 'active',
    },
    {
      name: 'последний день периода — делитель 1',
      limit: '1000.00',
      carryover: undefined,
      spent: '100.00',
      periodEnd: TODAY,
      phase: 'active',
    },
  ] as const;

  for (const env of ENVELOPES) {
    test(`${env.name}: effective_limit / remaining / daily_pace / порог alerts`, () => {
      const props: Record<string, unknown> = {
        'orbis/limit': env.limit,
        'orbis/period_end': env.periodEnd,
      };
      if (env.carryover !== undefined) props['orbis/carryover'] = env.carryover;
      const base = scopeOf({ props, binding: ENVELOPE_BINDING, phase: env.phase });

      // Эталон aggregates.ts:342 — дословно, включая подстановку '0' на нестроку (Р-К-13: после
      // среза А валидатор не пускает нестроку в decimal-свойство, ветка недостижима).
      const oracleLimit = decAdd(
        env.limit,
        typeof env.carryover === 'string' ? env.carryover : '0',
      );
      expect(`${env.name}: ${String(evalExpr(EFFECTIVE_LIMIT, base))}`).toBe(
        `${env.name}: ${oracleLimit}`,
      );

      // Эталон aggregates.ts:363
      const withLimit = { ...base, aggs: { spent: env.spent, effective_limit: oracleLimit } };
      const oracleRemaining = decSub(oracleLimit, env.spent);
      expect(`${env.name}: ${String(evalExpr(REMAINING, withLimit))}`).toBe(
        `${env.name}: ${oracleRemaining}`,
      );

      // Эталон aggregates.ts:365-368. Закрытая фаза — гейт ЛЕНИВОСТИ `if`: days_inclusive(today,
      // period_end) там равен 0, и посчитайся плечо жадно, было бы деление на ноль вместо null.
      const withRemaining = {
        ...withLimit,
        aggs: { ...withLimit.aggs, remaining: oracleRemaining },
      };
      const oraclePace =
        env.phase === 'active' && decCmp(oracleRemaining, '0') >= 0
          ? decDivBy(oracleRemaining, daysInclusive(TODAY, env.periodEnd))
          : null;
      expect(`${env.name}: ${String(evalExpr(DAILY_PACE, withRemaining))}`).toBe(
        `${env.name}: ${String(oraclePace)}`,
      );

      // Эталон aggregates.ts:390-392 (порог 0.85 ВКЛЮЧИТЕЛЬНО, sign-off владельца 2026-07-23)
      const oracleAlert = decCmp(decMulInt(env.spent, 20), decMulInt(oracleLimit, 17)) >= 0;
      expect(`${env.name}: ${String(evalExpr(ALERT, withRemaining))}`).toBe(
        `${env.name}: ${String(oracleAlert)}`,
      );
    });
  }

  test('плечо `if` считается ТОЛЬКО выбранное: невзятое может быть невычислимым', () => {
    const bomb: ExprNode = { op: '/', args: [{ const: '1' }, { const: 0 }] };
    expect(evalExpr({ op: 'if', args: [{ const: true }, { const: 'ок' }, bomb] }, scopeOf())).toBe(
      'ок',
    );
    expect(evalExpr({ op: 'if', args: [{ const: false }, bomb, { const: 'ок' }] }, scopeOf())).toBe(
      'ок',
    );
    expect(
      reasonOf(() => evalExpr({ op: 'if', args: [{ const: true }, { const: 1 }] }, scopeOf())),
    ).toBe('VALIDATION/EXPR_VALUE');
  });
});

describe('evalExpr: deref — одношаговое разыменование ref (§Б3-3)', () => {
  const CAT_ID = '00000000-0000-4000-8000-0000000000c1';
  const scope = scopeOf({
    props: { 'orbis/finance_category': CAT_ID, 'orbis/period_start': '2026-05-01' },
    binding: ENVELOPE_BINDING,
    deref: (id) => (id === CAT_ID ? { 'orbis/title': 'Еда', tags: ['быт', 'регулярное'] } : null),
  });

  test('читает свойство цели и по слоту, и по id свойства', () => {
    expect(evalExpr({ deref: { slot: 'category', read: 'orbis/title' } }, scope)).toBe('Еда');
    expect(
      evalExpr({ deref: { prop: 'orbis/finance_category', read: 'orbis/title' } }, scope),
    ).toBe('Еда');
  });

  test('tags цели — список строк (Е-3), членство через in', () => {
    const tags: ExprNode = { deref: { slot: 'category', read: 'tags' } };
    expect(evalExpr({ op: 'in', args: [{ const: 'быт' }, tags] }, scope)).toBe(true);
    expect(evalExpr({ op: 'in', args: [{ const: 'работа' }, tags] }, scope)).toBe(false);
  });

  test('цель не найдена или архивна — ОТСУТСТВИЕ значения, а не отказ (§Б3-3, тотальность)', () => {
    const missing = { ...scope, props: { ...scope.props, 'orbis/finance_category': 'нет-такой' } };
    expect(evalExpr({ deref: { slot: 'category', read: 'orbis/title' } }, missing)).toBeNull();
    const empty = { ...scope, props: {} };
    expect(evalExpr({ deref: { slot: 'category', read: 'orbis/title' } }, empty)).toBeNull();
  });

  test('компоненты ключа порядка карточек §Б5-4 №6 — те же, что у aggregates.ts:576-582', () => {
    // Сегодня ключ склеивает КОД: название категории, разделитель NUL, period_start, NUL, id.
    // Декларация даёт те же три компонента; склейку делает движок (задача 9), значения — этот бэкенд.
    const parts = [
      evalExpr({ deref: { slot: 'category', read: 'orbis/title' } }, scope),
      evalExpr({ slot: 'period_start' }, scope),
      'env-1',
    ].map(String);
    expect(parts).toEqual(['Еда', '2026-05-01', 'env-1']);
  });

  test('свойство цели с умолчанием реестра читается умолчанием — правило одно для своей строки и чужой', () => {
    // Умолчание принадлежит СВОЙСТВУ (РП-9), а не строке: `deref` адресует те же id того же реестра,
    // и второе правило для «чужой» строки развело бы два чтения одного `orbis/planned`.
    const withDefaults = {
      ...scope,
      defaults: new Map<string, ExprScalar>([['orbis/planned', false]]),
    };
    expect(evalExpr({ deref: { slot: 'category', read: 'orbis/planned' } }, withDefaults)).toBe(
      false,
    );
    expect(
      evalExpr({ deref: { slot: 'category', read: 'orbis/all_day' } }, withDefaults),
    ).toBeNull();
  });

  test('читателя целей в области нет — структурный отказ: движок обязан его дать', () => {
    const noReader = scopeOf({
      props: { 'orbis/finance_category': CAT_ID },
      binding: ENVELOPE_BINDING,
    });
    expect(
      reasonOf(() => evalExpr({ deref: { slot: 'category', read: 'orbis/title' } }, noReader)),
    ).toBe('VALIDATION/EXPR_SCOPE');
  });
});
