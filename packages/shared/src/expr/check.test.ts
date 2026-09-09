// packages/shared/src/expr/check.test.ts
// Тайп-чекер языка E (§Б3-4, приёмка §С8-28). Проверяется ВЕРДИКТ и МЕСТО отказа: код без
// пути не адресует ничего, а декларация подписки — дерево в сотню узлов.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_CONTRACT_DEFS } from '../registry/builtin-contracts';
import { BUILTIN_PROPERTY_META } from '../registry/builtin-properties';
import { EXPR_FORMS, EXPR_TREE_DEPTH_CAP, type ExprNode, exprFormsOf } from './ast';
import { checkExpr, type ExprScope, exprTypeOfKind } from './check';
import {
  EXPR_NOT_TOTAL,
  EXPR_RECURSION,
  EXPR_TYPE,
  ExprCheckError,
  SECOND_LANGUAGE,
} from './codes';
import { EXPR_FIXTURES } from './fixtures';

const REG = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
};
const scope = (over: Partial<ExprScope> = {}): ExprScope => ({ reg: REG, ...over });
const MONEY = scope({ contract: 'orbis/money-movement' });

/** Код отказа И путь до узла: без пути отказ не адресует ничего. */
function refusal(fn: () => unknown): { code: string; path: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExprCheckError) return { code: e.code, path: e.path.join('.') };
    throw e;
  }
  throw new Error('ожидался отказ чекера, а его не было');
}

describe('тайп-чекер §С8-28: значения и сравнения', () => {
  test('строка в E-позиции — SECOND_LANGUAGE, а не разбор текста', () => {
    expect(refusal(() => checkExpr('amount > 100', MONEY)).code).toBe(SECOND_LANGUAGE);
  });

  test('целое — number, decimal — ТОЛЬКО строка, дробное JSON-число — EXPR_TYPE', () => {
    expect(checkExpr({ const: 14 }, MONEY)).toEqual({ kind: 'number' });
    expect(
      refusal(() => checkExpr({ op: '>=', args: [{ slot: 'amount' }, { const: 0.85 }] }, MONEY))
        .code,
    ).toBe(EXPR_TYPE);
    expect(checkExpr({ op: '>=', args: [{ slot: 'amount' }, { const: '0.85' }] }, MONEY)).toEqual({
      kind: 'boolean',
    });
  });

  test('exprTypeOfKind: select и ref — text, json — EXPR_TYPE', () => {
    expect(exprTypeOfKind('select')).toEqual({ kind: 'text' });
    expect(exprTypeOfKind('decimal')).toEqual({ kind: 'decimal' });
    expect(refusal(() => exprTypeOfKind('json')).code).toBe(EXPR_TYPE);
  });

  test('{slot} законен только в области с контрактом; чужой слот — EXPR_TYPE с путём', () => {
    expect(checkExpr({ slot: 'amount' }, MONEY)).toEqual({ kind: 'decimal' });
    expect(refusal(() => checkExpr({ slot: 'amount' }, scope())).code).toBe(EXPR_TYPE);
    expect(
      refusal(() => checkExpr({ op: 'and', args: [{ const: true }, { slot: 'нет' }] }, MONEY)).path,
    ).toBe('args.1');
  });

  test('сравнение ТОТАЛЬНО: необязательный слот сравнивать можно (§Б3-4 — отсутствие даёт false)', () => {
    expect(checkExpr({ op: '=', args: [{ slot: 'planned' }, { const: false }] }, MONEY)).toEqual({
      kind: 'boolean',
    });
  });
});

describe('тайп-чекер §С8-28: арифметика и in', () => {
  const ENV = scope({ contract: 'orbis/envelope', aggs: { remaining: { kind: 'decimal' } } });

  test('amount + "text" — EXPR_TYPE (фикстура §С8-28)', () => {
    expect(
      refusal(() => checkExpr({ op: '+', args: [{ slot: 'amount' }, { const: 'text' }] }, MONEY))
        .code,
    ).toBe(EXPR_TYPE);
  });

  test('decimal+decimal → decimal; decimal/number → decimal; decimal+number — EXPR_TYPE', () => {
    expect(checkExpr({ op: '+', args: [{ slot: 'limit' }, { const: '0' }] }, ENV)).toEqual({
      kind: 'decimal',
    });
    expect(checkExpr({ op: '/', args: [{ agg: 'remaining' }, { const: 30 }] }, ENV)).toEqual({
      kind: 'decimal',
    });
    // Р-К-29: number/number → decimal
    expect(checkExpr({ op: '/', args: [{ const: 7 }, { const: 2 }] }, ENV)).toEqual({
      kind: 'decimal',
    });
    expect(
      refusal(() => checkExpr({ op: '+', args: [{ slot: 'limit' }, { const: 1 }] }, ENV)).code,
    ).toBe(EXPR_TYPE);
  });

  test('доводка литерала СИММЕТРИЧНА: "0.85" * limit ≡ limit * "0.85" (B2 M-1)', () => {
    // §Б3-4 обещает доводку литерала по соседу, а умножение коммутативно: несимметричное
    // приведение отказывало владельцу на форме, которую сам же чекер принимает зеркально.
    for (const args of [
      [{ const: '0.85' }, { slot: 'limit' }],
      [{ slot: 'limit' }, { const: '0.85' }],
      [{ const: 30 }, { agg: 'remaining' }],
      [{ agg: 'remaining' }, { const: 30 }],
      [{ const: '0' }, { slot: 'limit' }],
    ] as ExprNode[][]) {
      expect([args, checkExpr({ op: '*', args } as ExprNode, ENV)]).toEqual([
        args,
        { kind: 'decimal' },
      ]);
    }
    // Симметрия НЕ отменяет типовых отказов: decimal + number остаётся EXPR_TYPE в обе стороны.
    for (const args of [
      [{ slot: 'limit' }, { const: 1 }],
      [{ const: 1 }, { slot: 'limit' }],
    ] as ExprNode[][]) {
      expect(refusal(() => checkExpr({ op: '+', args } as ExprNode, ENV)).code).toBe(EXPR_TYPE);
    }
  });

  test('in: по списку классов и по имени набора; чужое имя набора — EXPR_TYPE', () => {
    expect(
      checkExpr(
        {
          op: 'not',
          args: [
            {
              op: 'in',
              args: [{ class: { contract: 'orbis/recurrence' } }, { const: ['template'] }],
            },
          ],
        },
        scope(),
      ),
    ).toEqual({ kind: 'boolean' });
    expect(
      checkExpr(
        { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: 'open' }] },
        scope(),
      ),
    ).toEqual({ kind: 'boolean' });
    expect(
      refusal(() =>
        checkExpr(
          { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: 'нет' }] },
          scope(),
        ),
      ).code,
    ).toBe(EXPR_TYPE);
    expect(
      refusal(() => checkExpr({ op: 'and', args: [{ const: true }, { const: 1 }] }, MONEY)).code,
    ).toBe(EXPR_TYPE);
  });
});

describe('тайп-чекер §С8-28: тотальность (§Б3-4)', () => {
  const ENV = scope({ contract: 'orbis/envelope' });

  test('арифметика над необязательным слотом без if(has(…)) — EXPR_NOT_TOTAL', () => {
    expect(
      refusal(() => checkExpr({ op: '+', args: [{ slot: 'limit' }, { slot: 'carryover' }] }, ENV))
        .code,
    ).toBe(EXPR_NOT_TOTAL);
  });

  test('тот же carryover под if(has(carryover), …) — законен: эталонная формула effective_limit', () => {
    expect(
      checkExpr(
        {
          op: '+',
          args: [
            { slot: 'limit' },
            {
              op: 'if',
              args: [{ has: 'carryover' }, { slot: 'carryover' }, { const: '0' }],
            },
          ],
        },
        ENV,
      ),
    ).toEqual({ kind: 'decimal' });
  });

  test('{const:null} плечом даёт необязательный тип — daily_pace обязан быть nullable', () => {
    const P = scope({
      contract: 'orbis/envelope',
      aggs: { remaining: { kind: 'decimal' } },
      phases: ['active', 'upcoming', 'closed'],
    });
    expect(
      checkExpr(
        {
          op: 'if',
          args: [
            { phase: 'active' },
            {
              op: '/',
              args: [
                { agg: 'remaining' },
                { days_inclusive: [{ ctx: '$today' }, { slot: 'period_end' }] },
              ],
            },
            { const: null },
          ],
        },
        P,
      ),
    ).toEqual({ kind: 'decimal' });
  });

  test('то же плечо у БУЛЕВА if — EXPR_NOT_TOTAL: предикат необязательным не бывает', () => {
    // Необязательная ВЕЛИЧИНА законна (тест выше), необязательная ИСТИНА — нет: «ни истина, ни
    // ложь» не значит ничего ни одному бэкенду, и SQL-бэкенд предикатов отвечает на такое плечо
    // отказом. Принять его на записи значило бы адресовать отказ владельцу на чтении (Ф-Б1-61).
    const W = scope({ contract: 'orbis/when' });
    const nullArm = {
      op: 'if',
      args: [{ has: 'orbis/all_day' }, { prop: 'orbis/all_day' }, { const: null }],
    } as ExprNode;
    expect(refusal(() => checkExpr(nullArm, W))).toEqual({ code: EXPR_NOT_TOTAL, path: '' });
    // …и путь адресует УЗЕЛ, а не корень, когда `if` стоит внутри предиката.
    expect(
      refusal(() =>
        checkExpr(
          {
            op: 'and',
            args: [
              { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: 'open' }] },
              nullArm,
            ],
          } as ExprNode,
          W,
        ),
      ),
    ).toEqual({ code: EXPR_NOT_TOTAL, path: 'args.1' });
    // Сторона плеча роли не играет — отказ тот же.
    expect(
      refusal(() =>
        checkExpr(
          {
            op: 'if',
            args: [{ has: 'orbis/all_day' }, { const: null }, { prop: 'orbis/all_day' }],
          } as ExprNode,
          W,
        ),
      ).code,
    ).toBe(EXPR_NOT_TOTAL);
    // Контроль: то же `if` с булевыми плечами законно — отвергается ПЛЕЧО null, а не оператор.
    expect(
      checkExpr(
        {
          op: 'if',
          args: [{ has: 'orbis/all_day' }, { prop: 'orbis/all_day' }, { const: false }],
        } as ExprNode,
        W,
      ),
    ).toEqual({ kind: 'boolean' });
  });
});

describe('тайп-чекер §С8-28: арифметика дат', () => {
  const W = scope({ contract: 'orbis/when' });

  test('дата + длительность — ок; дата + число — EXPR_TYPE (фикстура §С8-28)', () => {
    expect(checkExpr({ date_add: [{ ctx: '$today' }, { duration: 'P7D' }] }, W)).toEqual({
      kind: 'date',
    });
    expect(refusal(() => checkExpr({ date_add: [{ ctx: '$today' }, { const: 7 }] }, W)).code).toBe(
      EXPR_TYPE,
    );
  });

  test('date_diff и days_inclusive дают number; длительность аргументом — EXPR_TYPE', () => {
    expect(checkExpr({ date_diff: [{ ctx: '$today' }, { ctx: '$today' }] }, W)).toEqual({
      kind: 'number',
    });
    expect(
      refusal(() => checkExpr({ days_inclusive: [{ ctx: '$today' }, { duration: 'P1D' }] }, W))
        .code,
    ).toBe(EXPR_TYPE);
  });

  test('date_add по необязательному слоту — EXPR_NOT_TOTAL, как любая арифметика', () => {
    expect(
      refusal(() => checkExpr({ date_add: [{ slot: 'deadline' }, { duration: 'P1D' }] }, W)).code,
    ).toBe(EXPR_NOT_TOTAL);
  });
});

describe('тайп-чекер §С8-28: область, $sensitivity и рекурсия', () => {
  const S = { op: 'in', args: [{ const: 'external' }, { ctx: '$sensitivity' }] };

  test('$sensitivity вне assign_level — EXPR_TYPE (приёмка §С8-28)', () => {
    expect(checkExpr(S, scope({ allowSensitivity: true }))).toEqual({ kind: 'boolean' });
    expect(refusal(() => checkExpr(S, scope())).code).toBe(EXPR_TYPE);
    expect(
      refusal(() =>
        checkExpr(
          { op: 'in', args: [{ const: 'нет-факта' }, { ctx: '$sensitivity' }] },
          scope({ allowSensitivity: true }),
        ),
      ).code,
    ).toBe(EXPR_TYPE);
  });

  test('deref — только где разрешён; результат необязателен (цель может быть архивна)', () => {
    const D = scope({ contract: 'orbis/envelope', allowDeref: true });
    expect(
      checkExpr(
        {
          op: '=',
          args: [{ deref: { slot: 'category', read: 'orbis/title' } }, { const: 'Еда' }],
        },
        D,
      ),
    ).toEqual({ kind: 'boolean' });
    expect(
      refusal(() =>
        checkExpr(
          { deref: { slot: 'category', read: 'orbis/title' } },
          scope({ contract: 'orbis/envelope' }),
        ),
      ).code,
    ).toBe(EXPR_TYPE);
    // слот не ref
    expect(
      refusal(() => checkExpr({ deref: { slot: 'limit', read: 'orbis/title' } }, D)).code,
    ).toBe(EXPR_TYPE);
  });

  test('agg/phase/agg_via/has_relation/class: неизвестное имя — EXPR_TYPE, не пустота', () => {
    expect(refusal(() => checkExpr({ agg: 'spent' }, scope())).code).toBe(EXPR_TYPE);
    expect(refusal(() => checkExpr({ phase: 'active' }, scope())).code).toBe(EXPR_TYPE);
    expect(
      checkExpr({ agg_via: { role: 'envelope-binding', name: 'remaining' } }, scope()),
    ).toEqual({ kind: 'decimal' });
    expect(checkExpr({ has_relation: { role: 'instance-of', alive: true } }, scope())).toEqual({
      kind: 'boolean',
    });
    expect(
      refusal(() =>
        checkExpr(
          { has_relation: { role: 'r', in_set: { contract: 'orbis/completable', set: 'нет' } } },
          scope(),
        ),
      ).code,
    ).toBe(EXPR_TYPE);
    // facts-контракт классов не имеет
    expect(
      refusal(() => checkExpr({ class: { contract: 'orbis/sensitivity' } }, scope())).code,
    ).toBe(EXPR_TYPE);
  });

  test('самоссылка невыразима: циклическая структура — EXPR_RECURSION, а не зависание', () => {
    const cyclic: Record<string, unknown> = { op: 'not', args: [] };
    (cyclic.args as unknown[]).push(cyclic);
    expect(refusal(() => checkExpr(cyclic, scope())).code).toBe(EXPR_RECURSION);
  });
});

describe('EXPR_FIXTURES — корпус приёмки §С8-28', () => {
  test('каждая фикстура даёт объявленный вердикт', () => {
    for (const f of EXPR_FIXTURES) {
      const s = { reg: REG, ...f.scope } as ExprScope;
      if (f.verdict.ok) expect(checkExpr(f.expr, s), f.name).toEqual(f.verdict.type);
      else expect(refusal(() => checkExpr(f.expr, s)).code, f.name).toBe(f.verdict.code);
    }
  });

  test('полнота: у каждой из 17 форм есть позитив и негатив, у каждого из 4 кодов — фикстура', () => {
    for (const form of EXPR_FORMS) {
      const w = EXPR_FIXTURES.filter(
        (f) =>
          typeof f.expr === 'object' &&
          f.expr !== null &&
          exprFormsOf(f.expr as ExprNode).has(form),
      );
      expect(
        w.some((f) => f.verdict.ok),
        `позитив для ${form}`,
      ).toBe(true);
      expect(
        w.some((f) => !f.verdict.ok),
        `негатив для ${form}`,
      ).toBe(true);
    }
    for (const code of [EXPR_TYPE, EXPR_NOT_TOTAL, EXPR_RECURSION, SECOND_LANGUAGE]) {
      expect(
        EXPR_FIXTURES.some((f) => !f.verdict.ok && f.verdict.code === code),
        code,
      ).toBe(true);
    }
  });

  test('«бюджет»: самое глубокое выражение §Б5-4 — 7 уровней, кап даёт девятикратный запас', () => {
    const b = EXPR_FIXTURES.find((f) => f.name === 'бюджет: daily_pace целиком');
    const depth = (v: unknown): number =>
      typeof v !== 'object' || v === null ? 0 : 1 + Math.max(0, ...Object.values(v).map(depth));
    expect(depth(b?.expr)).toBe(7);
    expect(depth(b?.expr)).toBeLessThan(EXPR_TREE_DEPTH_CAP);
  });
});
