import { useEffect } from 'react';
import { toastActionGeneration } from '../../ui/toast-store';
import { isEditableTarget } from './is-editable-target';
import { isUndoEpoch, undoEpoch } from './undo-epoch';
import { dropUndoable, peekUndoable } from './undo-stack';
/** Нелатинская раскладка допускает физическую KeyZ, латинская сохраняет собственную клавишу. */
export function isUndoChord(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  const key = e.key.toLowerCase();
  return key === 'z' || key === 'я' || (e.code === 'KeyZ' && !/^[a-z]$/.test(key));
}
const OVERLAY =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"]';
/** Одно нажатие берёт только один верхний id; ожидающий запрос не захватывает следующий. */
export function useUndoHotkey(): void {
  useEffect(() => {
    let busyEpoch: number | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!isUndoChord(e) || e.shiftKey || e.repeat || e.defaultPrevented) return;
      if (isEditableTarget(e.target) || document.querySelector(OVERLAY) !== null) return;
      const top = peekUndoable();
      if (top === undefined) return;
      const epoch = undoEpoch();
      let generation = toastActionGeneration();
      e.preventDefault();
      if (busyEpoch === epoch) return;
      busyEpoch = epoch;
      void Promise.all([import('./undo-action'), import('./undo-toast')])
        .then(async ([{ runUndo }, { reportUndoOutcome }]) => {
          if (!isUndoEpoch(epoch)) return;
          let pending = false;
          const run = async (force?: true): Promise<void> => {
            if (pending || !isUndoEpoch(epoch)) return;
            pending = true;
            busyEpoch = epoch;
            const out = await runUndo(top.actionId, {
              ...(top.entityIds !== undefined && { entityIds: top.entityIds }),
              ...(force && { force }),
            });
            pending = false;
            if (busyEpoch === epoch) busyEpoch = undefined;
            if (!isUndoEpoch(epoch)) return;
            if (out.kind === 'undone' || out.kind === 'already') dropUndoable(top.actionId);
            reportUndoOutcome(
              out,
              () => void run(true),
              top.title,
              generation === toastActionGeneration(),
            );
            generation = toastActionGeneration();
          };
          await run();
        })
        .finally(() => {
          if (busyEpoch === epoch) busyEpoch = undefined;
        });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
