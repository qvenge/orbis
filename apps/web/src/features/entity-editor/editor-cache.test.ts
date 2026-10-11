import type { Editor } from '@tiptap/core';
import { afterEach, expect, test, vi } from 'vitest';
import { canUndoStep, clearAllSteps, pushStep } from './arrows-stack';
import {
  acquireEditor,
  destroyAllEditors,
  entityOfEditor,
  hasLiveEditor,
  releaseEditor,
  touchRecord,
} from './editor-cache';

const create = () => ({ destroy: vi.fn(), isDestroyed: false }) as unknown as Editor;
afterEach(() => {
  destroyAllEditors();
  clearAllSteps();
});
test('тот же экземпляр; шестая отпущенная запись вытесняет старейшую и её шаги', () => {
  const fn = vi.fn(create),
    e = acquireEditor('e1', fn);
  expect(acquireEditor('e1', fn)).toBe(e);
  expect(fn).toHaveBeenCalledOnce();
  expect(entityOfEditor(e)).toBe('e1');
  pushStep('e1', 'title');
  releaseEditor('e1');
  for (let i = 2; i <= 6; i++) {
    acquireEditor(`e${i}`, create);
    releaseEditor(`e${i}`);
  }
  expect(e.destroy).toHaveBeenCalledOnce();
  expect(hasLiveEditor('e1')).toBe(false);
  expect(canUndoStep('e1')).toBe(false);
});
test('смонтированный редактор не вытесняется; title-only имеет тот же LRU', () => {
  const e = acquireEditor('e1', create);
  touchRecord('title');
  pushStep('title', 'title');
  for (let i = 2; i <= 5; i++) {
    acquireEditor(`e${i}`, create);
    releaseEditor(`e${i}`);
  }
  expect(e.destroy).not.toHaveBeenCalled();
  expect(canUndoStep('title')).toBe(false);
  destroyAllEditors();
  expect(e.destroy).toHaveBeenCalledOnce();
  expect(hasLiveEditor('e1')).toBe(false);
});
