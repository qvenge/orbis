import { EXTENSION_MANIFESTS, type ExtensionId, effectiveLabel, OWNER_LOCALE } from '@orbis/shared';
import { useCallback } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { trpc } from '../../trpc';
import { useToast } from '../../ui/toast-store';
import { UNDO_FAILED } from '../page/useUpdateBatch';

// Чтение маски живёт в листовом модуле (вес первого кадра записи, см. его докблок); здесь — тот же
// интерфейс задачи 22 для настроек и плашки «Включить».
export { useDisabledExtensions, useExtensionEnabled } from './extension-mask';

/** Имя расширения владельцу — подпись манифеста в его локали. */
export function extensionName(ext: ExtensionId): string {
  return effectiveLabel(EXTENSION_MANIFESTS[ext].name, OWNER_LOCALE);
}

/** Подпись действия в тосте. */
export function extensionToggleTitle(ext: ExtensionId, enabled: boolean): string {
  const name = extensionName(ext);
  return enabled ? `Расширение «${name}» включено` : `Расширение «${name}» выключено`;
}

export const EXTENSION_TOGGLE_FAILED = 'Не удалось переключить расширение';

/**
 * Включить или выключить расширение (§8.6): действие владельца `user.setModuleEnabled` — операция
 * `module_set` исполнителя с журналом, тост «Отменить» отменяет ИМЕННО её (`ai.undo` по `actionId`).
 *
 * После записи и после отмены — `invalidateGraph` (выключение расширения меняет, что видно в записях:
 * поля только чтения, плашки карточек, §8.3) и перечитывание настроек: маску web читает оттуда
 * (`useDisabledExtensions`).
 *
 * Промис не отвергается: отказ человек видит тостом.
 */
export function useSetExtensionEnabled(): (ext: ExtensionId, enabled: boolean) => Promise<void> {
  const utils = trpc.useUtils();
  const { show } = useToast();
  return useCallback(
    async (ext, enabled) => {
      const refresh = () => {
        invalidateGraph(utils);
        void utils.user.getSettings.invalidate();
      };
      let actionId: string;
      try {
        ({ actionId } = await utils.client.user.setModuleEnabled.mutate({ module: ext, enabled }));
      } catch {
        show(EXTENSION_TOGGLE_FAILED, 'danger');
        refresh();
        return;
      }
      refresh();
      show(extensionToggleTitle(ext, enabled), 'default', {
        label: 'Отменить',
        onSelect: () => {
          void utils.client.ai.undo
            .mutate({ actionId })
            .then(refresh)
            .catch(() => show(UNDO_FAILED, 'danger'));
        },
      });
    },
    [utils, show],
  );
}
