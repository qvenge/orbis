import { expect, test } from 'bun:test';
import { checkImplements } from './bindings';
import { BUILTIN_CONTRACT_DEFS, BUILTIN_PROPERTY_META } from './index';
import { aspectImplementsSchema } from './property-type';

test('форма привязки §Б2-1: полный разбор, умолчания трёх полей, .strict()', () => {
  const full = aspectImplementsSchema.parse({
    contract: 'orbis/completable',
    bind: { status: 'orbis/task_status' },
    value_map: [{ slot: 'status', variant: 'done', class: 'done' }],
    fixed: { origin_role: 'instance-of' },
  });
  expect(full.bind.status).toBe('orbis/task_status');
  // Привязка без карты и констант законна: обязательность value_map «при слоте-статусе»
  // (§Б2-2) схеме невыразима — слоты лежат в другой строке реестра.
  expect(aspectImplementsSchema.parse({ contract: 'orbis/when' })).toEqual({
    contract: 'orbis/when',
    bind: {},
    value_map: [],
    fixed: {},
  });
  // Boolean-вариант — ЛИТЕРАЛОМ (§Б2-2 «true→done»), не строкой "true".
  expect(
    aspectImplementsSchema.parse({
      contract: 'c',
      value_map: [{ slot: 's', variant: true, class: 'k' }],
    }).value_map[0]?.variant,
  ).toBe(true);
  // Поле мимо формы не проезжает в jsonb молча (докблок property-type.ts:1-9).
  const bad: unknown[] = [
    { contract: 'c', bindings: {} },
    { contract: 'c', value_map: [{ slot: 's', variant: 'v', class: 'k', note: 'x' }] },
    { contract: 'c', bind: { Status: 'orbis/x' } }, // ключ — слаг SLOT_KEY_RE
    { contract: 'c', fixed: { s: null } },
  ];
  for (const v of bad) expect([v, aspectImplementsSchema.safeParse(v).success]).toEqual([v, false]);
});

const reg = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
};
/** Аспект-проба: носит ровно то, что перечислено, и ничего больше. */
function probe(props: readonly string[], impl: readonly unknown[]) {
  return {
    id: 'user/probe',
    properties: props.map((propertyId, i) => ({ propertyId, required: false, rank: i + 1 })),
    implements: impl.map((b) => aspectImplementsSchema.parse(b)),
  };
}
const codes = (a: Parameters<typeof checkImplements>[0]) =>
  checkImplements(a, reg).map((i) => i.code);

test('checkImplements: BIND_TYPE — kind свойства не тот, что у слота', () => {
  expect(
    checkImplements(
      probe(['orbis/amount'], [{ contract: 'orbis/when', bind: { deadline: 'orbis/amount' } }]),
      reg,
    ),
  ).toEqual([
    {
      code: 'BIND_TYPE',
      details: {
        aspect: 'user/probe',
        contract: 'orbis/when',
        slot: 'deadline',
        propertyId: 'orbis/amount',
        slotType: 'date',
        propertyKind: 'decimal',
      },
    },
  ]);
  // `any_of` принимает ЛЮБОЙ из перечисленных: у `moment` это timestamp и date.
  expect(
    codes(
      probe(['orbis/start_at'], [{ contract: 'orbis/when', bind: { moment: 'orbis/start_at' } }]),
    ),
  ).toEqual([]);
  expect(
    codes(
      probe(['orbis/due_date'], [{ contract: 'orbis/when', bind: { moment: 'orbis/due_date' } }]),
    ),
  ).toEqual([]);
  // relation_role — слот, значением которого служит РОЛЬ РЕБРА (§Б1-1): свойства такого kind в
  // словаре нет вовсе, поэтому bind под него — всегда BIND_TYPE, а закрыть его можно константой.
  expect(
    codes(
      probe(
        ['orbis/recurrence'],
        [{ contract: 'orbis/recurrence', bind: { origin_role: 'orbis/recurrence' } }],
      ),
    ),
  ).toContain('BIND_TYPE');
  expect(
    checkImplements(
      probe([], [{ contract: 'orbis/recurrence', fixed: { origin_role: 'instance-of' } }]),
      reg,
    ),
  ).toEqual([]);
  expect(codes(probe([], [{ contract: 'orbis/recurrence', fixed: { origin_role: 7 } }]))).toEqual([
    'BIND_TYPE',
  ]);
});

test('checkImplements: неизвестный контракт, форма фактов, неизвестный слот и свойство', () => {
  expect(checkImplements(probe([], [{ contract: 'orbis/nope' }]), reg)[0]).toEqual({
    code: 'UNKNOWN_CONTRACT',
    details: { aspect: 'user/probe', contract: 'orbis/nope', reason: 'absent' },
  });
  // `orbis/sensitivity` — форма `{kind:"facts"}`: слотов нет, аспект его НЕ реализует (§Б1-2).
  expect(
    checkImplements(probe([], [{ contract: 'orbis/sensitivity' }]), reg)[0]?.details,
  ).toMatchObject({ reason: 'facts' });
  expect(
    codes(
      probe(['orbis/due_date'], [{ contract: 'orbis/when', bind: { nope: 'orbis/due_date' } }]),
    ),
  ).toEqual(['UNKNOWN_SLOT']);
  // Два отнесения на один несуществующий слот дают ОДНО замечание, а не два.
  expect(
    codes(
      probe(
        [],
        [
          {
            contract: 'orbis/when',
            value_map: [
              { slot: 'nope', variant: 'a', class: 'x' },
              { slot: 'nope', variant: 'b', class: 'x' },
            ],
          },
        ],
      ),
    ),
  ).toEqual(['UNKNOWN_SLOT']);
  expect(codes(probe([], [{ contract: 'orbis/when', bind: { deadline: 'orbis/ghost' } }]))).toEqual(
    ['UNKNOWN_PROPERTY'],
  );
  // Свойство есть в словаре, но аспект его не носит: слот обещан значением, которого у сущностей
  // этого аспекта не бывает.
  expect(
    checkImplements(
      probe([], [{ contract: 'orbis/when', bind: { deadline: 'orbis/due_date' } }]),
      reg,
    )[0],
  ).toEqual({
    code: 'UNKNOWN_PROPERTY',
    details: {
      aspect: 'user/probe',
      contract: 'orbis/when',
      slot: 'deadline',
      propertyId: 'orbis/due_date',
      reason: 'not_carried',
    },
  });
  // REQUIRED_SLOT_UNBOUND: обязательный слот закрыт свойством ИЛИ константой (§Б2-1).
  expect(
    checkImplements(
      probe(['orbis/limit'], [{ contract: 'orbis/envelope', bind: { limit: 'orbis/limit' } }]),
      reg,
    )
      .filter((i) => i.code === 'REQUIRED_SLOT_UNBOUND')
      .map((i) => i.details.slot)
      .sort(),
  ).toEqual(['category', 'period_end', 'period_start']);
});

const TASK_MAP = [
  { slot: 'status', variant: 'inbox', class: 'active' },
  { slot: 'status', variant: 'planned', class: 'active' },
  { slot: 'status', variant: 'in_progress', class: 'active' },
  { slot: 'status', variant: 'waiting', class: 'active' },
  { slot: 'status', variant: 'done', class: 'done' },
  { slot: 'status', variant: 'cancelled', class: 'cancelled' },
];

test('VARIANT_UNMAPPED: у слота-статуса отнесён КАЖДЫЙ вариант свойства (§Б2-2)', () => {
  const bound = (value_map: unknown[]) =>
    probe(
      ['orbis/task_status'],
      [{ contract: 'orbis/completable', bind: { status: 'orbis/task_status' }, value_map }],
    );
  expect(checkImplements(bound(TASK_MAP), reg)).toEqual([]);
  expect(checkImplements(bound(TASK_MAP.filter((m) => m.variant !== 'waiting')), reg)).toEqual([
    {
      code: 'VARIANT_UNMAPPED',
      details: {
        aspect: 'user/probe',
        contract: 'orbis/completable',
        slot: 'status',
        propertyId: 'orbis/task_status',
        variant: 'waiting',
        reason: 'unmapped',
      },
    },
  ]);
  // Класс не из контракта — отнесение в никуда: набор `closed` его не увидит.
  expect(
    checkImplements(
      bound([...TASK_MAP.slice(0, 5), { slot: 'status', variant: 'cancelled', class: 'dropped' }]),
      reg,
    ).map((i) => i.details.reason),
  ).toEqual(['unknown_class', 'unmapped']);
});

test('VARIANT_UNMAPPED: boolean — литералы, json — present/absent (Р-К-3)', () => {
  const marker = (propertyId: string, value_map: unknown[]) =>
    probe(
      [propertyId],
      [
        {
          contract: 'orbis/recurrence',
          bind: { template_marker: propertyId },
          value_map,
          fixed: { origin_role: 'instance-of' },
        },
      ],
    );
  const LITERALS = [
    { slot: 'template_marker', variant: true, class: 'template' },
    { slot: 'template_marker', variant: false, class: 'instance' },
  ];
  const MARKERS = [
    { slot: 'template_marker', variant: 'present', class: 'template' },
    { slot: 'template_marker', variant: 'absent', class: 'instance' },
  ];
  expect(checkImplements(marker('orbis/recurring', LITERALS), reg)).toEqual([]); // boolean
  expect(checkImplements(marker('orbis/recurrence', MARKERS), reg)).toEqual([]); // json
  // Перепутать нельзя: маркер наличия у boolean-свойства оставил бы `true` без класса, а сам в
  // данных не встретился бы никогда.
  expect(
    checkImplements(marker('orbis/recurring', MARKERS), reg).map((i) => [
      i.details.variant,
      i.details.reason,
    ]),
  ).toEqual([
    [true, 'unmapped'],
    [false, 'unmapped'],
    ['present', 'unknown_variant'],
    ['absent', 'unknown_variant'],
  ]);
  expect(
    checkImplements(marker('orbis/recurrence', LITERALS), reg).map((i) => i.details.reason),
  ).toEqual(['unmapped', 'unmapped', 'unknown_variant', 'unknown_variant']);
});

test('VARIANT_UNMAPPED: слот-статус, закрытый константой, тоже требует отнесения; не-статус — нет', () => {
  // П1 №3 «хотелка»: `direction: expense` константой — класс постоянного значения обязан быть
  // назван, иначе сущность не попадёт ни в `outflow`, ни в `inflow`.
  const wish = (value_map: unknown[]) =>
    probe(
      ['orbis/amount', 'orbis/finance_category', 'orbis/occurred_on'],
      [
        {
          contract: 'orbis/money-movement',
          fixed: { direction: 'expense' },
          value_map,
          bind: {
            amount: 'orbis/amount',
            category: 'orbis/finance_category',
            date: 'orbis/occurred_on',
          },
        },
      ],
    );
  expect(codes(wish([]))).toEqual(['VARIANT_UNMAPPED']);
  expect(codes(wish([{ slot: 'direction', variant: 'expense', class: 'outflow' }]))).toEqual([]);
  // У `orbis/when` слотов-статусов нет — карта не требуется вовсе (§Б2-2, ревизия 3).
  expect(
    codes(
      probe(['orbis/due_date'], [{ contract: 'orbis/when', bind: { deadline: 'orbis/due_date' } }]),
    ),
  ).toEqual([]);
});
