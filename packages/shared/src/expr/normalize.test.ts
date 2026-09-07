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
import { normalizeExpr } from './normalize';

/**
 * Реестр нормализации = реестр разбора Q ПЛЮС словарь контрактов: у `ParseRegistry`
 * контрактов нет, а `normalizeExpr` резолвит `class.contract` и `has_relation.in_set.contract`.
 * Пользовательский контракт заводится ЗДЕСЬ, потому что во встроенной шестёрке записи с
 * key ≠ id нет ни одной (`ownerId` наследуется от образца: резолв ИМЁН его не читает).
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
});
