import { expect, test } from 'bun:test';
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
