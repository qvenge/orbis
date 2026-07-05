import type { ReactNode } from 'react';

// 02 §2.3: сообщения агента (author_kind==='agent') помечаются «🤖 агент».
export function SystemMessage({ children }: { children: ReactNode }) {
  return (
    <div data-testid="system-message" className="flex flex-col gap-1">
      <p className="text-xs text-text-muted">🤖 агент</p>
      {children}
    </div>
  );
}
