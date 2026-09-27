import { APP_EXTENSIONS, type ExtensionId, SWITCHABLE_EXTENSION_IDS } from '@orbis/shared';
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useUpdateBatch } from '../page/useUpdateBatch';
import { ExtensionChecks } from './ExtensionChecks';
import { EDIT_COMPOSITION } from './useAppAction';

/**
 * «Состав» своего приложения (срез 1б §8.6, §9.5) — по выбору владельца: какие расширения приложение
 * предлагает выключать вместе с собой. Одна `entity_update` записи-приложения (один Undo); пустой
 * выбор снимает свойство. Маску правка НЕ меняет — ни одного `module_set`: включать и выключать
 * расширения может только владелец отдельным жестом (§8.6, С1б-11).
 *
 * Модуль ЛЕНИВЫЙ: диалог нужен после жеста.
 */
export function CompositionDialog({
  app,
  current,
  onClose,
}: {
  app: { id: string; title: string };
  current: readonly ExtensionId[];
  onClose: () => void;
}) {
  const runBatch = useUpdateBatch();
  const [chosen, setChosen] = useState<ExtensionId[]>([...current]);
  const same = chosen.length === current.length && chosen.every((x) => current.includes(x));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Состав «${app.title}»`}
    >
      <div className="flex flex-col gap-3 pt-2 text-sm">
        <p className="text-text-secondary">
          «Выключить приложение» предложит выключить вместе с ним расширения состава, которые не
          нужны другим включённым приложениям. Сама правка состава ничего не включает и не
          выключает.
        </p>
        <ExtensionChecks
          testId="composition-extensions"
          lead="Состав:"
          options={SWITCHABLE_EXTENSION_IDS}
          chosen={chosen}
          onChange={setChosen}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={same}
            onClick={() => {
              onClose();
              void runBatch(
                [
                  {
                    tool: 'entity_update',
                    input:
                      chosen.length > 0
                        ? { id: app.id, props: { [APP_EXTENSIONS]: chosen } }
                        : { id: app.id, unset: [APP_EXTENSIONS] },
                  },
                ],
                `Состав «${app.title}» сохранён`,
                { action: EDIT_COMPOSITION },
              );
            }}
          >
            Сохранить
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
