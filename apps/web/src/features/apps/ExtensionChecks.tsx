import { EXTENSION_MANIFESTS, type ExtensionId } from '@orbis/shared';
import { extensionName } from '../settings/useDisabledExtensions';

/**
 * Галочки расширений (срез 1б §8.6, §9.5): осиротевшие в «Выключить приложение» и «Удалить
 * приложение» (Р-9, по умолчанию отмечены все), «Состав» в «Новом приложении» и его правке. Порядок
 * отмеченных — порядок `options`: «Состав» и пачка `module_set` не зависят от порядка нажатий.
 *
 * Родной `<input type="checkbox">`, а не `ui/Checkbox`: тот эагерен в экране записи, и второй,
 * ленивый импортёр заставил rollup вынести его отдельным чанком в замыкание первого кадра записи
 * (+399 Б gzip — замер задачи 22, запас замыкания ≈1 кБ, РП-25).
 */
export function ExtensionChecks({
  lead,
  options,
  chosen,
  onChange,
  testId,
}: {
  lead: string;
  options: readonly ExtensionId[];
  chosen: readonly ExtensionId[];
  onChange: (next: ExtensionId[]) => void;
  testId?: string;
}) {
  if (options.length === 0) return null;
  return (
    <fieldset data-testid={testId} className="flex flex-col gap-2">
      <legend className="pb-1 text-text-secondary">{lead}</legend>
      {options.map((ext) => (
        <label key={ext} className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={chosen.includes(ext)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? options.filter((x) => x === ext || chosen.includes(x))
                  : chosen.filter((x) => x !== ext),
              )
            }
          />
          <span aria-hidden>{EXTENSION_MANIFESTS[ext].icon}</span>
          <span>{extensionName(ext)}</span>
        </label>
      ))}
    </fieldset>
  );
}
