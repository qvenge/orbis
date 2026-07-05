import { type CardHandlers, renderCards } from './cards/renderCards';
import type { ChatMessage } from './useChatThread';

export function MessageList({
  messages,
  isTyping,
  onRetry,
  onReparse,
}: {
  messages: ChatMessage[];
  isTyping: boolean;
} & CardHandlers) {
  // messages в DESC; для показа сверху-вниз (старые вверху) — reverse на рендере.
  const ordered = [...messages].reverse();
  return (
    <div data-testid="message-list" className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
      {ordered.map((m) => (
        <article
          key={m.id}
          data-role={m.role}
          className={`max-w-[85%] rounded-card px-3 py-2 text-sm ${m.role === 'user' ? 'self-end bg-accent text-accent-foreground' : 'self-start bg-surface-2 text-text'}`}
        >
          {m.content && <p>{m.content}</p>}
          {renderCards(m, { onRetry, onReparse })}
        </article>
      ))}
      {isTyping && (
        <div
          data-testid="typing"
          role="status"
          className="self-start rounded-card bg-surface-2 px-3 py-2 text-sm text-text-muted"
        >
          …
        </div>
      )}
    </div>
  );
}
