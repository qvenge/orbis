import { describe, expect, test } from 'bun:test';
import { actionDefinitionSchema, BATCH_CAP_DEFAULT, exprMarkerSchema } from './action-type';

const BASE = {
  id: 'finance/x',
  graphId: null,
  key: 'finance/x',
  label: { ru: 'X', en: 'X' },
  description: { ru: 'x', en: 'x' },
  steps: [
    {
      tool: 'entity_update',
      input: { id: { $expr: { ctx: '$self' } }, props: { 'orbis/planned': false } },
    },
  ],
  module: 'finance',
  rank: 0,
};

describe('форма действия §Б6-1', () => {
  test('умолчания: params/sensitivity/offered_by пусты, precondition/over/batch_cap = null, status active', () => {
    const d = actionDefinitionSchema.parse(BASE);
    expect([d.params, d.sensitivity, d.offered_by]).toEqual([[], [], []]);
    expect([d.precondition, d.over, d.batch_cap, d.status]).toEqual([null, null, null, 'active']);
  });
  test('обёртка {$expr} — единственный способ сказать «здесь выражение»', () => {
    // Литерал-объект json-свойства и выражение неразличимы без маркера: без него
    // `{prop:'orbis/x'}` в `props` был бы законным ЗНАЧЕНИЕМ json-свойства (§Б6-1).
    expect(exprMarkerSchema.safeParse({ $expr: { ctx: '$self' } }).success).toBe(true);
    expect(exprMarkerSchema.safeParse({ $expr: { ctx: '$self' }, extra: 1 }).success).toBe(false);
  });
  test('ключ namespaced, кап целый ≥1, статус из двух, константа капа — 100 (Р-11)', () => {
    expect(BATCH_CAP_DEFAULT).toBe(100);
    expect(actionDefinitionSchema.safeParse({ ...BASE, key: 'plan-to-fact' }).success).toBe(false);
    expect(actionDefinitionSchema.safeParse({ ...BASE, batch_cap: 0 }).success).toBe(false);
    expect(actionDefinitionSchema.safeParse({ ...BASE, status: 'archived' }).success).toBe(false);
    expect(actionDefinitionSchema.safeParse({ ...BASE, steps: [] }).success).toBe(false);
  });
  test('лишний ключ шага схему НЕ проходит (ветвление ловит assertAction раньше — шаг 9)', () => {
    expect(
      actionDefinitionSchema.safeParse({
        ...BASE,
        steps: [{ tool: 'entity_update', input: {}, when: { const: true } }],
      }).success,
    ).toBe(false);
  });
});
