import { toastActionGeneration } from '../../ui/toast-store';
import type { UndoOutcome } from './undo-action';
import { isUndoEpoch, undoEpoch } from './undo-epoch';
import { dropUndoable, pushUndoable } from './undo-stack';
import type { OfferUndoInput } from './undo-toast';

/** Предложить отмену из эагерного кода: модуль плашки грузится первым предложением и дальше лежит в кеше модулей. */
let offerGeneration = 0;
export function offerUndoLazy(o: OfferUndoInput): void {
  pushUndoable({
    actionId: o.actionId,
    title: o.title,
    ...(o.entityIds !== undefined && { entityIds: o.entityIds }),
  });
  const epoch = undoEpoch();
  const generation = ++offerGeneration;
  const actionGeneration = toastActionGeneration();
  void import('./undo-toast').then((m) => {
    if (
      isUndoEpoch(epoch) &&
      generation === offerGeneration &&
      actionGeneration === toastActionGeneration()
    )
      m.offerUndo(o);
  });
}
/** «Отменить» вне плашки (карточки треда): исход — плашкой, продолжение — тем же путём с `force` (§8.6). */
export function undoWithReport(
  actionId: string,
  opts: { entityIds?: string[] } = {},
  onOutcome?: (o: UndoOutcome) => void,
  onPending?: (pending: boolean) => void,
): void {
  const epoch = undoEpoch();
  let generation = toastActionGeneration();
  void Promise.all([import('./undo-action'), import('./undo-toast')]).then(
    ([{ runUndo }, { reportUndoOutcome }]) => {
      if (!isUndoEpoch(epoch)) return;
      let pending = false;
      const run = (force?: true): void => {
        if (pending || !isUndoEpoch(epoch)) return;
        pending = true;
        onPending?.(true);
        void runUndo(actionId, { ...opts, ...(force && { force }) }).then((o) => {
          if (!isUndoEpoch(epoch)) return;
          pending = false;
          onPending?.(false);
          if (o.kind === 'undone' || o.kind === 'already') dropUndoable(actionId);
          onOutcome?.(o);
          reportUndoOutcome(o, () => run(true), generation === toastActionGeneration());
          generation = toastActionGeneration();
        });
      };
      run();
    },
  );
}
