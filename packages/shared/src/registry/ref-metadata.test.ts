import { expect, test } from 'bun:test';
import { RULE_MIRROR_REF } from './builtin-rules';
import { mirrorMetaKey, mirrorPropertyId } from './ref-metadata';
import { ruleDefinitionSchema } from './rule-type';

test('зеркало читает meta_key единственного включённого правила', () => {
  const mirror = ruleDefinitionSchema.parse(RULE_MIRROR_REF);
  expect(mirrorMetaKey([mirror])).toBe('property');
  expect(mirrorPropertyId([mirror], { property: 'user/owner' })).toBe('user/owner');
  expect(mirrorPropertyId([mirror], { property: 1 })).toBeUndefined();
  expect(mirrorPropertyId([mirror], { property: '' })).toBeUndefined();
  expect(mirrorPropertyId([mirror], {})).toBeUndefined();
  expect(mirrorMetaKey([])).toBeUndefined();
  expect(mirrorMetaKey([mirror, mirror])).toBeUndefined();
  expect(mirrorMetaKey([{ ...mirror, enabled: false }])).toBeUndefined();
  expect(mirrorMetaKey([mirror, { ...mirror, enabled: false }])).toBe('property');
});

test('ключ метки следует декларации, другие шаблоны не считаются зеркалом', () => {
  const mirror = ruleDefinitionSchema.parse({
    ...RULE_MIRROR_REF,
    params: { meta_key: 'cause', skip_computed: true },
  });
  const other = ruleDefinitionSchema.parse({
    id: 'default',
    template: 'default',
    params: { property: 'user/name', value: { const: 'x' } },
  });
  expect(mirrorMetaKey([other, mirror])).toBe('cause');
  expect(mirrorPropertyId([other, mirror], { cause: 'user/name', property: 'user/wrong' })).toBe(
    'user/name',
  );
  expect(mirrorPropertyId([mirror, mirror], { cause: 'user/name' })).toBeUndefined();
});
