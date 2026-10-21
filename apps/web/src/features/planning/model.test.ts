import { expect, test } from 'vitest';
import {
  classifyInbox,
  type PlanningRecord,
  planningDayOffset,
  planTaskPatch,
  sortPlannedTasks,
} from './model';

const record = (
  id: string,
  props: Record<string, unknown> = {},
  aspects: string[] = [],
): PlanningRecord => ({
  id,
  title: id,
  props,
  aspects,
  tags: [],
  archived: false,
  createdAt: '2026-10-18T12:00:00Z',
});

test('calendar day arithmetic crosses month, year and leap boundaries without local time', () => {
  expect(planningDayOffset('2026-12-31', 1)).toBe('2027-01-01');
  expect(planningDayOffset('2028-02-28', 1)).toBe('2028-02-29');
  expect(planningDayOffset('2026-03-01', -1)).toBe('2026-02-28');
});

test('stable order survives missing and equal plan ranks without mutating input', () => {
  const rows = [
    record('c'),
    record('b', { 'orbis/plan_order': 1 }),
    record('a', { 'orbis/plan_order': 1 }),
  ];
  expect(sortPlannedTasks(rows).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
});

test('planning an existing task preserves active status, deadline, body and links', () => {
  const task = record('a', { 'orbis/task_status': 'waiting', 'orbis/due_date': '2026-11-01' }, [
    'orbis/task',
  ]);
  const patch = planTaskPatch(task, '2026-10-19', 3);
  expect(patch).toEqual({
    id: 'a',
    props: {
      'orbis/planned_date': '2026-10-19',
      'orbis/plan_order': 3,
      'orbis/inbox_state': 'processed',
    },
  });
});

test('planning an inbox task promotes it without creating another entity', () => {
  const patch = planTaskPatch(
    record('a', { 'orbis/task_status': 'inbox' }, ['orbis/task']),
    '2026-10-19',
    0,
  );
  expect(patch.id).toBe('a');
  expect(patch.props?.['orbis/task_status']).toBe('planned');
  expect(patch.props?.['orbis/due_date']).toBeUndefined();
});

test('legacy raw/inbox entries are pending; classified, deferred and archived entries are excluded', () => {
  expect(classifyInbox(record('raw'))).toBe('pending');
  expect(classifyInbox(record('task', { 'orbis/task_status': 'inbox' }, ['orbis/task']))).toBe(
    'pending',
  );
  expect(classifyInbox(record('note', {}, ['orbis/note']))).toBeNull();
  expect(classifyInbox(record('later', { 'orbis/inbox_state': 'later' }))).toBe('later');
  expect(classifyInbox(record('processed', { 'orbis/inbox_state': 'processed' }))).toBeNull();
  expect(classifyInbox({ ...record('ref'), tags: ['gtd-reference'] })).toBeNull();
  expect(classifyInbox({ ...record('deferred'), tags: ['gtd-someday'] })).toBe('later');
  expect(classifyInbox({ ...record('archived'), archived: true })).toBeNull();
  expect(
    classifyInbox(
      record('done', { 'orbis/task_status': 'done', 'orbis/inbox_state': 'pending' }, [
        'orbis/task',
      ]),
    ),
  ).toBeNull();
});
