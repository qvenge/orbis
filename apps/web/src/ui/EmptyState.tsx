import type { ReactNode } from 'react';

/** Центрированная заглушка пустого списка/экрана. Иконку передавать 32px: <Inbox size={32} />. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      {icon && <div className="text-text-muted/60">{icon}</div>}
      <p className="text-sm text-text-secondary">{title}</p>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
