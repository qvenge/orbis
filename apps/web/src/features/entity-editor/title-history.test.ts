import { afterEach, expect, test } from 'vitest';
import {
  clearTitleHistories,
  forgetTitleHistory,
  markTitleSent,
  observeTitleValue,
  recordTitleChange,
  redoTitle,
  rejectTitleSend,
  resetTitleHistory,
  undoTitle,
} from './title-history';

afterEach(clearTitleHistories);
test('слово, пауза и смена направления образуют шаги; новая буква стирает повтор', () => {
  expect(recordTitleChange('e', '', 'К', 0)).toBe(true);
  expect(recordTitleChange('e', 'К', 'Ку', 100)).toBe(false);
  expect(recordTitleChange('e', 'Ку', 'Ку ', 200)).toBe(false);
  expect(recordTitleChange('e', 'Ку ', 'Ку х', 300)).toBe(true);
  expect(undoTitle('e', 'Ку х')).toBe('Ку ');
  expect(undoTitle('e', 'Ку ')).toBe('');
  expect(redoTitle('e', '')).toBe('Ку ');
  recordTitleChange('e', 'Ку ', 'Ку а', 400);
  expect(redoTitle('e', 'Ку а')).toBeNull();
  expect(recordTitleChange('e', 'Ку а', 'Ку аб', 900)).toBe(true);
  expect(recordTitleChange('e', 'Ку аб', 'Ку а', 950)).toBe(true);
  resetTitleHistory('e');
  expect(undoTitle('e', 'Ку а')).toBeNull();
});

test('retained observer consumes only provisional prefix; reset preserves basis, eviction forgets', () => {
  expect(observeTitleValue('e', 'A')).toBe(false);
  markTitleSent('e', 'B');
  markTitleSent('e', 'C');
  expect(observeTitleValue('e', 'B')).toBe(false);
  expect(observeTitleValue('e', 'C')).toBe(false);
  expect(observeTitleValue('e', 'B')).toBe(true);
  resetTitleHistory('e');
  expect(observeTitleValue('e', 'D')).toBe(true);
  forgetTitleHistory('e');
  expect(observeTitleValue('e', 'E')).toBe(false);
});
test('duplicate refresh preserves newer pending and noop sends do not trust later foreign return', () => {
  observeTitleValue('e', 'A');
  markTitleSent('e', 'A');
  expect(observeTitleValue('e', 'foreign')).toBe(true);
  expect(observeTitleValue('e', 'A')).toBe(true);
  markTitleSent('e', 'B');
  markTitleSent('e', 'C');
  markTitleSent('e', 'B');
  expect(observeTitleValue('e', 'C')).toBe(false);
  expect(observeTitleValue('e', 'B')).toBe(false);
  expect(observeTitleValue('e', 'C')).toBe(true);
});

test('failed token retires only its own send, preserving newer and duplicate values', () => {
  observeTitleValue('e', 'A');
  const b = markTitleSent('e', 'B');
  markTitleSent('e', 'C');
  rejectTitleSend('e', b);
  expect(observeTitleValue('e', 'B')).toBe(true);
  expect(observeTitleValue('e', 'C')).toBe(false);
  const old = markTitleSent('e', 'D');
  markTitleSent('e', 'D');
  rejectTitleSend('e', old);
  expect(observeTitleValue('e', 'D')).toBe(false);
  expect(markTitleSent('e', 'D')).toBeUndefined();
  rejectTitleSend('e', undefined);
  markTitleSent('e', 'accepted'); // Успешные ещё не наблюдавшиеся отправки сохраняют своё распознавание.
  expect(observeTitleValue('e', 'accepted')).toBe(false);
});
test('late rejection cannot recreate, alter reset basis, or remove a new entry token', () => {
  observeTitleValue('e', 'A');
  const observed = markTitleSent('e', 'B');
  expect(observeTitleValue('e', 'B')).toBe(false);
  markTitleSent('e', 'C');
  rejectTitleSend('e', observed);
  expect(observeTitleValue('e', 'C')).toBe(false);
  const reset = markTitleSent('e', 'D');
  resetTitleHistory('e');
  rejectTitleSend('e', reset);
  expect(observeTitleValue('e', 'D')).toBe(true);
  const evicted = markTitleSent('e', 'E');
  forgetTitleHistory('e');
  rejectTitleSend('e', evicted);
  expect(observeTitleValue('e', 'initial')).toBe(false);
  markTitleSent('e', 'E');
  rejectTitleSend('e', evicted);
  expect(observeTitleValue('e', 'E')).toBe(false);
});

test('coalesced observation retires every earlier unobserved own send', () => {
  observeTitleValue('e', 'A');
  markTitleSent('e', 'B');
  markTitleSent('e', 'C');
  expect(observeTitleValue('e', 'C')).toBe(false);
  expect(observeTitleValue('e', 'B')).toBe(true);
});
