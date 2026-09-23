// packages/shared/src/expr/normalize.test.ts
// Нормализация имён в E-дереве: §А5-2 «в дереве лежат id, имя подставляется на печати».
//
// Проверяют её ТОЛЬКО записи с key ≠ id: у всех встроенных контрактов, ролей и свойств
// key = id (§1.3), и на них ветка «key → id» зелена при любой реализации, вплоть до
// `return expr`.
import { describe, expect, test } from 'bun:test';
import { FIXTURE_PARSE_REGISTRY, FIXTURE_USER_PROPERTY_ID } from '../query/ast-fixtures';
import { BUILTIN_CONTRACT_DEFS } from '../registry/builtin-contracts';
import type { ContractDefinition } from '../registry/contract-type';
import type { ExprNode } from './ast';
import { normalizeExpr, propertyNamesInExpr } from './normalize';

/**
 * Реестр нормализации = реестр разбора Q ПЛЮС словарь контрактов: у `ParseRegistry`
 * контрактов нет, а `normalizeExpr` резолвит `class.contract` и `has_relation.in_set.contract`.
 * Пользовательский контракт заводится ЗДЕСЬ, потому что во встроенной шестёрке записи с
 * key ≠ id нет ни одной (`graphId` наследуется от образца: резолв ИМЁН его не читает).
 */
const USER_CONTRACT_ID = '019d48ea-4188-7c02-8e96-1f0000000101';
const COMPLETABLE = BUILTIN_CONTRACT_DEFS.find(
  (c) => c.id === 'orbis/completable',
) as ContractDefinition;
const NORM_REG = {
  ...FIXTURE_PARSE_REGISTRY,
  contracts: new Map<string, ContractDefinition>([
    ...BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c] as [string, ContractDefinition]),
    [
      USER_CONTRACT_ID,
      { ...COMPLETABLE, id: USER_CONTRACT_ID, key: 'user/finishable' } as ContractDefinition,
    ],
  ]),
};

describe('normalizeExpr', () => {
  test('key → id у prop, deref.read, has, class.contract, has_relation.role и in_set.contract', () => {
    const before = {
      op: 'and',
      args: [
        { op: '=', args: [{ prop: 'user/effort_points' }, { const: 1 }] },
        { op: 'in', args: [{ class: { contract: 'user/finishable' } }, { const: ['done'] }] },
        {
          has_relation: {
            role: 'user/mention-alias',
            in_set: { contract: 'user/finishable', set: 'closed' },
          },
        },
      ],
    };
    const after = JSON.stringify(normalizeExpr(before as never, NORM_REG));
    expect(after).toContain(FIXTURE_USER_PROPERTY_ID);
    expect(after).toContain(USER_CONTRACT_ID);
    expect(after).toContain('user/mention_alias');
    // Ни одного key в дереве не осталось: в дереве лежат ТОЛЬКО id (§А5-2).
    expect(after).not.toContain('user/effort_points');
    expect(after).not.toContain('user/finishable');

    expect(normalizeExpr({ has: 'user/effort_points' } as never, NORM_REG)).toEqual({
      has: FIXTURE_USER_PROPERTY_ID,
    });
    expect(
      normalizeExpr({ deref: { slot: 'category', read: 'user/effort_points' } } as never, NORM_REG),
    ).toEqual({ deref: { slot: 'category', read: FIXTURE_USER_PROPERTY_ID } });
    // 'tags' в `read` — не запись реестра, а имя ядра (Е-3): остаётся собой.
    expect(normalizeExpr({ deref: { slot: 'category', read: 'tags' } } as never, NORM_REG)).toEqual(
      { deref: { slot: 'category', read: 'tags' } },
    );
    // Неизвестное имя остаётся КАК ЕСТЬ: отказ называет чекер, второго мнения не заводим —
    // то же правило и та же причина, что у `normalizeQueryAst`.
    expect(normalizeExpr({ prop: 'нет-такого' } as never, NORM_REG)).toEqual({
      prop: 'нет-такого',
    });
    // {slot} НЕ нормализуется: имя слота — имя внутри контракта, а не запись реестра.
    expect(normalizeExpr({ slot: 'amount' } as never, NORM_REG)).toEqual({ slot: 'amount' });
  });

  test('член $touched — АДРЕС свойства: key → id, как у {has} (Ф-Б2-26)', () => {
    const touched = (name: string): ExprNode => ({
      op: 'in',
      args: [{ const: name }, { ctx: '$touched' }],
    });
    expect(normalizeExpr(touched('user/effort_points'), NORM_REG)).toEqual(
      touched(FIXTURE_USER_PROPERTY_ID),
    );
    // Внутри составного выражения — тот же резолв: адрес не зависит от глубины.
    expect(normalizeExpr({ op: 'not', args: [touched('user/effort_points')] }, NORM_REG)).toEqual({
      op: 'not',
      args: [touched(FIXTURE_USER_PROPERTY_ID)],
    });
    // Прочие `{const}` — значения: тот же текст в членстве по списку не резолвится.
    const byValue: ExprNode = {
      op: 'in',
      args: [{ const: 'user/effort_points' }, { const: ['user/effort_points'] }],
    };
    expect(normalizeExpr(byValue, NORM_REG)).toEqual(byValue);
    // Неизвестное имя остаётся как есть — отказ называет чекер (`touchedMembership`).
    expect(normalizeExpr(touched('нет-такого'), NORM_REG)).toEqual(touched('нет-такого'));
  });
});

describe('propertyNamesInExpr — вход графа зависимостей правил (Р-И-22, §Б4)', () => {
  test('propertyNamesInExpr: prop, has и база deref — id, которые выражение ЧИТАЕТ', () => {
    const node = {
      op: 'and',
      args: [
        { op: '=', args: [{ prop: 'orbis/recurring' }, { const: true }] },
        { has: 'orbis/occurred_on' },
        { deref: { prop: 'orbis/finance_category', read: 'orbis/title' } },
        { slot: 'amount' },
        { ctx: '$today' },
        { agg_via: { role: 'ref', name: 'x' } },
      ],
    };
    expect([...propertyNamesInExpr(node)].sort()).toEqual([
      'orbis/finance_category',
      'orbis/occurred_on',
      'orbis/recurring',
    ]);
    expect([...propertyNamesInExpr({ deref: { slot: 'category', read: 'orbis/limit' } })]).toEqual(
      [],
    );
    expect([...propertyNamesInExpr(null)]).toEqual([]);
  });

  test('propertyNamesInExpr: член $touched — адрес, константа по значению — нет (Ф-Б2-26)', () => {
    const node = {
      op: 'and',
      args: [
        { op: 'in', args: [{ const: 'orbis/due_date' }, { ctx: '$touched' }] },
        { op: 'in', args: [{ const: 'orbis/priority' }, { const: ['orbis/priority'] }] },
        { op: 'in', args: [{ const: 'external' }, { ctx: '$sensitivity' }] },
      ],
    };
    expect([...propertyNamesInExpr(node)]).toEqual(['orbis/due_date']);
  });
});
