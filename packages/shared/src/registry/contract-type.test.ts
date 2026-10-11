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

test('exclusive_classes: схема даёт boolean каждому контракту, исключительность — ровно у делегируемости', () => {
  // Прежний пин держал только форму («флаг есть у каждого, у фактов — false») и строку
  // `orbis/delegable` не видел вовсе (Р-К-92). Ответ «кто exclusive» берётся У САМОЙ ДЕКЛАРАЦИИ:
  // второй список разъехался бы с реестром молча.
  const exclusiveOf = (id: string) =>
    BUILTIN_CONTRACT_DEFS.find((c) => c.id === id)?.exclusive_classes;
  for (const c of BUILTIN_CONTRACT_DEFS) {
    expect([c.id, typeof c.exclusive_classes]).toEqual([c.id, 'boolean']);
    // Там, где классов нет по построению (`kind:'facts'`), исключительность невыразима (`z.literal(false)`).
    if (c.kind === 'facts') expect([c.id, c.exclusive_classes]).toEqual([c.id, false]);
  }
  expect(BUILTIN_CONTRACT_DEFS.filter((c) => c.exclusive_classes).map((c) => c.id)).toEqual([
    'orbis/delegable',
  ]);
  expect(exclusiveOf('orbis/completable')).toBe(false); // класс `active` собирает четыре варианта
  expect(exclusiveOf('orbis/delegable')).toBe(true);
});

/** Контракт с одним слотом заданного типа и ролью — проба правила «роль только у даты» (§3.2 спеки 1в). */
function withRole(type: unknown, role: unknown) {
  return {
    ...ROW,
    slots: [{ name: 'at', type, required: false, label: { ru: 'Когда' }, value_role: role }],
    classes: [],
    sets: {},
  };
}

test('роль слота в значении: у слота с датой принята, у прочих — отказ (§3.2 спеки 1в)', () => {
  const fact = contractDefinitionSchema.parse(withRole({ kind: 'date' }, 'fact'));
  expect(fact.slots?.[0]?.value_role).toBe('fact');
  // any_of с датой среди видов — тоже «слот с датой»: `moment` и `done` у «когда» такие.
  const plan = contractDefinitionSchema.parse(
    withRole({ kind: 'any_of', kinds: ['timestamp', 'date'] }, 'plan'),
  );
  expect(plan.slots?.[0]?.value_role).toBe('plan');
  expect(
    contractDefinitionSchema.parse(withRole({ kind: 'timestamp' }, 'plan')).slots?.[0]?.value_role,
  ).toBe('plan');
  const decimal = contractDefinitionSchema.safeParse(withRole({ kind: 'decimal' }, 'fact'));
  expect(decimal.success).toBe(false);
  expect(decimal.error?.issues.map((i) => i.message)).toContain(
    'роль в значении — только у слота с датой',
  );
  // Роль вне закрытого набора `plan|fact` — отказ, а не молча принятая строка.
  expect(contractDefinitionSchema.safeParse(withRole({ kind: 'date' }, 'maybe')).success).toBe(
    false,
  );
  // Без роли — прежняя форма: слот в значение не входит.
  const none = contractDefinitionSchema.parse({ ...ROW });
  expect(none.slots?.[0]?.value_role).toBeUndefined();
});
