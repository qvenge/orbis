import { MessageSquare } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { type CardHandlers, renderCards } from './cards/renderCards';
import type { ChatMessage } from './useChatThread';

// Скелетон треда: три «пузыря» разной ширины (ChatScreen и ChatThread, этап 4).
export function ThreadSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-2 p-3">
      <Skeleton className="h-10 w-3/5 self-start rounded-card" />
      <Skeleton className="h-10 w-2/5 self-end rounded-card" />
      <Skeleton className="h-10 w-1/2 self-start rounded-card" />
    </div>
  );
}

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

  // Автоскролл к последнему сообщению: на mount — мгновенно ('auto'), при добавлении
  // сообщений / появлении typing — плавно ('smooth'), но при prefers-reduced-motion всегда 'auto'.
  const anchorRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    const anchor = anchorRef.current;
    // jsdom не реализует scrollIntoView — guard бережёт остальные тесты, что рендерят список.
    if (!anchor || typeof anchor.scrollIntoView !== 'function') return;
    const prefersReduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior: ScrollBehavior = mountedRef.current && !prefersReduced ? 'smooth' : 'auto';
    anchor.scrollIntoView({ behavior, block: 'end' });
    mountedRef.current = true;
  }, [ordered.length, isTyping]);

  return (
    <div data-testid="message-list" className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
      {ordered.length === 0 && !isTyping && (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<MessageSquare size={32} aria-hidden />}
            title="Напишите первое сообщение"
            hint="Например: «обед 340» — Orbis разберёт сам"
          />
        </div>
      )}
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
          aria-label="Ассистент печатает"
          className="flex items-center gap-1 self-start rounded-card bg-surface-2 px-3 py-2.5"
        >
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-text-muted" />
          <span
            aria-hidden
            className="size-1.5 animate-pulse rounded-full bg-text-muted [animation-delay:200ms]"
          />
          <span
            aria-hidden
            className="size-1.5 animate-pulse rounded-full bg-text-muted [animation-delay:400ms]"
          />
        </div>
      )}
      {/* Якорь автоскролла: всегда последний в потоке — scrollIntoView прокручивает к нему. */}
      <div ref={anchorRef} data-testid="scroll-anchor" aria-hidden />
    </div>
  );
}
