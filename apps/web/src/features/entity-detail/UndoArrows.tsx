import { Redo2, Undo2 } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { KeyboardBar } from '../../app/KeyboardBar';
import {
  canRedoStep,
  canUndoStep,
  redoStep,
  subscribeSteps,
  undoStep,
} from '../entity-editor/arrows-stack';
export const STEP_BACK = 'Шаг назад';
export const STEP_FORWARD = 'Шаг вперёд';
const BTN =
  'flex size-8 items-center justify-center rounded-md text-text-muted transition hover:bg-surface-2 disabled:opacity-40';
export function UndoArrows({
  entityId,
  variant,
}: {
  entityId: string;
  variant: 'inline' | 'keyboard';
}) {
  const back = useSyncExternalStore(subscribeSteps, () => canUndoStep(entityId)),
    forward = useSyncExternalStore(subscribeSteps, () => canRedoStep(entityId));
  const keep = (e: { preventDefault(): void }) => e.preventDefault();
  const buttons = (
    <>
      <button
        type="button"
        aria-label={STEP_BACK}
        disabled={!back}
        onMouseDown={keep}
        onClick={() => undoStep(entityId)}
        className={BTN}
      >
        <Undo2 size={16} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={STEP_FORWARD}
        disabled={!forward}
        onMouseDown={keep}
        onClick={() => redoStep(entityId)}
        className={BTN}
      >
        <Redo2 size={16} aria-hidden />
      </button>
    </>
  );
  return variant === 'keyboard' ? (
    <KeyboardBar entityId={entityId}>{buttons}</KeyboardBar>
  ) : (
    <div data-testid="undo-arrows" className="flex shrink-0 items-center gap-0.5">
      {buttons}
    </div>
  );
}
