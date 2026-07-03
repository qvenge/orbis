import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'ghost';

const base =
  'inline-flex select-none items-center justify-center gap-2 rounded-control px-4 py-2 ' +
  'text-sm font-medium outline-hidden transition focus-visible:ring-2 focus-visible:ring-accent/60 ' +
  'disabled:pointer-events-none disabled:opacity-50';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-foreground shadow-control hover:bg-accent/90 active:bg-accent/80',
  ghost: 'bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text active:bg-line/60',
};

export function Button({
  variant = 'primary',
  type = 'button',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type={type} className={`${base} ${variants[variant]} ${className}`} {...props} />;
}
