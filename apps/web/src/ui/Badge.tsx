import type { HTMLAttributes } from 'react';

type Tone = 'default' | 'danger' | 'accent';

const TONE: Record<Tone, string> = {
  default: 'bg-surface-2 text-text-secondary',
  danger: 'bg-danger text-danger-foreground',
  accent: 'bg-accent text-accent-foreground',
};

export function Badge({
  tone = 'default',
  className = '',
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${TONE[tone]} ${className}`}
      {...rest}
    />
  );
}
