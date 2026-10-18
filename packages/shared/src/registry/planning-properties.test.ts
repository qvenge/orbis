import { expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS } from './builtin-aspects';
import { BUILTIN_PROPERTY_META } from './builtin-properties';

test('tasks can store a planned day and order independently of their deadline', () => {
  const task = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/task');
  const fields = task?.properties.map((p) => p.propertyId) ?? [];
  expect(fields).toContain('orbis/planned_date');
  expect(fields).toContain('orbis/plan_order');
  expect(fields).toContain('orbis/due_date');
  expect(BUILTIN_PROPERTY_META.find((p) => p.id === 'orbis/planned_date')?.type.kind).toBe('date');
});

test('raw captures can retain an explicit processing state without being tasks', () => {
  const state = BUILTIN_PROPERTY_META.find((p) => p.id === 'orbis/inbox_state');
  expect(state?.type.kind).toBe('select');
  if (state?.type.kind !== 'select') return;
  expect(state.type.options.map((o) => o.key)).toEqual(['pending', 'processed', 'later']);
});
