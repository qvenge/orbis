import { expect, test } from 'bun:test';
import { BUILTIN_CONTRACT_DEFS } from './builtin-contracts';
import { contractDefinitionSchema, contractSetKind } from './contract-type';
import { SLOT_KEY_RE } from './property-type';

const ROW = {
  id: 'orbis/probe',
  graphId: null,
  key: 'orbis/probe',
  label: { ru: 'Проба' },
  description: { ru: 'Проба' },
  kind: 'slots',
  slots: [
    {
      name: 'status',
      type: { kind: 'select' },
      required: true,
      label: { ru: 'Статус' },
      status: true,
    },
  ],
  classes: [{ key: 'done', label: { ru: 'Сделано' } }],
  sets: { closed: ['done'] },
  module: null,
  rank: 1,
};

test('ветка slots: classes/sets по умолчанию пусты, facts — null', () => {
  const def = contractDefinitionSchema.parse({ ...ROW, classes: undefined, sets: undefined });
  expect([def.classes, def.sets, def.facts]).toEqual([[], {}, null]);
});

test('ветка facts: слотов, классов и наборов у неё НЕТ (§Б1-2, orbis/sensitivity)', () => {
  const def = contractDefinitionSchema.parse({
    id: 'orbis/f',
    graphId: null,
    key: 'orbis/f',
    label: { ru: 'Ф' },
    description: { ru: 'Ф' },
    kind: 'facts',
    facts: [{ key: 'external', label: { ru: 'Внешнее' } }],
    module: null,
    rank: 2,
  });
  expect([def.slots, def.classes, def.sets]).toEqual([null, null, null]);
});

test('разбор строгий: поле мимо схемы отвергается, а не уезжает в jsonb молча', () => {
  expect(() => contractDefinitionSchema.parse({ ...ROW, aggregations: {} })).toThrow();
});

test('имя слота, класса и набора — SLOT_KEY_RE: без namespace и без дефисов', () => {
  expect([SLOT_KEY_RE.test('period_start'), SLOT_KEY_RE.test('orbis/status')]).toEqual([
    true,
    false,
  ]);
  expect(() =>
    contractDefinitionSchema.parse({ ...ROW, sets: { 'не-набор': ['done'] } }),
  ).toThrow();
});

test('тип слота: kind словаря, relation_role и «любой из» (не меньше двух)', () => {
  const ok = {
    ...ROW,
    slots: [
      {
        name: 'moment',
        type: { kind: 'any_of', kinds: ['timestamp', 'date'] },
        required: false,
        label: { ru: 'М' },
      },
      { name: 'origin_role', type: { kind: 'relation_role' }, required: false, label: { ru: 'Р' } },
    ],
  };
  expect(contractDefinitionSchema.parse(ok).slots).toHaveLength(2);
  const bad = { ...ROW, slots: [{ ...ROW.slots[0], type: { kind: 'any_of', kinds: ['date'] } }] };
  expect(() => contractDefinitionSchema.parse(bad)).toThrow();
});

test('contractSetKind: списочный набор — list, отсутствующий — unknown', () => {
  const def = contractDefinitionSchema.parse(ROW);
  expect([contractSetKind(def, 'closed'), contractSetKind(def, 'нет')]).toEqual([
    'list',
    'unknown',
  ]);
});

test('contractSetKind: имя из цепочки прототипа набором НЕ считается', () => {
  // Имя набора приезжает из текста запроса, а не из кода: `class=orbis/completable:constructor`
  // обязан отвергаться как неизвестный набор, а не разбираться предикатом.
  const def = contractDefinitionSchema.parse(ROW);
  expect([contractSetKind(def, 'constructor'), contractSetKind(def, 'toString')]).toEqual([
    'unknown',
    'unknown',
  ]);
});

test('exclusive_classes: у slots-ветки умолчание false, у facts-ветки true невыразим (Р-И-38)', () => {
  expect(contractDefinitionSchema.parse(ROW).exclusive_classes).toBe(false); // строка, посеянная до 0022
  expect(
    contractDefinitionSchema.parse({ ...ROW, exclusive_classes: true }).exclusive_classes,
  ).toBe(true);
  const FACTS = {
    id: 'orbis/f',
    graphId: null,
    key: 'orbis/f',
    label: { ru: 'Ф' },
    description: { ru: 'Ф' },
    kind: 'facts',
    facts: [{ key: 'external', label: { ru: 'Внешнее' } }],
    module: null,
    rank: 2,
  };
  // У словаря фактов классов нет вовсе — флаг ПРО КЛАССЫ там не объявляется, но поле обязано разбираться:
  // колонка NOT NULL, и SELECT отдаёт её всем строкам без разбора ветки.
  expect(contractDefinitionSchema.parse(FACTS).exclusive_classes).toBe(false);
  expect(contractDefinitionSchema.safeParse({ ...FACTS, exclusive_classes: true }).success).toBe(
    false,
  );
});

test('BUILTIN_CONTRACT_DEFS собираются схемой: флаг есть у каждого, у словаря фактов — всегда false', () => {
  // Пин БЕЗ «у всех false»: задача 14а сеет `orbis/delegable` с `true`, и такой пин покраснел бы у неё —
  // то есть был бы пином календаря. Инвариант же держится всегда: поле разобрано у КАЖДОЙ строки, а там,
  // где классов нет по построению (`kind:'facts'`), исключительность невыразима (шаг 2б, `z.literal(false)`).
  for (const c of BUILTIN_CONTRACT_DEFS) {
    expect([c.id, typeof c.exclusive_classes]).toEqual([c.id, 'boolean']);
    if (c.kind === 'facts') expect([c.id, c.exclusive_classes]).toEqual([c.id, false]);
  }
});
