import type { Editor } from '@tiptap/core';
import { bindStepOwner, resetSteps, stepsGeneration } from './arrows-stack';
import { forgetTitleHistory } from './title-history';
export const EDITOR_CACHE_CAP = 5;
type Slot = { editor: Editor | null; body: boolean; title: number; generation: number };
/** Один LRU для текста и title-only; активные поля не теряют историю при открытии соседних. */
const slots = new Map<string, Slot>();
const owner = new WeakMap<Editor, string>();
const retired = new Map<Editor, number>();
function evict(): void {
  while (slots.size > EDITOR_CACHE_CAP) {
    const victim = [...slots].find(([, s]) => !s.body && !s.title);
    if (!victim) return;
    const [id, s] = victim;
    slots.delete(id);
    bindStepOwner(id, 'body', null);
    resetSteps(id);
    forgetTitleHistory(id);
    if (s.editor) {
      owner.delete(s.editor);
      s.editor.destroy();
    }
  }
}
function touch(id: string, s: Slot): void {
  slots.delete(id);
  slots.set(id, s);
  evict();
}
export function acquireEditor(id: string, create: () => Editor): Editor {
  const s = recordSlot(id);
  if (s.editor === null || s.editor.isDestroyed) s.editor = create();
  s.body = true;
  owner.set(s.editor, id);
  touch(id, s);
  return s.editor;
}
export function releaseEditor(id: string, editor?: Editor): void {
  const s = slots.get(id);
  if (s && (editor === undefined || s.editor === editor)) s.body = false;
  evict();
}
function recordSlot(id: string): Slot {
  const s = slots.get(id);
  if (s?.generation === stepsGeneration()) return s;
  if (s?.editor) {
    retired.set(s.editor, s.generation);
    owner.delete(s.editor);
  }
  return { editor: null, body: false, title: 0, generation: stepsGeneration() };
}
export function touchRecord(id: string): void {
  touch(id, recordSlot(id));
}
export function mountRecord(id: string): () => void {
  const s = recordSlot(id);
  s.title++;
  touch(id, s);
  return () => {
    if (slots.get(id) === s) {
      s.title--;
      evict();
    }
  };
}
export const hasLiveEditor = (id: string): boolean => {
  const s = slots.get(id),
    e = s?.editor;
  return s?.generation === stepsGeneration() && e != null && !e.isDestroyed;
};
export const entityOfEditor = (e: Editor): string | undefined => owner.get(e);
/** Старый auth cleanup уничтожает только своих редакторов, уже созданные новым владельцем остаются живы. */
export function destroyAllEditors(throughGeneration = Infinity): void {
  for (const [id, s] of slots)
    if (s.generation <= throughGeneration) {
      if (s.editor) {
        owner.delete(s.editor);
        s.editor.destroy();
      }
      slots.delete(id);
    }
  for (const [e, g] of retired)
    if (g <= throughGeneration) {
      e.destroy();
      retired.delete(e);
    }
}
