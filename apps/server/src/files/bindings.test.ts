import { expect, test } from 'bun:test';
import { editFileValue } from './bindings';

const a = '15000000-0000-4000-8000-000000000001';
const b = '15000000-0000-4000-8000-000000000002';
const c = '15000000-0000-4000-8000-000000000003';
test('an anchored late upload preserves independent additions and never moves duplicates', () => {
  expect(editFileValue('many', [a, c], { kind: 'add', fileId: b, beforeId: c })).toEqual([a, b, c]);
  expect(editFileValue('many', [a, c], { kind: 'add', fileId: c, beforeId: a })).toEqual([a, c]);
  expect(() => editFileValue('many', [a], { kind: 'add', fileId: b, beforeId: c })).toThrow();
});
test('reordering is a strict permutation of the current ordered value', () => {
  expect(
    editFileValue('many', [a, b], { kind: 'reorder', expected: [a, b], value: [b, a] }),
  ).toEqual([b, a]);
  expect(() =>
    editFileValue('many', [a, b], { kind: 'reorder', expected: [b, a], value: [a, b] }),
  ).toThrow();
  expect(() =>
    editFileValue('many', [a, b], { kind: 'reorder', expected: [a, b], value: [a, c] }),
  ).toThrow();
});
test('replacing and clearing a single file check the actual current value', () => {
  expect(editFileValue('one', a, { kind: 'set', expected: a, fileId: b })).toBe(b);
  expect(editFileValue('one', b, { kind: 'clear', expected: b })).toBeNull();
  expect(() => editFileValue('one', a, { kind: 'set', expected: null, fileId: b })).toThrow();
});
