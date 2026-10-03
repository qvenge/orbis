import { toastActionGeneration } from '../../ui/toast-store';
import type { UndoOutcome } from './undo-action';
import type { OfferUndoInput } from './undo-toast';

/** Предложить отмену из эагерного кода: модуль плашки грузится первым предложением и дальше лежит в кеше модулей. */
let offerGeneration = 0;
export function offerUndoLazy(o: OfferUndoInput): void {
  const generation = ++offerGeneration;
  const actionGeneration = toastActionGeneration();
  void import('./undo-toast').then((m) => {
    if (generation === offerGeneration && actionGeneration === toastActionGeneration())
      m.offerUndo(o);
  });
}
/** «Отменить» вне плашки (карточки треда): исход — плашкой, продолжение — тем же путём с `force` (§8.6). */
export function undoWithReport(
  actionId: string,
  opts: { entityIds?: string[] } = {},
  onOutcome?: (o: UndoOutcome) => void,
): void {
  let generation = toastActionGeneration();
  void Promise.all([import('./undo-action'), import('./undo-toast')]).then(
    ([{ runUndo }, { reportUndoOutcome }]) => {
      let pending = false;
      const run = (force?: true): void => {
        if (pending) return;
        pending = true;
        void runUndo(actionId, { ...opts, ...(force && { force }) }).then((o) => {
          pending = false;
          onOutcome?.(o);
          reportUndoOutcome(o, () => run(true), generation === toastActionGeneration());
          generation = toastActionGeneration();
        });
      };
      run();
    },
  );
}
