import { EXTENSION_MANIFESTS, type ExtensionId } from '@orbis/shared';
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { extensionName } from '../settings/useDisabledExtensions';
import { DISABLE_APP, useAppAction } from './useAppAction';

/**
 * Галочки осиротевших расширений (срез 1б §8.6, Р-9): по умолчанию отмечены все, владелец снимает
 * лишние. Общие для «Выключить приложение» и «Удалить приложение».
 *
 * Родной `<input type="checkbox">`, а не `ui/Checkbox`: тот эагерен в экране записи, и второй,
 * ленивый импортёр заставил rollup вынести его отдельным чанком в замыкание первого кадра записи
 * (+399 Б gzip — замер задачи 22, запас замыкания ≈1 кБ, РП-25).
 */
export function OrphanChecks({
  lead,
  orphans,
  chosen,
  onChange,
}: {
  lead: string;
  orphans: readonly ExtensionId[];
  chosen: readonly ExtensionId[];
  onChange: (next: ExtensionId[]) => void;
}) {
  if (orphans.length === 0) return null;
  return (
    <fieldset data-testid="orphan-extensions" className="flex flex-col gap-2">
      <legend className="pb-1 text-text-secondary">{lead}</legend>
      {orphans.map((ext) => {
        const name = extensionName(ext);
        return (
          <label key={ext} className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={chosen.includes(ext)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? orphans.filter((x) => x === ext || chosen.includes(x))
                    : chosen.filter((x) => x !== ext),
                )
              }
            />
            <span aria-hidden>{EXTENSION_MANIFESTS[ext].icon}</span>
            <span>{name}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

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
          Место «{app.title}» скроется: приложение пропадёт из «Домой» и «Всех приложений», а его
          адрес покажет плашку «выключено» с кнопкой «включить». Записи и страницы останутся на
          месте.
        </p>
        <OrphanChecks
          lead="Выключить и расширения, которых нет в других включённых приложениях:"
          orphans={orphans}
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
