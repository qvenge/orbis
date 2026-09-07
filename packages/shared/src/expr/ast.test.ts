// packages/shared/src/expr/ast.test.ts
// Канон языка E без БД: счёт констант, свой гейт глубины и класс паттерна длительности.
//
// Проверяется не «схема что-то принимает», а ГРАНИЦА канона: лишний оператор, лишняя ветвь
// или лишний аргумент обязаны отвергаться ФОРМОЙ — вход тула §С8-3 идёт мимо тайп-чекера.
import { describe, expect, test } from 'bun:test';
import { QUERY_TREE_DEPTH_CAP } from '../query/ast';
import { assertPatternRegular } from '../registry/property-type';
import {
  EXPR_CTX,
  EXPR_DURATION_PATTERN,
  EXPR_DURATION_RE,
  EXPR_FORMS,
  EXPR_OPS,
  EXPR_TREE_DEPTH_CAP,
  exprTreeExceedsDepth,
} from './ast';

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
