import { useToastStore } from '../../ui/toast-store';
import { clearUndoStack } from './undo-stack';

const listeners = new Set<() => void>();
export function subscribeUndoEpoch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
let epoch = 0;
let owner: string | null | undefined;
export const undoEpoch = (): number => epoch;
export const isUndoEpoch = (value: number): boolean => value === epoch;
/** Стирание инвалидирует также ещё не загруженные плашки и ответы старого владельца. */
export function resetUndoSession(): void {
  epoch += 1;
  // Смена scope идёт до рендера дочернего дерева; уведомление не обновляет React внутри родительского рендера.
  queueMicrotask(() => {
    for (const listener of listeners) listener();
  });
  clearUndoStack();
  const store = useToastStore.getState();
  for (const toast of store.toasts) store.dismiss(toast.id);
}
export function setUndoOwner(userId: string | null): void {
  if (owner === userId) return;
  owner = userId;
  resetUndoSession();
}
