import { afterEach, expect, test, vi } from 'vitest';
import {
  acceptTitleSend,
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
  const latestD = markTitleSent('e', 'D');
  rejectTitleSend('e', old);
  expect(observeTitleValue('e', 'D')).toBe(false);
  acceptTitleSend('e', latestD);
  expect(markTitleSent('e', 'D')).toBeUndefined();
  rejectTitleSend('e', undefined);
  const accepted = markTitleSent('e', 'accepted');
  acceptTitleSend('e', accepted); // Успешные ещё не наблюдавшиеся отправки сохраняют своё распознавание.
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

test('failed observed basis is foreign even for the same value; newer pending stays own', () => {
  observeTitleValue('e', 'A');
  const b = markTitleSent('e', 'B');
  expect(observeTitleValue('e', 'B')).toBe(false);
  rejectTitleSend('e', b);
  expect(observeTitleValue('e', 'B')).toBe(true);
  const c = markTitleSent('e', 'C');
  observeTitleValue('e', 'C');
  markTitleSent('e', 'D');
  rejectTitleSend('e', c);
  expect(observeTitleValue('e', 'D')).toBe(false);
});
test('same-value send owns a fresh observed identity without a noop pending marker', () => {
  observeTitleValue('e', 'A');
  const b = markTitleSent('e', 'B');
  observeTitleValue('e', 'B');
  const retry = markTitleSent('e', 'B');
  expect(retry).not.toBe(b);
  acceptTitleSend('e', retry);
  rejectTitleSend('e', b);
  expect(observeTitleValue('e', 'B')).toBe(false);
  expect(markTitleSent('e', 'B')).toBeUndefined();
  expect(observeTitleValue('e', 'foreign')).toBe(true);
  expect(observeTitleValue('e', 'B')).toBe(true);
});
test('new same-value refusal invalidates itself, accepted offscreen send stays recognized', () => {
  observeTitleValue('e', 'A');
  const b = markTitleSent('e', 'B');
  observeTitleValue('e', 'B');
  const retry = markTitleSent('e', 'B');
  rejectTitleSend('e', retry);
  expect(observeTitleValue('e', 'B')).toBe(true);
  acceptTitleSend('e', b); // Старый token уже отделён: поздний успех не подтверждает новую основу.
  expect(observeTitleValue('e', 'B')).toBe(false);
  const c = markTitleSent('e', 'C');
  acceptTitleSend('e', c);
  expect(observeTitleValue('e', 'C')).toBe(false);
  rejectTitleSend('e', c);
  expect(observeTitleValue('e', 'C')).toBe(false);
});
test('foreign/reset/eviction detach observed identity from late settlements', () => {
  observeTitleValue('e', 'A');
  const b = markTitleSent('e', 'B');
  observeTitleValue('e', 'B');
  observeTitleValue('e', 'foreign');
  rejectTitleSend('e', b);
  expect(observeTitleValue('e', 'foreign')).toBe(false);
  const c = markTitleSent('e', 'C');
  observeTitleValue('e', 'C');
  resetTitleHistory('e');
  rejectTitleSend('e', c);
  expect(observeTitleValue('e', 'C')).toBe(false);
  const d = markTitleSent('e', 'D');
  observeTitleValue('e', 'D');
  forgetTitleHistory('e');
  acceptTitleSend('e', d);
  rejectTitleSend('e', d);
  expect(observeTitleValue('e', 'initial')).toBe(false);
});

test('old observed refusal cannot invalidate a newer same-value pending send', () => {
  observeTitleValue('e', 'A');
  const old = markTitleSent('e', 'B');
  observeTitleValue('e', 'B');
  const pending = markTitleSent('e', 'B');
  rejectTitleSend('e', old);
  expect(observeTitleValue('e', 'B')).toBe(false);
  rejectTitleSend('e', pending);
  expect(observeTitleValue('e', 'B')).toBe(true);
});

test('late settlement after eviction does not recreate any history entry', () => {
  observeTitleValue('e', 'A');
  const token = markTitleSent('e', 'B');
  forgetTitleHistory('e');
  const set = vi.spyOn(Map.prototype, 'set');
  let writes = 0;
  try {
    acceptTitleSend('e', token);
    rejectTitleSend('e', token);
    writes = set.mock.calls.length;
  } finally {
    set.mockRestore();
  }
  expect(writes).toBe(0);
  expect(observeTitleValue('e', 'first')).toBe(false);
});
