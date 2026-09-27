import type { ExtensionId } from '@orbis/shared';
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { ExtensionChecks } from './ExtensionChecks';
import { ARCHIVE_APP, useAppAction } from './useAppAction';

/**
 * «Удалить приложение» (срез 1б §8.6): архив записи-приложения и вопрос, выключить ли осиротевшие
 * расширения (отмечены по умолчанию, как у «Выключить»). Расширения поставки не удаляются — только
 * выключаются. Одна пачка `app.archive`, один Undo.
 *
 * Модуль ЛЕНИВЫЙ: диалог нужен после жеста.
 */
export function ArchiveAppDialog({
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
      title={`${ARCHIVE_APP} «${app.title}»`}
    >
      <div className="flex flex-col gap-3 pt-2 text-sm">
        <p>
          Приложение «{app.title}» уйдёт в архив. Его страницы и записи останутся; расширения не
          удаляются — их можно только выключить.
        </p>
        <ExtensionChecks
          testId="orphan-extensions"
          lead="Выключить расширения, которые больше не нужны ни одному включённому приложению:"
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
              void run({ kind: 'archive', appId: app.id, title: app.title, extensions: chosen });
            }}
          >
            Удалить
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
