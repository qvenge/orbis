import type { PropertyDefinition, PropertyType } from '@orbis/shared';
import { wireEntity } from '../../../test/harness';
import { BUILTIN_REGISTRY } from '../../../test/registry';
import type { Entity } from './types';

export const context = { readOnly: false, archived: false, disabledExtensions: [] } as const;
export function field(type: PropertyType, id = 'user/title'): PropertyDefinition {
  const base = BUILTIN_REGISTRY.properties.find(
    (p) => p.type.kind === 'text' && p.storage === 'props',
  );
  if (!base) throw new Error('text fixture отсутствует');
  return {
    ...base,
    id,
    key: id,
    graphId: null,
    label: { ru: 'Поле теста' },
    description: { ru: 'Поле теста' },
    type,
    status: 'active',
    storage: 'props',
    scope: null,
    mergedInto: null,
    module: null,
    rank: 100,
    flags: {},
    rules: [],
  };
}
export const textDef = field({ kind: 'text' });
export const numberDef = field({ kind: 'number' });
export const decimalDef = field({ kind: 'decimal' });
export const timestampDef = field({ kind: 'timestamp' });
export const textManyDef = field({ kind: 'text', cardinality: 'many' });
export const entity: Entity = wireEntity({
  id: '00000000-0000-4000-8000-000000000010',
  title: 'Заметка',
  body: 'Текст остаётся',
  tags: [],
  props: { 'user/title': 'Было' },
  aspects: [],
  archived: false,
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
});
export const registry = {
  ...BUILTIN_REGISTRY,
  properties: [...BUILTIN_REGISTRY.properties, textDef],
};
