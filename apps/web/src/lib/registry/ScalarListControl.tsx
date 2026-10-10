import { effectiveLabel, OWNER_LOCALE, type PropertyDefinition } from '@orbis/shared';
import { FIELD_CLASS } from './controls';

const BUTTON_CLASS =
  'min-h-11 rounded-md px-3 text-sm text-text-secondary transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50';

/** Each raw item is its own input; an empty list is a value, not an unset. */
export function ScalarListControl({
  def,
  value,
  onChange,
  disabled = false,
}: {
  def: PropertyDefinition;
  value: readonly string[];
  onChange: (items: string[]) => void;
  disabled?: boolean;
}) {
  const label = effectiveLabel(def.label, OWNER_LOCALE);
  const numeric = def.type.kind === 'number' || def.type.kind === 'decimal';
  return (
    <fieldset
      aria-label={label}
      disabled={disabled}
      data-testid={`prop-${def.id}`}
      data-kind={`${def.type.kind}-list`}
      className="space-y-2"
    >
      <legend className="text-sm text-text-secondary">{label}</legend>
      {value.map((raw, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the controlled prop contract addresses raw rows by index, including duplicate and empty strings.
        <div key={index} className="flex items-center gap-2">
          <input
            type="text"
            disabled={disabled}
            aria-label={`${label}: строка ${index + 1}`}
            className={`${FIELD_CLASS} min-h-11 min-w-0`}
            inputMode={numeric ? 'decimal' : undefined}
            value={raw}
            onChange={(e) =>
              onChange(value.map((item, at) => (at === index ? e.target.value : item)))
            }
          />
          <button
            type="button"
            disabled={disabled}
            aria-label={`Удалить строку ${index + 1}: ${label} (${def.key})`}
            className={BUTTON_CLASS}
            onClick={() => onChange(value.filter((_, at) => at !== index))}
          >
            Удалить
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        className={BUTTON_CLASS}
        onClick={() => onChange([...value, ''])}
      >
        Добавить строку
      </button>
    </fieldset>
  );
}
