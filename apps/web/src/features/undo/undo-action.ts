import type { UndoResult, UndoTextChangedDetails } from '@orbis/shared';
import { invalidateBudget, invalidateGraph } from '../../lib/invalidate';
import { orbisErrorOf } from '../../lib/orbis-error';
import {
  beginBodyRewrite,
  type FinishBodyRewrite,
  flushBodyOf,
  mountedBodyIds,
} from '../entity-editor/body-flush';
import { boundUndoUtils, type UndoUtils } from './undo-binding';

export const UNDO_FAILED = 'Не удалось отменить изменения';
export const UNDO_BODY_BLOCKED =
  'Текст записи не сохранён — сначала разрешите конфликт текста, затем отменяйте';
export const UNDO_OFFLINE = 'Нет связи: набранный текст ещё не на сервере — отмена не отправлена';

/**
 * Одна копия отмены для всех входов интерфейса (плашка, карточка в треде, Ctrl/Cmd+Z, «Вернуть текст как на …»).
 * Сначала — досыл неотправленного текста этой вкладки (§8.6): отмена, прошедшая раньше досыла, встретила бы на сервере
 * текст БЕЗ последних слов, а досыл следом упал бы конфликтом. Затем — `ai.undo`; исход разбирается по каналу структурного
 * отказа (`data.orbis`, РП-5), текст сообщения не читается.
 */
export async function runUndo(
  actionId: string,
  opts: { force?: true; entityIds?: string[] } = {},
): Promise<UndoOutcome> {
  const utils = boundUndoUtils();
  if (utils === null) return { kind: 'failed', message: UNDO_FAILED };
  const gates = new Map<string, FinishBodyRewrite>();
  const release = () => {
    for (const finish of gates.values()) finish();
  };
  try {
    for (const id of opts.entityIds ?? mountedBodyIds()) {
      const flushed = await flushBodyOf(id);
      if (flushed === 'blocked' || flushed === 'offline') {
        release();
        return {
          kind: 'failed',
          message: flushed === 'blocked' ? UNDO_BODY_BLOCKED : UNDO_OFFLINE,
        };
      }
      gates.set(id, beginBodyRewrite(id));
    }
    if (boundUndoUtils() !== utils) {
      release();
      return { kind: 'failed', message: UNDO_FAILED };
    }
    const result: UndoResult = await utils.client.ai.undo.mutate({
      actionId,
      ...(opts.force && { force: true as const }),
    });
    for (const [id, finish] of gates)
      finish(result.bodyRevisions.find((r) => r.entityId === id)?.bodyRevision);
    refresh(utils);
    return { kind: 'undone', result };
  } catch (e) {
    release();
    const orbis = orbisErrorOf(e);
    if (orbis?.code === 'UNDO_TEXT_CHANGED' && orbis.details !== undefined)
      return { kind: 'refused', details: orbis.details as unknown as UndoTextChangedDetails };
    if (orbis?.code === 'VALIDATION' && orbis.details?.reason === 'already_undone') {
      refresh(utils); // отменил другой — граф этой вкладки устарел так же
      return { kind: 'already' };
    }
    return { kind: 'failed', message: UNDO_FAILED };
  }
}
/** Как у прежних четырёх мест вместе: граф, маска расширений (приложения, расширения), денежные агрегаты (карточки). */
function refresh(utils: UndoUtils): void {
  invalidateGraph(utils);
  void utils.user.getSettings.invalidate();
  void invalidateBudget(utils);
}

export type UndoOutcome =
  | { kind: 'undone'; result: UndoResult }
  | { kind: 'refused'; details: UndoTextChangedDetails }
  | { kind: 'already' }
  | { kind: 'failed'; message: string };
