import { Bot } from 'lucide-react';
import type { ReactNode } from 'react';

// 02 §2.3: сообщения агента (author_kind==='agent') помечаются иконкой бота + «агент».
//
// `label` — КТО именно, а не украшение (V1.9, Р-16). Работу приносит одна и та же журнальная
// запись, и по `actor_kind` рутина неотличима от чат-агента: обе пишутся от «ai». Владельцу же
// разница видна сразу — «агент» отвечает ему в разговоре, «рутина» правит граф ночью, пока его
// нет. Иконка одна на обоих: она декоративна (aria-hidden), смысл несёт слово.
export function SystemMessage({
  children,
  label = 'агент',
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <div data-testid="system-message" className="flex flex-col gap-1">
      <p className="flex items-center gap-1 text-xs text-text-muted">
        <Bot size={14} aria-hidden />
        {label}
      </p>
      {children}
    </div>
  );
}
