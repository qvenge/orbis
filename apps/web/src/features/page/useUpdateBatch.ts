import type { EntityUpdateBatchInput } from '@orbis/shared';
import { useCallback } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { trpc } from '../../trpc';
import { useToast } from '../../ui/toast-store';

/** Одна операция пачки — `entity_update` в форме роутера или `entity_version_pin` в форме тула. */
export type UpdateBatchOperation = EntityUpdateBatchInput['operations'][number];

/** Отказ пачки: что именно не записано, человек знает по жесту — текст общий. */
export const BATCH_FAILED = 'Не удалось сохранить изменения';
export const UNDO_FAILED = 'Не удалось отменить изменения';

/**
 * Пачка правок из меню ⋮ (спека страниц 1а §8.4, РП-9): все операции — ОДНИМ вызовом
 * `entity.updateBatch`, то есть одним журналом и одним Undo. Две мутации подряд дали бы две
 * записи журнала, и «Отменить» откатило бы половину жеста: тело сменилось бы обратно, а аспект
 * «страница» остался.
 *
 * После записи и после Undo — `invalidateGraph`: правка меняет и запись, и список шаблонов, и
 * данные блоков страницы. Экран перечитывает всё это сам, второй копии «что теперь показано» здесь
 * нет. Отказ тоже перечитывает: чаще всего он значит, что экран устарел (запись правили мимо него,
 * `STALE_VERSION`), и повтор с тем же снимком упал бы так же.
 *
 * Undo — клиентом, а не хуком мутации: к нажатию «Отменить» меню и его диалог могут быть уже
 * размонтированы (запись стала страницей — у меню другие пункты), а колбэки мутации
 * размонтированного компонента React Query не зовёт.
 *
 * Промис не отвергается: исход человек узнаёт тостом, вызывающему решать нечего.
 */
export function useUpdateBatch(): (
  operations: UpdateBatchOperation[],
  doneTitle: string,
) => Promise<void> {
  const utils = trpc.useUtils();
  const { show } = useToast();
  return useCallback(
    async (operations, doneTitle) => {
      let actionId: string;
      try {
        ({ actionId } = await utils.client.entity.updateBatch.mutate({ operations }));
      } catch {
        show(BATCH_FAILED, 'danger');
        invalidateGraph(utils);
        return;
      }
      invalidateGraph(utils);
      show(doneTitle, 'default', {
        label: 'Отменить',
        onSelect: () => {
          void utils.client.ai.undo
            .mutate({ actionId })
            .then(() => invalidateGraph(utils))
            .catch(() => show(UNDO_FAILED, 'danger'));
        },
      });
    },
    [utils, show],
  );
}
