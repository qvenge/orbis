import { Check } from 'lucide-react';
import { Checkbox as RC } from 'radix-ui';

export function Checkbox({
  checked,
  onCheckedChange,
  'aria-label': ariaLabel,
  className = '',
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  'aria-label'?: string;
  className?: string;
}) {
  return (
    <RC.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      aria-label={ariaLabel}
      className={`flex h-5 w-5 cursor-pointer items-center justify-center rounded-sm border border-line bg-surface transition hover:border-text-muted data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}
    >
      <RC.Indicator>
        <Check size={14} strokeWidth={3} />
      </RC.Indicator>
    </RC.Root>
  );
}
