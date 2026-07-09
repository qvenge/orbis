import { Bot } from 'lucide-react';
import type { ReactNode } from 'react';

// 02 §2.3: сообщения агента (author_kind==='agent') помечаются иконкой бота + «агент».
export function SystemMessage({ children }: { children: ReactNode }) {
  return (
    <div data-testid="system-message" className="flex flex-col gap-1">
      <p className="flex items-center gap-1 text-xs text-text-muted">
        <Bot size={14} aria-hidden />
        агент
      </p>
      {children}
    </div>
  );
}
