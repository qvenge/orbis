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
      className={`flex h-5 w-5 items-center justify-center rounded-sm border border-line bg-surface data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-accent ${className}`}
    >
      <RC.Indicator>✓</RC.Indicator>
    </RC.Root>
  );
}
