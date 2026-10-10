import {
  APP_NAV,
  type AspectDefinition,
  type PropertyDefinition,
  type PropertyType,
} from '@orbis/shared';
import { describe, expect, test } from 'vitest';
import { wireEntity } from '../../../test/harness';
import { BUILTIN_REGISTRY } from '../../../test/registry';
import {
  aspectAccess,
  freePropertyDefinitions,
  propertyAccess,
  propertyRows,
  roleAccess,
} from './metadata';

const context = { readOnly: false, archived: false, disabledExtensions: [] } as const;
const base = BUILTIN_REGISTRY.properties.find(
  (p) => p.type.kind === 'text' && p.storage === 'props',
);
if (!base) throw new Error('text fixture отсутствует');
const textDef: PropertyDefinition = {
  ...base,
  id: 'user/title',
  key: 'user/title',
  type: { kind: 'text' },
  status: 'active',
  mergedInto: null,
  module: null,
  flags: {},
  rank: 20,
};
const note = BUILTIN_REGISTRY.aspects.find((a) => a.id === 'orbis/note');
if (!note) throw new Error('aspect fixture отсутствует');
const baseAspect: AspectDefinition = note;
function field(
  id: string,
  rank: number,
  type: PropertyType = { kind: 'text' },
): PropertyDefinition {
  return { ...textDef, id, key: id, rank, type };
}
function aspect(id: string, properties: string[]): AspectDefinition {
  return {
    ...baseAspect,
    id,
    key: id,
    module: null,
    service: false,
    properties: properties.map((propertyId, rank) => ({ propertyId, rank, required: false })),
  };
}

test('propertyRows: общие id однократны, носители только текущие, пустые/free/unknown сохранены', () => {
  const empty = field('user/empty', 10);
  const free = field('user/free', 20);
  const first = aspect('user/first', [textDef.id, empty.id]);
  const second = aspect('user/second', [textDef.id]);
  const absent = aspect('user/absent', [textDef.id]);
  const registry = {
    ...BUILTIN_REGISTRY,
    properties: [textDef, empty, free],
    aspects: [absent, second, first],
  };
  const entity = wireEntity({
    id: 'e1',
    title: 'Запись',
    aspects: [first.id, second.id],
    props: { [textDef.id]: 'Общий', [free.id]: false, 'user/unknown': 0 },
  });
  const rows = propertyRows(entity, registry);
  expect(rows.map((r) => r.id)).toEqual([empty.id, free.id, textDef.id, 'user/unknown']);
  expect(rows.filter((r) => r.id === textDef.id)).toHaveLength(1);
  expect(rows.find((r) => r.id === textDef.id)).toMatchObject({
    present: true,
    value: 'Общий',
    carrierIds: [first.id, second.id],
  });
  expect(rows.find((r) => r.id === empty.id)).toMatchObject({
    present: false,
    value: undefined,
    carrierIds: [first.id],
  });
  expect(rows.find((r) => r.id === free.id)).toMatchObject({
    present: true,
    value: false,
    carrierIds: [],
  });
  expect(rows.find((r) => r.id === 'user/unknown')).toMatchObject({
    def: undefined,
    present: true,
    value: 0,
    carrierIds: [],
  });
  expect(entity.props).toEqual({ [textDef.id]: 'Общий', [free.id]: false, 'user/unknown': 0 });
});

test('freePropertyDefinitions: полный props словарь без scope evaluator, текущих строк и obsolete definitions', () => {
  const scoped = { ...field('user/scoped', 5), scope: { filter: { aspect: 'orbis/task' } } };
  const deprecated = { ...field('user/old', 6), status: 'deprecated' as const };
  const merged = { ...field('user/merged', 7), mergedInto: textDef.id };
  const core = { ...field('user/core', 8), storage: 'core' as const };
  const proposed = { ...field('user/proposed', 5), status: 'proposed' as const };
  const current = aspect('user/current', [textDef.id]);
  const registry = {
    ...BUILTIN_REGISTRY,
    properties: [textDef, scoped, deprecated, merged, core, proposed],
    aspects: [current],
  };
  expect(
    freePropertyDefinitions(
      wireEntity({ id: 'e1', title: 'Запись', aspects: [current.id] }),
      registry,
    ).map((p) => p.id),
  ).toEqual([proposed.id, scoped.id]);
  expect(proposed.status).toBe('proposed');
});

describe('propertyAccess: ограничения впереди типа и отдельная очистка', () => {
  test.each([
    ['обычное поле', textDef, context, true, true, 'generic'],
    [
      'proposed не активируется',
      { ...textDef, status: 'proposed' },
      context,
      true,
      true,
      'generic',
    ],
    [
      'deprecated можно очистить',
      { ...textDef, status: 'deprecated' },
      context,
      false,
      true,
      'unavailable',
    ],
    ['unknown', undefined, context, false, false, 'unavailable'],
    [
      'json без редактора',
      { ...textDef, type: { kind: 'json' } },
      context,
      false,
      true,
      'unavailable',
    ],
    [
      'system',
      { ...textDef, flags: { system_writable: true } },
      context,
      false,
      false,
      'unavailable',
    ],
    [
      'computed',
      { ...textDef, flags: { model_writable: false } },
      context,
      false,
      false,
      'unavailable',
    ],
    ['writer', { ...textDef, flags: { writer: 'supply' } }, context, false, false, 'unavailable'],
    [
      'deprecated system',
      { ...textDef, status: 'deprecated', flags: { system_writable: true } },
      context,
      false,
      false,
      'unavailable',
    ],
    [
      'unsupported system',
      { ...textDef, type: { kind: 'json' }, flags: { system_writable: true } },
      context,
      false,
      false,
      'unavailable',
    ],
    [
      'mask',
      { ...textDef, module: 'finance' },
      { ...context, disabledExtensions: ['finance'] },
      false,
      false,
      'unavailable',
    ],
    ['core', { ...textDef, storage: 'core' }, context, false, false, 'unavailable'],
    ['merged', { ...textDef, mergedInto: 'user/successor' }, context, false, false, 'unavailable'],
    ['readOnly', textDef, { ...context, readOnly: true }, false, false, 'unavailable'],
    ['archived', textDef, { ...context, archived: true }, false, false, 'unavailable'],
  ] as const)('%s', (_name, def, ctx, canSet, canUnset, editor) => {
    const access = propertyAccess(def, ctx);
    expect(access).toMatchObject({ canSet, canUnset, editor });
    if (!canSet) expect(access.reason).toEqual(expect.any(String));
  });
  test('причина слияния указывает преемника, новые значения не предлагаются', () => {
    expect(propertyAccess({ ...textDef, mergedInto: 'user/successor' }, context).reason).toContain(
      'user/successor',
    );
  });
  test.each([
    'orbis/executor',
    'orbis/grant',
    'orbis/may_close',
    'orbis/assignee',
  ])('назначение %s только общей формой', (id) => {
    const def = BUILTIN_REGISTRY.properties.find((p) => p.id === id);
    expect(propertyAccess(def, context)).toMatchObject({
      canSet: false,
      canUnset: false,
      editor: 'assignment',
    });
    expect(propertyAccess(def, { ...context, readOnly: true }).editor).toBe('unavailable');
  });
  test('навигация сохраняет специальный контрол', () => {
    expect(
      propertyAccess(
        BUILTIN_REGISTRY.properties.find((p) => p.id === APP_NAV),
        context,
      ),
    ).toMatchObject({ editor: 'navigation', canSet: true, canUnset: true });
  });
  test.each([
    { kind: 'text', cardinality: 'many' },
    { kind: 'number', cardinality: 'many' },
    { kind: 'decimal', cardinality: 'many' },
    { kind: 'ref', cardinality: 'many' },
  ] as const)('списки первого выпуска %s доступны generic', (type) => {
    expect(propertyAccess(field('user/list', 1, type), context)).toMatchObject({
      editor: 'generic',
      canSet: true,
      canUnset: true,
    });
  });
});

test('aspectAccess: специальные маршруты не предлагают generic mutation', () => {
  const ordinary = aspect('user/custom', []);
  expect(aspectAccess(ordinary, context)).toMatchObject({
    canAttach: true,
    canDetach: true,
    route: 'generic',
  });
  expect(aspectAccess({ ...ordinary, service: true }, context)).toMatchObject({
    canAttach: false,
    canDetach: false,
    route: 'readonly',
  });
  expect(
    aspectAccess(
      { ...ordinary, module: 'finance' },
      { ...context, disabledExtensions: ['finance'] },
    ),
  ).toMatchObject({ canAttach: false, canDetach: false, route: 'readonly' });
  expect(aspectAccess(undefined, context)).toMatchObject({
    canAttach: false,
    canDetach: false,
    route: 'readonly',
  });
  for (const [id, route] of [
    ['orbis/assignment', 'assignment'],
    ['orbis/page', 'page'],
    ['orbis/app', 'app'],
    ['orbis/supply', 'readonly'],
  ] as const) {
    const def = BUILTIN_REGISTRY.aspects.find((a) => a.id === id);
    expect(aspectAccess(def, context)).toMatchObject({ canAttach: false, canDetach: false, route });
    expect(aspectAccess(def, { ...context, archived: true }).route).toBe('readonly');
  }
  expect(
    aspectAccess(
      BUILTIN_REGISTRY.aspects.find((a) => a.id === 'orbis/routine'),
      context,
    ).route,
  ).toBe('generic');
});

test('roleAccess: только ручные роли и доступный context', () => {
  const mention = BUILTIN_REGISTRY.roles.find((r) => r.id === 'mention');
  if (!mention) throw new Error('mention fixture отсутствует');
  expect(roleAccess(mention, context)).toEqual({ canCreate: true, canDelete: true });
  for (const id of ['ref', 'run'])
    expect(
      roleAccess(
        BUILTIN_REGISTRY.roles.find((r) => r.id === id),
        context,
      ),
    ).toMatchObject({ canCreate: false, canDelete: false });
  expect(roleAccess(undefined, context)).toMatchObject({ canCreate: false, canDelete: false });
  expect(roleAccess(mention, { ...context, readOnly: true })).toMatchObject({
    canCreate: false,
    canDelete: false,
  });
  expect(roleAccess(mention, { ...context, archived: true })).toMatchObject({
    canCreate: false,
    canDelete: false,
  });
  expect(
    roleAccess({ ...mention, module: 'finance' }, { ...context, disabledExtensions: ['finance'] }),
  ).toMatchObject({ canCreate: false, canDelete: false });
});

test('сохранённые obsolete/null значения остаются строками с исходным определением', () => {
  const merged = { ...textDef, mergedInto: 'user/successor' };
  const entity = wireEntity({ id: 'e1', title: 'Запись', props: { [textDef.id]: null } });
  const registry = { ...BUILTIN_REGISTRY, properties: [merged] };
  expect(propertyRows(entity, registry)).toEqual([
    { id: textDef.id, def: merged, value: null, present: true, carrierIds: [], rank: merged.rank },
  ]);
  expect(freePropertyDefinitions(entity, registry)).toEqual([]);
});

test.each([
  { kind: 'boolean' },
  { kind: 'date' },
  { kind: 'time' },
  { kind: 'timestamp' },
  { kind: 'select', options: [{ key: 'one', label: { ru: 'Один' }, rank: 1 }] },
  {
    kind: 'select',
    options: [{ key: 'one', label: { ru: 'Один' }, rank: 1 }],
    cardinality: 'many',
  },
  { kind: 'registry_ref', target: 'aspect', cardinality: 'many' },
] satisfies PropertyType[])('существующий контрол %s остаётся generic', (type) => {
  expect(propertyAccess(field('user/value', 1, type), context)).toMatchObject({
    canSet: true,
    canUnset: true,
    editor: 'generic',
  });
});

test.each([
  { kind: 'grant' },
  { kind: 'registry_ref', target: 'aspect' },
  { kind: 'registry_ref', target: 'property', cardinality: 'many' },
] as const)('тип без контрола %s сохраняет разрешённое снятие', (type) => {
  expect(propertyAccess(field('user/value', 1, type), context)).toMatchObject({
    canSet: false,
    canUnset: true,
    editor: 'unavailable',
  });
});

test('special assignment уважает gates флагов и mask до выбора редактора', () => {
  const def = BUILTIN_REGISTRY.properties.find((p) => p.id === 'orbis/executor');
  if (!def) throw new Error('assignment fixture отсутствует');
  for (const flags of [
    { system_writable: true },
    { model_writable: false },
    { writer: 'supply' as const },
  ]) {
    expect(propertyAccess({ ...def, flags }, context)).toMatchObject({
      canSet: false,
      canUnset: false,
      editor: 'unavailable',
    });
  }
  expect(
    propertyAccess({ ...def, module: 'finance' }, { ...context, disabledExtensions: ['finance'] })
      .editor,
  ).toBe('unavailable');
});
