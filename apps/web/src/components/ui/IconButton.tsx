import type { LucideIcon } from 'lucide-react';

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'danger';
}

export function IconButton({ icon: Icon, label, size = 'md', variant = 'ghost', className = '', ...props }: IconButtonProps) {
  const sizeClasses = size === 'sm' ? 'p-0.5' : 'p-1';
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  const variantClasses =
    variant === 'danger'
      ? 'text-text-muted hover:text-danger'
      : 'text-text-secondary hover:bg-surface-hover hover:text-text';

  return (
    <button
      aria-label={label}
      className={`rounded-md transition-colors duration-150 ${sizeClasses} ${variantClasses} ${className}`}
      {...props}
    >
      <Icon className={iconSize} />
    </button>
  );
}
