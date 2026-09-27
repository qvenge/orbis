import type { ExtensionId } from '@orbis/shared';
import { useCallback } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { trpc } from '../../trpc';
import { useToast } from '../../ui/toast-store';
import { UNDO_FAILED } from '../page/useUpdateBatch';

/** Подписи действий над приложением — кнопки «Приложений и расширений» и заголовки диалогов. */
export const DISABLE_APP = 'Выключить приложение';
export const ENABLE_APP = 'Включить приложение';
export const ARCHIVE_APP = 'Удалить приложение';
export const APP_ACTION_FAILED = 'Не удалось изменить приложение';

/** Действие владельца над записью-приложением (срез 1б §8.6, РП-12) — ручки `app.*`. */
export interface AppAct {
  kind: 'disable' | 'enable' | 'archive';
  appId: string;
  title: string;
  /** Расширения, которые пачка переключает в ту же сторону (у «Удалить» — выключает). */
  extensions: ExtensionId[];
}

function doneTitle(act: AppAct): string {
  switch (act.kind) {
    case 'disable':
      return `Приложение «${act.title}» выключено`;
    case 'enable':
      return `Приложение «${act.title}» включено`;
    case 'archive':
      return `Приложение «${act.title}» удалено`;
  }
}

/**
 * Выключить, включить или удалить приложение: ОДНА пачка сервера (свойство «Выключено» или архив и
 * `module_set` отмеченных расширений), один тост «Отменить» — `ai.undo` по `actionId` откатывает
 * пачку целиком (§8.6 «одна пачка, один Undo»). После записи и отмены — `invalidateGraph` (список
 * приложений, рамка, плашки правила открытия) и настройки (маска расширений).
 */
export function useAppAction(): (act: AppAct) => Promise<boolean> {
  const utils = trpc.useUtils();
  const { show } = useToast();
  return useCallback(
    async (act) => {
      const refresh = () => {
        invalidateGraph(utils);
        void utils.user.getSettings.invalidate();
      };
      let actionId: string;
      try {
        ({ actionId } =
          act.kind === 'archive'
            ? await utils.client.app.archive.mutate({
                appId: act.appId,
                disableExtensions: act.extensions,
              })
            : await utils.client.app.setDisabled.mutate({
                appId: act.appId,
                disabled: act.kind === 'disable',
                extensions: act.extensions,
              }));
      } catch {
        show(APP_ACTION_FAILED, 'danger');
        refresh();
        return false;
      }
      refresh();
      show(doneTitle(act), 'default', {
        label: 'Отменить',
        onSelect: () => {
          void utils.client.ai.undo
            .mutate({ actionId })
            .then(refresh)
            .catch(() => show(UNDO_FAILED, 'danger'));
        },
      });
      return true;
    },
    [utils, show],
  );
}
