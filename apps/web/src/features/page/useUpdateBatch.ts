import type { EntityUpdateBatchInput } from '@orbis/shared';
import { useCallback } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { trpc } from '../../trpc';
import { useToast } from '../../ui/toast-store';

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
      let actionId: string;
      try {
        ({ actionId } = await utils.client.entity.updateBatch.mutate({
          operations,
          ...(options.action !== undefined && { label: options.action }),
        }));
      } catch {
        show(options.failed ?? BATCH_FAILED, 'danger');
        invalidateGraph(utils);
        return false;
      }
      invalidateGraph(utils);
      show(doneTitle, 'default', {
        label: 'Отменить',
        onSelect: () => {
          void utils.client.ai.undo
            .mutate({ actionId })
            .then(() => invalidateGraph(utils))
            .catch(() => show(options.undoFailed ?? UNDO_FAILED, 'danger'));
        },
      });
      return true;
    },
    [utils, show],
  );
}
