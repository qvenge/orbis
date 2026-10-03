import { afterEach, expect, test, vi } from 'vitest';
import {
  bindStepOwner,
  canRedoStep,
  canUndoStep,
  clearAllSteps,
  observeFailedTitleBasis,
  pushStep,
  redoStep,
  resetSteps,
  subscribeSteps,
  syncBodyDepth,
  undoStep,
} from './arrows-stack';
import {
  acceptTitleSend,
  forgetTitleHistory,
  markTitleSent,
  observeTitleValue,
  recordTitleChange,
  rejectTitleSend,
  undoTitle,
} from './title-history';

const owner = () => ({ undo: vi.fn(() => true), redo: vi.fn(() => true), reset: vi.fn() });
afterEach(clearAllSteps);
test('единый порядок; свои транзакции не создают шагов и не стирают повтор', () => {
  const t = owner(),
    b = owner();
  bindStepOwner('e', 'title', t);
  bindStepOwner('e', 'body', b);
  pushStep('e', 'title');
  syncBodyDepth('e', 1);
  b.undo.mockImplementation(() => {
    syncBodyDepth('e', 0);
    return true;
  });
  expect(undoStep('e')).toBe(true);
  expect(b.undo).toHaveBeenCalledTimes(1);
  expect(undoStep('e')).toBe(true);
  expect(t.undo).toHaveBeenCalledTimes(1);
  expect([canUndoStep('e'), canRedoStep('e')]).toEqual([false, true]);
  expect(redoStep('e')).toBe(true);
  expect(t.redo).toHaveBeenCalledTimes(1);
  pushStep('e', 'title');
  expect(canRedoStep('e')).toBe(false);
});
test('переполнение снимает самые старые шаги тела, сохраняя заголовок', () => {
  const t = owner(),
    b = owner();
  bindStepOwner('e', 'title', t);
  bindStepOwner('e', 'body', b);
  syncBodyDepth('e', 2);
  pushStep('e', 'title');
  syncBodyDepth('e', 1);
  expect(undoStep('e')).toBe(true);
  expect(t.undo).toHaveBeenCalledOnce();
  expect(undoStep('e')).toBe(true);
  expect(undoStep('e')).toBe(false);
});
test('отсутствующий или отказавший владелец сохраняет шаг; reset и clear уведомляют', () => {
  const notify = vi.fn(),
    off = subscribeSteps(notify);
  pushStep('e', 'title');
  expect(undoStep('e')).toBe(false);
  const t = owner();
  t.undo.mockReturnValue(false);
  bindStepOwner('e', 'title', t);
  expect(undoStep('e')).toBe(false);
  expect(canUndoStep('e')).toBe(true);
  resetSteps('e');
  expect(t.reset).toHaveBeenCalledOnce();
  expect(canUndoStep('e')).toBe(false);
  pushStep('e', 'title');
  clearAllSteps();
  expect(undoStep('e')).toBe(false);
  expect(notify).toHaveBeenCalledTimes(4);
  off();
});

test('лимит снимков заголовка не оставляет неснимаемый шаг в общем порядке', () => {
  let value = '';
  bindStepOwner('e', 'title', {
    undo: () => {
      const prev = undoTitle('e', value);
      if (prev === null) return false;
      value = prev;
      return true;
    },
    redo: () => false,
    reset: () => {},
  });
  for (let i = 0; i < 101; i++) {
    const next = `${i}`;
    expect(recordTitleChange('e', value, next, i * 500)).toBe(true);
    pushStep('e', 'title');
    value = next;
  }
  for (let i = 0; i < 100; i++) expect(undoStep('e')).toBe(true);
  expect(value).toBe('0');
  expect(canUndoStep('e')).toBe(false);
});

test('current title observer survives stale cleanup and reset preserves its binding', () => {
  let value = 'B';
  const old = bindStepOwner('e', 'title', { ...owner(), observe: () => pushStep('e', 'title') });
  const cleanup = bindStepOwner('e', 'title', {
    ...owner(),
    observe: () => {
      if (observeTitleValue('e', value)) resetSteps('e');
    },
  });
  old();
  const body = owner();
  const offBody = bindStepOwner('e', 'body', body);
  observeTitleValue('e', 'A');
  for (const next of ['B', 'C']) {
    recordTitleChange('e', next === 'B' ? 'A' : 'B', next, next === 'B' ? 0 : 1000);
    pushStep('e', 'title');
    syncBodyDepth('e', 1);
    value = next;
    const token = markTitleSent('e', next);
    observeTitleValue('e', next);
    expect(rejectTitleSend('e', token)).toBe(true);
    observeFailedTitleBasis('e');
    expect(undoTitle('e', next)).toBeNull();
    expect(canUndoStep('e')).toBe(false);
  }
  expect(body.reset).toHaveBeenCalledTimes(2);
  cleanup();
  offBody();
  recordTitleChange('e', 'C', 'D', 2000);
  pushStep('e', 'title');
  const detached = markTitleSent('e', 'D');
  observeTitleValue('e', 'D');
  expect(rejectTitleSend('e', detached)).toBe(true);
  observeFailedTitleBasis('e');
  expect(undoTitle('e', 'D')).toBe('C');
  expect(canUndoStep('e')).toBe(true);
});

test('old entry settlement and owner cleanup cannot detach the replacement observer', () => {
  observeTitleValue('e', 'A');
  const cleanup = bindStepOwner('e', 'title', { ...owner(), observe: () => resetSteps('e') });
  const old = markTitleSent('e', 'B');
  observeTitleValue('e', 'B');
  forgetTitleHistory('e');
  observeTitleValue('e', 'A');
  bindStepOwner('e', 'title', {
    ...owner(),
    observe: () => {
      if (observeTitleValue('e', 'B')) resetSteps('e');
    },
  });
  recordTitleChange('e', 'A', 'B', 0);
  pushStep('e', 'title');
  const current = markTitleSent('e', 'B');
  observeTitleValue('e', 'B');
  cleanup();
  acceptTitleSend('e', old);
  expect(rejectTitleSend('e', old)).toBe(false);
  expect(canUndoStep('e')).toBe(true);
  expect(rejectTitleSend('e', current)).toBe(true);
  observeFailedTitleBasis('e');
  expect(undoTitle('e', 'B')).toBeNull();
  expect(canUndoStep('e')).toBe(false);
});

test('classified failed basis falls back to registered body; clear removes old owners', () => {
  const old = owner();
  bindStepOwner('e', 'body', old);
  syncBodyDepth('e', 1);
  observeFailedTitleBasis('e');
  expect(old.reset).toHaveBeenCalledOnce();
  expect(canUndoStep('e')).toBe(false);
  clearAllSteps();
  pushStep('e', 'body');
  observeFailedTitleBasis('e');
  expect(canUndoStep('e')).toBe(true);
  expect(old.reset).toHaveBeenCalledOnce();
  const current = owner();
  bindStepOwner('e', 'body', current);
  observeFailedTitleBasis('e');
  expect(current.reset).toHaveBeenCalledOnce();
  expect(old.reset).toHaveBeenCalledOnce();
  expect(canUndoStep('e')).toBe(false);
});
