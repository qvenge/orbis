import type { EntityUpdateBatchInput } from '@orbis/shared';
import { useCallback } from 'react';
import { runGraphCommand } from '../../lib/graph-command';
import { invalidateGraphCommand } from '../../lib/invalidate';
import { useGraphUndo } from '../../lib/useGraphUndo';
import { trpc } from '../../trpc';
import { useToast } from '../../ui/toast-store';
import type { CommandOutcome } from '../entity-detail/properties-relations/types';

/** Одна операция пачки — `entity_update` в форме роутера или `entity_version_pin` в форме тула. */
export type UpdateBatchOperation = EntityUpdateBatchInput['operations'][number];

/** Отказ пачки: что именно не записано, человек знает по жесту — текст общий (если жест не дал свой). */
export const BATCH_FAILED = 'Не удалось сохранить изменения';
export const UNDO_FAILED = 'Не удалось отменить изменения';

/** Что жест говорит о себе сверх операций. */
export interface UpdateBatchOptions {
  /**
   * Подпись жеста («Сделать страницей») — заголовок записи журнала и ответа «отмени последнее»
   * (`entity.updateBatch.label`): без неё запись звалась бы «batch: операций — N».
   */
  action?: string;
  /** Текст отказа пачки — когда жест знает, что именно не записано (плашка спора). */
  failed?: string;
  /** Текст отказа Undo — тем же правилом. */
  undoFailed?: string;
}

export type RunUpdateBatch = (
  operations: UpdateBatchOperation[],
  doneTitle: string,
  options?: UpdateBatchOptions,
) => Promise<boolean>;

/** One transport implementation, with outcomes suitable for a controlled form. */
export function useDetailedUpdateBatch(): (
  operations: UpdateBatchOperation[],
  options?: UpdateBatchOptions,
) => Promise<CommandOutcome> {
  const utils = trpc.useUtils();
  return useCallback(
    async (operations, options = {}) => {
      const outcome = await runGraphCommand(() =>
        utils.client.entity.updateBatch.mutate({
          operations,
          ...(options.action !== undefined && { label: options.action }),
        }),
      );
      invalidateGraphCommand(utils);
      return outcome;
    },
    [utils],
  );
}

/** Legacy callers keep boolean completion and their existing generic/custom toast text. */
export function useUpdateBatch(): RunUpdateBatch {
  const run = useDetailedUpdateBatch();
  const undo = useGraphUndo();
  const { show } = useToast();
  return useCallback(
    async (operations, doneTitle, options = {}) => {
      const outcome = await run(operations, options);
      if (outcome.kind !== 'confirmed') {
        show(options.failed ?? BATCH_FAILED, 'danger');
        return false;
      }
      if (outcome.actionId) undo(outcome.actionId, doneTitle, options.undoFailed ?? UNDO_FAILED);
      else show(doneTitle);
      return true;
    },
    [run, undo, show],
  );
}
