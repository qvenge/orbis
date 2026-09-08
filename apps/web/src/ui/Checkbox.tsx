import { Check } from 'lucide-react';
import { Checkbox as RC } from 'radix-ui';

/**
 * `disabled` + `title`: состояние показываем, а переключение — нет. Прятать чекбокс у записи,
 * которая ЕСТЬ член контракта «завершаемость», значило бы соврать о её состоянии; кликабельность
 * же держится на писателе, а писателей у состояния пока меньше, чем читателей (см. `NativeRow`).
 * Причина отказа обязана быть на самом контроле — молча неактивный чекбокс читается как поломка.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  disabled = false,
  title,
  'aria-label': ariaLabel,
  className = '',
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
  className?: string;
}) {
  return (
    <RC.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={`flex h-5 w-5 cursor-pointer items-center justify-center rounded-sm border border-line bg-surface transition hover:border-text-muted data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-line ${className}`}
    >
      <RC.Indicator>
        <Check size={14} strokeWidth={3} />
      </RC.Indicator>
    </RC.Root>
  );
}
