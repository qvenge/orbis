/**
 * Значение контракта (§3.2 спеки 1в) и вид адреса (§3.1): правило значения — закрытый набор в
 * коде, роли слотов — данные контракта. Реестр — встроенные контракты поставки: правило обязано
 * работать на них, а не на выдуманном реестре.
 */
import { expect, test } from 'bun:test';
import { BUILTIN_CONTRACT_DEFS } from './builtin-contracts';
import type { ContractDefinition } from './contract-type';
import {
  addressKindOf,
  COMPLETABLE_CLOSED,
  contractValueRuleOf,
  slotsWithRole,
} from './contract-value';

const contracts: ReadonlyMap<string, ContractDefinition> = new Map(
  BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c]),
);
const REG = { contracts };

function def(id: string): ContractDefinition {
  const found = contracts.get(id);
  if (!found) throw new Error(`нет контракта ${id}`);
  return found;
}

test('правило значения: «когда» — «даты», контракты без ролей значения не объявляют', () => {
  expect(contractValueRuleOf(def('orbis/when'))).toBe('dates');
  expect(contractValueRuleOf(def('orbis/money-movement'))).toBe(null);
  expect(contractValueRuleOf(def('orbis/completable'))).toBe(null);
  // Контракт-словарь фактов слотов не имеет — значения у него быть не может.
  expect(contractValueRuleOf(def('orbis/sensitivity'))).toBe(null);
});

test('слоты с ролью: план — момент и срок, факт — время завершения (§4.1)', () => {
  const when = def('orbis/when');
  expect(slotsWithRole(when, 'plan')).toEqual(['moment', 'deadline']);
  expect(slotsWithRole(when, 'fact')).toEqual(['done']);
  expect(slotsWithRole(def('orbis/money-movement'), 'plan')).toEqual([]);
});

test('правило «даты» читает набор closed ядровой завершаемости (К-1)', () => {
  expect(COMPLETABLE_CLOSED).toEqual({ contract: 'orbis/completable', set: 'closed' });
  const completable = def(COMPLETABLE_CLOSED.contract);
  expect(completable.module).toBe(null);
  expect(completable.sets?.[COMPLETABLE_CLOSED.set]).toEqual(['done', 'cancelled']);
});

test('вид адреса: значение — «даты», слот — виды его типа, контракт без значения — null', () => {
  expect(addressKindOf({ contract: 'orbis/when' }, REG)).toEqual({ kind: 'dates' });
  expect(addressKindOf({ contract: 'orbis/when', slot: 'deadline' }, REG)).toEqual({
    kind: 'slot',
    kinds: ['date'],
  });
  expect(addressKindOf({ contract: 'orbis/when', slot: 'moment' }, REG)).toEqual({
    kind: 'slot',
    kinds: ['timestamp', 'date'],
  });
  expect(addressKindOf({ contract: 'orbis/money-movement', slot: 'amount' }, REG)).toEqual({
    kind: 'slot',
    kinds: ['decimal'],
  });
  expect(addressKindOf({ contract: 'orbis/completable' }, REG)).toBe(null);
  // Слота нет, контракта нет, слот — роль ребра (значения свойства у него нет): адресовать нечего.
  expect(addressKindOf({ contract: 'orbis/when', slot: 'nope' }, REG)).toBe(null);
  expect(addressKindOf({ contract: 'orbis/nope' }, REG)).toBe(null);
  expect(addressKindOf({ contract: 'orbis/recurrence', slot: 'origin_role' }, REG)).toBe(null);
});
