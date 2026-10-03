import type { BodyActionInfo } from '@orbis/shared';
import { Undo2 } from 'lucide-react';
import { useRef, useSyncExternalStore } from 'react';
import { formatClock } from '../../lib/format-clock';
import { trpc } from '../../trpc';
import type { DropdownMenuItem } from '../../ui/DropdownMenu';
import { toastActionGeneration } from '../../ui/toast-store';
import { resetSteps } from '../entity-editor/arrows-stack';
import { runUndo } from '../undo/undo-action';
import { isUndoEpoch, subscribeUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import { dropUndoable } from '../undo/undo-stack';
import { reportUndoOutcome } from '../undo/undo-toast';

/** У сменённого сеанса известен только старт; подпись называет часы в поясе владельца (§8.5). */
export function revertTextLabel(
  a: BodyActionInfo,
  tz: string | undefined,
  now: Date = new Date(),
): string {
  const start = formatClock(a.startedAt, tz, now);
  const span = a.endedAt === null ? start : `${start}–${formatClock(a.endedAt, tz, now)}`;
  return `Вернуть текст как на ${start} · правка текста ${span}`;
}

/** Серверный действующий сеанс доступен и после reload; досыл и страховку версией ведёт общий путь отмены. */
export function useRevertTextItem(
  entityId: string,
  bodyAction: BodyActionInfo | null,
): DropdownMenuItem | null {
  const tz = trpc.user.getSettings.useQuery().data?.timezone;
  const epoch = useSyncExternalStore(subscribeUndoEpoch, undoEpoch, undoEpoch);
  const flight = useRef({ epoch, pending: false });
  if (flight.current.epoch !== epoch) flight.current = { epoch, pending: false };
  const owned = flight.current;
  if (bodyAction === null || !bodyAction.textSession || !bodyAction.mine) return null;
  const { actionId } = bodyAction;
  const run = (force?: true): void => {
    // Старое меню и его продолжение принадлежат исходному владельцу, даже до начала досыла.
    if (owned.pending || !isUndoEpoch(epoch)) return;
    owned.pending = true;
    const generation = toastActionGeneration();
    void runUndo(actionId, { entityIds: [entityId], ...(force && { force }) }).then((out) => {
      if (!isUndoEpoch(epoch)) return;
      owned.pending = false;
      if (out.kind === 'undone') resetSteps(entityId);
      if (out.kind === 'undone' || out.kind === 'already') dropUndoable(actionId);
      reportUndoOutcome(out, () => run(true), generation === toastActionGeneration());
    });
  };
  return {
    key: 'revert-text',
    label: revertTextLabel(bodyAction, tz),
    icon: <Undo2 size={16} aria-hidden />,
    onSelect: () => run(),
  };
}
