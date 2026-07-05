import type { HTMLAttributes, ReactNode } from 'react';

export function Chip({
  children,
  onRemove,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { children: ReactNode; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-control bg-surface-2 px-2 py-0.5 text-xs text-text-secondary"
      {...rest}
    >
      {children}
      {onRemove && (
        <button
          type="button"
          aria-label="Удалить"
          onClick={onRemove}
          className="text-text-muted hover:text-danger"
        >
          ×
        </button>
      )}
    </span>
  );
}
