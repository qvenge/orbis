// apps/server/src/expr/check.test.ts
// Гейт записи E на сервере: отказ чекера обязан приезжать структурной ошибкой §9.2, а
// глубина — мериться ПЕРВОЙ. БД здесь не нужна: меряется перевод отказов, а не данные.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_CONTRACT_DEFS, BUILTIN_PROPERTY_META } from '@orbis/shared';
import { EXPR_TREE_DEPTH_CAP, type ExprScope } from '@orbis/shared/expr';
import { ExecError } from '../errors';
import { assertExprChecked } from './check';

const SCOPE: ExprScope = {
  reg: {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
  },
};

function fail(fn: () => unknown): { code: string; reason: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExecError) {
      return { code: e.code, reason: String((e.details as { reason?: unknown })?.reason) };
    }
    throw e;
  }
  throw new Error('ожидался ExecError, а его не было');
}

describe('assertExprChecked: отказ чекера приезжает структурной ошибкой §9.2', () => {
  test('код отказа E — сам код ExecError, а не VALIDATION с причиной', () => {
    expect(fail(() => assertExprChecked('amount > 100', SCOPE)).code).toBe('SECOND_LANGUAGE');
    expect(
      fail(() =>
        assertExprChecked({ op: '+', args: [{ prop: 'orbis/amount' }, { const: '1' }] }, SCOPE),
      ).code,
    ).toBe('EXPR_NOT_TOTAL');
  });

  test('ВХОД-ДЕРЕВА: глубина меряется ПЕРВОЙ, до схемы и до чекера', () => {
    let deep: unknown = { const: 1 };
    for (let i = 0; i < EXPR_TREE_DEPTH_CAP + 5; i += 1) deep = { op: 'not', args: [deep] };
    const r = fail(() => assertExprChecked(deep, SCOPE));
    expect(r.code).toBe('VALIDATION');
    expect(r.reason).toBe('EXPR_TOO_DEEP');
  });

  test('законное выражение возвращает тип', () => {
    expect(
      assertExprChecked(
        { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: 'open' }] },
        SCOPE,
      ),
    ).toEqual({ kind: 'boolean' });
  });
});
