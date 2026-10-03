import { beforeEach, expect, test } from 'vitest';
import {
  clearUndoStack,
  dropUndoable,
  peekUndoable,
  pushUndoable,
  UNDO_STACK_CAP,
} from './undo-stack';

beforeEach(clearUndoStack);
test('стек вкладки: последний, уникальный id, снятие середины и стирание', () => {
  pushUndoable({ actionId: 'a', title: 'Первое' });
  pushUndoable({ actionId: 'b', title: 'Второе' });
  pushUndoable({ actionId: 'a', title: 'Дубликат' });
  expect(peekUndoable()?.actionId).toBe('b');
  dropUndoable('a');
  dropUndoable('b');
  expect(peekUndoable()).toBeUndefined();
  pushUndoable({ actionId: 'c', title: 'Третье' });
  clearUndoStack();
  expect(peekUndoable()).toBeUndefined();
});
test('потолок снимает старейшее', () => {
  for (let i = 0; i <= UNDO_STACK_CAP; i++) pushUndoable({ actionId: String(i), title: String(i) });
  for (let i = UNDO_STACK_CAP; i > 0; i--) {
    expect(peekUndoable()?.actionId).toBe(String(i));
    dropUndoable(String(i));
  }
  expect(peekUndoable()).toBeUndefined();
});

import { vi } from 'vitest';
import { isUndoEpoch, resetUndoSession, subscribeUndoEpoch, undoEpoch } from './undo-epoch';

test('epoch меняется сразу; rapid reset уведомляет актуальных подписчиков после render и уважает unsubscribe', async () => {
  const initial = undoEpoch();
  const old = vi.fn();
  const current = vi.fn();
  const stop = subscribeUndoEpoch(old);
  resetUndoSession();
  stop();
  const cleanup = subscribeUndoEpoch(current);
  resetUndoSession();
  expect(isUndoEpoch(initial)).toBe(false);
  expect(current).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(old).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledTimes(2);
  cleanup();
  resetUndoSession();
  await Promise.resolve();
  expect(current).toHaveBeenCalledTimes(2);
});
