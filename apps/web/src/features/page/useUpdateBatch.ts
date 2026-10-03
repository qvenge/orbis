import type { EntityUpdateBatchInput } from '@orbis/shared';
import { useCallback } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { trpc } from '../../trpc';
import { useToast } from '../../ui/toast-store';
import { resetSteps } from '../entity-editor/arrows-stack';
import { journalRefOf } from '../undo/journal-ref';
import { isUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import { offerUndoLazy } from '../undo/undo-lazy';

/** Одна операция пачки — `entity_update` в форме роутера или `entity_version_pin` в форме тула. */
export type UpdateBatchOperation = EntityUpdateBatchInput['operations'][number];

/** Отказ пачки: что именно не записано, человек знает по жесту — текст общий (если жест не дал свой). */
export const BATCH_FAILED = 'Не удалось сохранить изменения';

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

/**
 * Пачка правок страниц 1а (спека §4.3, §8.4, РП-9): все операции — ОДНИМ вызовом
 * `entity.updateBatch`, то есть одним журналом и одним Undo. Две мутации подряд дали бы две
 * записи журнала, и «Отменить» откатило бы половину жеста: тело сменилось бы обратно, а аспект
 * «страница» остался. Обслуживает меню ⋮ и плашку спора шаблонов — одна копия механизма
 * «пачка → тост „Отменить“ → Undo → перечитывание» (финальное ревью, C1-I4).
 *
 * После записи и после Undo — `invalidateGraph`: правка меняет и запись, и список шаблонов, и
 * данные блоков страницы. Экран перечитывает всё это сам, второй копии «что теперь показано» здесь
 * нет. Отказ тоже перечитывает: чаще всего он значит, что экран устарел (запись правили мимо него,
 * `STALE_VERSION`), и повтор с тем же снимком упал бы так же.
 *
 * Undo — клиентом, а не хуком мутации: к нажатию «Отменить» меню и его диалог могут быть уже
 * размонтированы (запись стала страницей — у меню другие пункты, спор решён — плашки нет).
 *
 * Промис сообщает исход (`true` — пачка записана) и НЕ отвергается: отказ человек узнаёт тостом,
 * а вызывающему исход нужен для своего состояния (плашка спора закрывается только записанной).
 */
export function useUpdateBatch(): RunUpdateBatch {
  const utils = trpc.useUtils();
  const { show } = useToast();
  return useCallback(
    async (operations, doneTitle, options = {}) => {
      const epoch = undoEpoch();
      let journalResponse: unknown;
      let actionId: string;
      try {
        ({ actionId } = journalResponse = await utils.client.entity.updateBatch.mutate({
          operations,
          ...(options.action !== undefined && { label: options.action }),
        }));
      } catch {
        if (!isUndoEpoch(epoch)) return false;
        show(options.failed ?? BATCH_FAILED, 'danger');
        invalidateGraph(utils);
        return false;
      }
      if (!isUndoEpoch(epoch)) return false;
      for (const op of operations)
        if (op.tool === 'entity_update' && op.input.body !== undefined) resetSteps(op.input.id);
      invalidateGraph(utils);
      if (journalRefOf(journalResponse) === null) return true;
      offerUndoLazy({
        title: doneTitle,
        actionId: actionId,
        entityIds: bodyIdsOf(operations),
        ...(options.undoFailed !== undefined && { failed: options.undoFailed }),
      });
      return true;
    },
    [utils, show],
  );
}

/** Досыл только тех тел, которые пачка может переписывать. */
function bodyIdsOf(operations: UpdateBatchOperation[]): string[] {
  return [
    ...new Set(
      operations.flatMap((op) =>
        op.tool === 'entity_update'
          ? [op.input.id]
          : op.tool === 'entity_version_pin'
            ? [op.input.entity_id]
            : [],
      ),
    ),
  ];
}
