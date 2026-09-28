import type { ExtensionId } from '@orbis/shared';
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { ExtensionChecks } from './ExtensionChecks';
import { DISABLE_APP, useAppAction } from './useAppAction';

/**
 * «Выключить приложение» (срез 1б §8.6, С1б-11): диалог говорит, что изменится — место приложения
 * и расширения его «Состава», которых нет в «Составе» других включённых приложений (`orphans`,
 * отмечены по умолчанию). Подтверждение — ОДНА пачка: «Выключено» и `module_set` отмеченных, один
 * Undo. Включать и выключать расширения может только владелец — поэтому выбор здесь, у него.
 *
 * Модуль ЛЕНИВЫЙ: диалог нужен после жеста.
 */
export function DisableAppDialog({
  app,
  orphans,
  onClose,
}: {
  app: { id: string; title: string };
  orphans: readonly ExtensionId[];
  onClose: () => void;
}) {
  const run = useAppAction();
  const [chosen, setChosen] = useState<ExtensionId[]>([...orphans]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${DISABLE_APP} «${app.title}»`}
    >
      <div className="flex flex-col gap-3 pt-2 text-sm">
        <p data-testid="disable-app-place">
          Место «{app.title}» закроется: плитка в «Домой» и «Всех приложениях» останется
          приглушённой, с пометкой «выключено», а адрес приложения покажет плашку «выключено» с
          кнопкой «включить». Записи и страницы останутся на месте.
        </p>
        <ExtensionChecks
          testId="orphan-extensions"
          lead="Выключить и расширения, которых нет в других включённых приложениях:"
          options={orphans}
          chosen={chosen}
          onChange={setChosen}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={() => {
              onClose();
              void run({ kind: 'disable', appId: app.id, title: app.title, extensions: chosen });
            }}
          >
            Выключить
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
