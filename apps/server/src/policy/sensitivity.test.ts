// apps/server/src/policy/sensitivity.test.ts
// Факты чувствительности вызова как ДАННЫЕ (§С8-23, §Б1-2). БД не нужна: словарь приезжает
// снимком реестра, а встроенные контракты — те же строки, что кладёт сид (дрейф сверяет их
// по всем колонкам — `registry-drift.test.ts`, задача 1). Цепочка «код → снимок → сид»
// поэтому закрыта, а тут проверяется её первое звено.
import { describe, expect, test } from 'bun:test';
import { BUILTIN_CONTRACT_DEFS, type ContractDefinition, SENSITIVITY_FACTS } from '@orbis/shared';
import type { RegistrySnapshot } from '../registry/load';
import type { Reconfigures } from './confirmation';
import { sensitivityFactsOf } from './sensitivity';

function snapshot(
  contracts: readonly ContractDefinition[] = BUILTIN_CONTRACT_DEFS,
): RegistrySnapshot {
  return {
    properties: new Map(),
    aspects: new Map(),
    roles: new Map(),
    subscriptions: new Map(),
    contracts: new Map(contracts.map((d) => [d.id, d])),
    ownerVersion: 1,
    systemVersion: 1,
  };
}
const call = (
  over: Partial<{
    tool: string;
    reconfigures: Reconfigures;
    grantsAutonomy: boolean;
    archives: boolean;
  }> = {},
) => ({
  tool: 'property_update',
  reconfigures: 'none' as Reconfigures,
  grantsAutonomy: false,
  archives: false,
  ...over,
});

describe('факты как данные: словарь из контракта orbis/sensitivity (§С8-23)', () => {
  test('мутация реестра даёт changes_registry на всех трёх ответах §С2-1', () => {
    for (const reconfigures of ['own-property', 'behavior-delta', 'system-object'] as const) {
      expect([reconfigures, [...sensitivityFactsOf(snapshot(), call({ reconfigures }))]]).toEqual([
        reconfigures,
        ['changes_registry'],
      ]);
    }
    // …а правка графа фактов не несёт: `none` — «вызов реестра не трогает вовсе».
    expect([...sensitivityFactsOf(snapshot(), call({ tool: 'entity_update' }))]).toEqual([]);
  });

  test('выдача автономии даёт grants_autonomy; пачка «реестр + автономия» — оба разом', () => {
    expect([...sensitivityFactsOf(snapshot(), call({ grantsAutonomy: true }))]).toEqual([
      'grants_autonomy',
    ]);
    // Свёртка пачки уже произошла ВЫШЕ (`heaviestReconfigures` в factsFromToolCall), поэтому
    // объединение множества здесь получается само: своей свёртки у фактов нет и не нужно.
    expect([
      ...sensitivityFactsOf(
        snapshot(),
        call({ tool: 'batch_execute', reconfigures: 'behavior-delta', grantsAutonomy: true }),
      ),
    ]).toEqual(['changes_registry', 'grants_autonomy']);
  });

  test('факт, которого нет в словаре, — Error: код и сид разошлись', () => {
    const trimmed = BUILTIN_CONTRACT_DEFS.map((d) =>
      d.id === 'orbis/sensitivity' && d.kind === 'facts'
        ? { ...d, facts: d.facts.filter((f) => f.key !== 'changes_registry') }
        : d,
    );
    expect(() =>
      sensitivityFactsOf(snapshot(trimmed), call({ reconfigures: 'behavior-delta' })),
    ).toThrow(/changes_registry/);
    // …а вызов, который этого факта не производит, на урезанном словаре живёт: отказ адресован
    // расхождению, а не наличию словаря вообще.
    expect([...sensitivityFactsOf(snapshot(trimmed), call({ grantsAutonomy: true }))]).toEqual([
      'grants_autonomy',
    ]);
  });

  test('снимок без словаря — Error, а не пустое множество (§С2-1 «ни для какого актора молча»)', () => {
    const without = BUILTIN_CONTRACT_DEFS.filter((d) => d.id !== 'orbis/sensitivity');
    expect(() =>
      sensitivityFactsOf(snapshot(without), call({ reconfigures: 'own-property' })),
    ).toThrow(/orbis\/sensitivity/);
  });

  test('вызов производит РОВНО два факта из пяти: остальные три назначают декларации действий (Б-2)', () => {
    const produced = new Set<string>();
    for (const reconfigures of [
      'none',
      'own-property',
      'behavior-delta',
      'system-object',
    ] as const) {
      for (const grantsAutonomy of [false, true]) {
        for (const archives of [false, true]) {
          for (const fact of sensitivityFactsOf(
            snapshot(),
            call({ reconfigures, grantsAutonomy, archives }),
          )) {
            produced.add(fact);
          }
        }
      }
    }
    expect([...produced].sort()).toEqual(['changes_registry', 'grants_autonomy']);
    // Словарь при этом ПОЛНЫЙ — пять фактов §Б1-2: сузить сид до двух было бы другим решением,
    // и оно принято не было (правила Б-2 пишутся по всем пяти именам).
    expect(SENSITIVITY_FACTS).toHaveLength(5);
    // Архивация фактом не становится ни при каком сочетании: мягкое удаление обратимо.
    expect([...sensitivityFactsOf(snapshot(), call({ archives: true }))]).toEqual([]);
  });
});
