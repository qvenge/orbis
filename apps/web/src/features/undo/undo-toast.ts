import type { UndoResult, UndoTextChangedDetails } from '@orbis/shared';
import { formatClock } from '../../lib/format-clock';
import { toastActionGeneration, useToastStore } from '../../ui/toast-store';
import { runUndo, UNDO_FAILED, type UndoOutcome } from './undo-action';
import { boundUndoUtils } from './undo-binding';
export type UndoToastRule =
  | { kind: 'always'; title: string }
  | { kind: 'if-consequences'; title: string }
  | { kind: 'free-value'; title: string; prior: string; next: string };
export interface OfferUndoInput {
  title: string;
  actionId: string;
  entityIds?: string[];
  failed?: string;
}
export const UNDO_LABEL = 'Отменить';
export const CONTINUE_UNDO = 'Всё равно отменить — текущий текст сохранится версией';
export const ALREADY_UNDONE = 'Уже отменено';
const ACTOR_WORD = { owner: 'вы', ai: 'AI', agent: 'агент' } as const;

/** Плашка «<действие> · Отменить» (§7.5 п. 1): заменяет прежнюю плашку с действием, отмена — по id записи журнала. */
export function offerUndo(o: OfferUndoInput): void {
  let pending = false;
  let generation = 0;
  const run = (force?: true): void => {
    if (pending) return;
    pending = true;
    void runUndo(o.actionId, {
      ...(o.entityIds !== undefined && { entityIds: o.entityIds }),
      ...(force && { force }),
    }).then((out) => {
      pending = false;
      const current = generation === toastActionGeneration();
      reportUndoOutcome(
        out.kind === 'failed' && out.message === UNDO_FAILED && o.failed !== undefined
          ? { kind: 'failed', message: o.failed }
          : out,
        () => run(true),
        current,
      );
      generation = toastActionGeneration();
    });
  };
  useToastStore.getState().show(o.title, 'default', { label: UNDO_LABEL, onSelect: () => run() });
  generation = toastActionGeneration();
}
/** Исход отмены: подтверждение (с версией, где текст, §8.6), причина отказа с продолжением, «уже отменено», сбой. */
export function reportUndoOutcome(o: UndoOutcome, retry: () => void, allowAction = true): void {
  const { show } = useToastStore.getState();
  switch (o.kind) {
    case 'undone':
      show(
        `Отменено: ${o.result.undone.title}`,
        'default',
        undefined,
        pinnedNote(o.result.pinnedVersions),
      );
      return;
    case 'refused': {
      const d = o.details;
      show(
        refusalTitle(d),
        'danger',
        allowAction && d.continuation.kind === 'here'
          ? { label: CONTINUE_UNDO, onSelect: retry }
          : undefined,
        d.entries.length > 1 ? d.entries.map((e) => `«${e.title}»`).join(', ') : undefined,
      );
      return;
    }
    case 'already':
      show(ALREADY_UNDONE);
      return;
    case 'failed':
      show(o.message, 'danger');
      return;
  }
}
function pinnedNote(pinned: UndoResult['pinnedVersions']): string | undefined {
  if (pinned.length === 0) return undefined;
  const names = pinned.map((v) => `«${v.label}»`).join(', ');
  return `ваш текст — в ${pinned.length === 1 ? 'версии' : 'версиях'} ${names} (Детали → Версии)`;
}
function refusalTitle(d: UndoTextChangedDetails): string {
  const first = d.entries[0];
  if (first === undefined) return 'Текст изменён после этой правки';
  const last = d.entries.reduce((a, b) => (b.at > a.at ? b : a), first);
  const tz = boundUndoUtils()?.user.getSettings.getData()?.timezone;
  const n = d.entries.length;
  return `Текст изменён после этой правки: ${last.actorLabel ?? ACTOR_WORD[last.actorKind]}, ${formatClock(last.at, tz)}${n > 1 ? ` (записей: ${n})` : ''}`;
}
