import { afterEach, expect, test } from 'vitest';
import {
  clearTitleHistories,
  forgetTitleHistory,
  markTitleSent,
  observeTitleValue,
  recordTitleChange,
  redoTitle,
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
