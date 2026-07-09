import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'ghost' | 'outline';
type Size = 'sm' | 'md' | 'icon';

const base =
  'inline-flex cursor-pointer select-none items-center justify-center gap-2 rounded-control ' +
  'text-sm font-medium outline-hidden transition ' +
  'focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg ' +
  'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-foreground shadow-control hover:bg-accent/90 active:bg-accent/80',
  ghost: 'bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text active:bg-line/60',
  outline: 'border border-line bg-surface text-text hover:bg-surface-2 active:bg-line/60',
};

const sizes: Record<Size, string> = {
  sm: 'px-3 py-1',
  md: 'px-4 py-2',
  icon: 'h-8 w-8 p-0',
};

export function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={type}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
