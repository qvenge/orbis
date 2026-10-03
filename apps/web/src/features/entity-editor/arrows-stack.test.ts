import { afterEach, expect, test, vi } from 'vitest';
import {
  bindStepOwner,
  canRedoStep,
  canUndoStep,
  clearAllSteps,
  pushStep,
  redoStep,
  resetSteps,
  subscribeSteps,
  syncBodyDepth,
  undoStep,
} from './arrows-stack';
import { recordTitleChange, undoTitle } from './title-history';

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
