// packages/shared/src/expr/print.test.ts
// Печать E-дерева — материал ДИФФА Ш1: правку в декларации владелец видит текстом, и
// слипшиеся тексты прятали бы её. Обратимость печатью НЕ обещана (текст — сахар Р18,
// парсера текста в Б-1 нет), поэтому здесь проверяется читаемость и РАЗЛИЧИМОСТЬ.
import { describe, expect, test } from 'bun:test';
import { FIXTURE_PARSE_REGISTRY } from '../query/ast-fixtures';
import { EXPR_FIXTURES } from './fixtures';
import { printExpr } from './print';

describe('printExpr', () => {
  test('читаемый текст для диффа Ш1; разные деревья — разные тексты', () => {
    expect(
      printExpr(
        {
          op: 'and',
          args: [
            { op: '<=', args: [{ slot: 'date' }, { ctx: '$today' }] },
            {
              op: 'not',
              args: [
                {
                  op: 'in',
                  args: [{ class: { contract: 'orbis/recurrence' } }, { const: ['template'] }],
                },
              ],
            },
          ],
        } as never,
        FIXTURE_PARSE_REGISTRY,
      ),
    ).toBe('(slot:date <= $today and not ((class(orbis/recurrence) in ["template"])))');
    expect(
      printExpr(
        { deref: { slot: 'category', read: 'orbis/title' } } as never,
        FIXTURE_PARSE_REGISTRY,
      ),
    ).toBe('deref(slot:category).orbis/title');
    expect(
      printExpr(
        { agg_via: { role: 'envelope-binding', name: 'remaining' } } as never,
        FIXTURE_PARSE_REGISTRY,
      ),
    ).toBe('agg_via(envelope-binding, remaining)');

    // Слипшиеся тексты прячут правку: дифф Ш1 меряет её печатью (§А5-2).
    const texts = EXPR_FIXTURES.filter((f) => f.verdict.ok).map((f) =>
      printExpr(f.expr as never, FIXTURE_PARSE_REGISTRY),
    );
    expect(new Set(texts).size).toBe(texts.length);
  });

  test('empty печатается вызовом, контекст — как есть (дифф Ш1 читает текст)', () => {
    expect(
      printExpr({ op: 'empty', args: [{ ctx: '$sensitivity' }] } as never, FIXTURE_PARSE_REGISTRY),
    ).toBe('empty($sensitivity)');
    expect(
      printExpr(
        { op: 'in', args: [{ const: 'orbis/due_date' }, { ctx: '$touched' }] } as never,
        FIXTURE_PARSE_REGISTRY,
      ),
    ).toBe('("orbis/due_date" in $touched)');
  });
});
