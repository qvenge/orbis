import { afterEach, expect, test } from 'vitest';
import {
  clearTitleHistories,
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
