// packages/shared/src/expr/ast.test.ts
// Канон языка E без БД: счёт констант, свой гейт глубины и класс паттерна длительности.
//
// Проверяется не «схема что-то принимает», а ГРАНИЦА канона: лишний оператор, лишняя ветвь
// или лишний аргумент обязаны отвергаться ФОРМОЙ — вход тула §С8-3 идёт мимо тайп-чекера.
import { describe, expect, test } from 'bun:test';
import Ajv from 'ajv';
import { QUERY_TREE_DEPTH_CAP } from '../query/ast';
import { assertPatternRegular } from '../registry/property-type';
import {
  EXPR_CTX,
  EXPR_DURATION_PATTERN,
  EXPR_DURATION_RE,
  EXPR_FORMS,
  EXPR_OPS,
  EXPR_TREE_DEPTH_CAP,
  type ExprForm,
  type ExprNode,
  exprFormsOf,
  exprNodeSchema,
  exprTreeExceedsDepth,
} from './ast';
import { exprJsonSchema } from './json-schema';

/**
 * По одной законной пробе на каждую из 17 форм. Карта переиспользуется тестом JSON Schema:
 * два валидатора обязаны отвечать одно и то же на ОДНИХ И ТЕХ ЖЕ входах, иначе схема,
 * уехавшая чужому потребителю, разойдётся с той, по которой сохраняется декларация.
 */
const FORM_PROBE: Record<ExprForm, unknown> = {
  const: { const: '0.85' },
  duration: { duration: 'P1D' },
  prop: { prop: 'orbis/amount' },
  slot: { slot: 'amount' },
  param: { param: 'period_start' },
  ctx: { ctx: '$today' },
  agg: { agg: 'spent' },
  phase: { phase: 'active' },
  agg_via: { agg_via: { role: 'envelope-binding', name: 'remaining' } },
  deref: { deref: { slot: 'category', read: 'orbis/title' } },
  op: { op: 'and', args: [{ const: true }, { const: false }] },
  has: { has: 'orbis/carryover' },
  has_relation: { has_relation: { role: 'instance-of', alive: true } },
  class: { class: { contract: 'orbis/completable' } },
  date_add: { date_add: [{ ctx: '$today' }, { duration: 'P7D' }] },
  date_diff: { date_diff: [{ ctx: '$today' }, { slot: 'date' }] },
  days_inclusive: { days_inclusive: [{ ctx: '$today' }, { slot: 'period_end' }] },
};

describe('канон §Б3-5', () => {
  test('канон §Б3-5: 15 операторов и 17 ветвей узла = 16 форм канона + {slot}', () => {
    // «24» решения владельца В-1 — счёт 9 значений + 15 операторов, а не число веток схемы (О5 plan-verify).
    expect(EXPR_OPS.length).toBe(15);
    expect(new Set(EXPR_OPS).size).toBe(15);
    expect(EXPR_FORMS.length).toBe(17);
    expect(EXPR_CTX).toEqual(['$today', '$owner', '$self', '$sensitivity']);
  });

  test('кап дерева E — СВОЙ; предикат считает по сырому значению', () => {
    expect(EXPR_TREE_DEPTH_CAP).toBe(64);
    expect(EXPR_TREE_DEPTH_CAP).toBe(QUERY_TREE_DEPTH_CAP);
    let deep: unknown = { const: 1 };
    for (let i = 0; i < 80; i += 1) deep = { op: 'not', args: [deep] };
    expect(exprTreeExceedsDepth(deep, EXPR_TREE_DEPTH_CAP)).toBe(true);
    expect(exprTreeExceedsDepth({ op: 'not', args: [{ const: true }] }, EXPR_TREE_DEPTH_CAP)).toBe(
      false,
    );
  });

  test('паттерн длительности в классе RE2 — схема E поедет чужому валидатору (D29)', () => {
    expect(() => assertPatternRegular(EXPR_DURATION_PATTERN)).not.toThrow();
    for (const ok of ['P1D', 'P1Y2M', 'PT30M', 'P1DT12H', 'P2W']) {
      expect(EXPR_DURATION_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ['P', 'PT', '1D', 'P1H', 'P-1D']) {
      expect(EXPR_DURATION_RE.test(bad), bad).toBe(false);
    }
  });
});

describe('схема узла', () => {
  test('exprNodeSchema принимает пробу каждой ветви и отвергает выдумку', () => {
    for (const f of EXPR_FORMS) {
      expect(exprNodeSchema.safeParse(FORM_PROBE[f]).success, f).toBe(true);
      expect(exprFormsOf(FORM_PROBE[f] as ExprNode).has(f), f).toBe(true);
    }
    expect(exprNodeSchema.safeParse({ lit: 0.85 }).success).toBe(false); // форма эталона П2
    expect(exprNodeSchema.safeParse({ op: 'mul', args: [] }).success).toBe(false);
    expect(exprNodeSchema.safeParse({ prop: 'orbis/amount', op: 'eq' }).success).toBe(false);
  });

  test('арность операторов — в СХЕМЕ: вход тула идёт мимо чекера (§С8-3)', () => {
    expect(
      exprNodeSchema.safeParse({ op: 'not', args: [{ const: true }, { const: true }] }).success,
    ).toBe(false);
    expect(
      exprNodeSchema.safeParse({ op: 'if', args: [{ const: true }, { const: 1 }] }).success,
    ).toBe(false);
    expect(exprNodeSchema.safeParse({ op: 'and', args: [{ const: true }] }).success).toBe(false);
    expect(
      exprNodeSchema.safeParse({ op: '+', args: [{ const: 1 }, { const: 2 }, { const: 3 }] })
        .success,
    ).toBe(false);
  });
});

describe('JSON Schema языка E', () => {
  // strict:false — та же настройка, под которой схема поедет в Responses API (D29):
  // `$defs` в draft-07 формально не ключевое слово, а `$ref: '#/$defs/node'` — обычный
  // JSON-указатель, и резолвится он у любого потребителя.
  const validate = new Ajv({ strict: false, allErrors: true }).compile(exprJsonSchema);

  test('exprJsonSchema валидирует пробы всех форм и отвергает узлы вне канона', () => {
    for (const f of EXPR_FORMS) {
      expect(validate(FORM_PROBE[f]), `${f}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    expect(validate({ op: 'coalesce', args: [{ const: 1 }, { const: 2 }] })).toBe(false);
    expect(validate({ phase: true })).toBe(false);
  });

  test('zod-схема E совпадает с JSON Schema по вердикту на тех же входах', () => {
    const probes: unknown[] = [
      { const: null },
      { const: [] },
      { const: ['done', 'cancelled'] },
      { duration: 'P' },
      { ctx: '$нет' },
      { op: 'if', args: [{ const: true }, { const: 1 }] },
      { op: 'and', args: [{ const: true }, { const: false }, { const: true }] },
      { deref: { prop: 'orbis/finance_category', slot: 'category', read: 'orbis/title' } },
      {
        has_relation: {
          role: 'dependency',
          in_set: { contract: 'orbis/completable', set: 'closed' },
        },
      },
      { date_add: [{ ctx: '$today' }] },
    ];
    for (const p of probes) {
      expect(exprNodeSchema.safeParse(p).success, JSON.stringify(p)).toBe(validate(p) as boolean);
    }
  });
});
