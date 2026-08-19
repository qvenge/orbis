import { MessageSquare } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Markdown } from '../../lib/markdown/Markdown';
import { openEntity } from '../../state/navigation';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import {
  authorLabel,
  type CardHandlers,
  contentDuplicatesCard,
  renderCardBodies,
  renderCards,
} from './cards/renderCards';
import { SystemMessage } from './cards/SystemMessage';
import { readSuggestions, Suggestions } from './Suggestions';
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
  onPick,
  emptyHint,
}: {
  messages: ChatMessage[];
  isTyping: boolean;
  // Подсказка пустого треда. Fast-path («обед 340») уместен только в глобальном чате;
  // в треде сущности передаётся иная подсказка (или null — без подсказки).
  emptyHint?: string | null;
  // §2.4: тап по чипу-продолжению. Экран передаёт СВОЙ обычный путь отправки
  // (ChatScreen — fast-path submit, ChatThread — sendMessage). Не передан —
  // чипов нет вовсе: кнопка, которая ничего не делает, хуже её отсутствия.
  onPick?: (text: string) => void;
} & CardHandlers) {
  // messages в DESC; для показа сверху-вниз (старые вверху) — reverse на рендере.
  const ordered = [...messages].reverse();

  // Продолжения разговора живут только у ПОСЛЕДНЕГО показанного сообщения и только
  // если это ответ ассистента (else-ветка рендера ловит и 'system' — проверка явная).
  // Пока модель отвечает, чипы прошлого ответа скрыты: они уже неактуальны.
  const last = ordered.at(-1);
  const suggestions =
    !isTyping && onPick && last?.role === 'assistant' ? readSuggestions(last.metadata) : [];

  // Автоскролл к последнему сообщению: на mount — мгновенно ('auto'), при добавлении
  // сообщений / появлении typing — плавно ('smooth'), но при prefers-reduced-motion всегда 'auto'.
  const anchorRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    // Пустой тред без typing — скроллить некуда (и это делает deps значимыми для biome).
    if (ordered.length === 0 && !isTyping) return;
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
    <div
      data-testid="message-list"
      className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-6"
    >
      {ordered.length === 0 && !isTyping && (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<MessageSquare size={32} aria-hidden />}
            title="Напишите первое сообщение"
            hint={emptyHint ?? undefined}
          />
        </div>
      )}
      {/* Пользователь — тихий серый пузырь справа; ассистент — без пузыря, текст и карточки
          прямо на листе (Notion AI / Claude): акцентный цвет сообщениям не принадлежит. */}
      {ordered.map((m) =>
        m.role === 'user' && authorLabel(m) !== undefined ? (
          /* Пост в тред от НЕ-владельца (thread_post рутины, агента или чат-AI): роль у него
             `user`, но это не реплика владельца, и в его пузыре справа ему не место — иначе
             утром владелец читал бы «перенёс срок, см. план» как СВОИ слова (V1.6, B1-1/D-1).
             Метка (рутина / агент / AI) стоит НАД текстом, как у audit-карточек. */
          <article
            key={m.id}
            data-role={m.role}
            data-author={authorLabel(m)}
            className="flex w-full max-w-[92%] flex-col gap-2 self-start text-sm text-text"
          >
            <SystemMessage label={authorLabel(m)}>
              {m.content && (
                <Markdown
                  source={m.content}
                  onEntityLink={openEntity}
                  className="leading-relaxed"
                />
              )}
              {renderCardBodies(m, { onRetry, onReparse })}
            </SystemMessage>
          </article>
        ) : m.role === 'user' ? (
          <article
            key={m.id}
            data-role={m.role}
            className="max-w-[75%] self-end rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-sm text-text"
          >
            {m.content && <Markdown source={m.content} onEntityLink={openEntity} />}
            {renderCards(m, { onRetry, onReparse })}
          </article>
        ) : (
          <article
            key={m.id}
            data-role={m.role}
            className="flex w-full max-w-[92%] flex-col gap-2 self-start text-sm text-text"
          >
            {/* Абзац снимается, только если его текст ДОСЛОВНО повторяет заголовок
                отрисованной карточки (audit-строка действия, executor/journal.ts):
                печатать «Кофе» абзацем и «Кофе» карточкой подряд — шум. Карточка не
                отрисовалась → текст остаётся (см. contentDuplicatesCard).
                Пузырь пользователя правилу не подчиняется намеренно: там текст — то,
                что человек написал сам, и прятать его нельзя ни при каком совпадении. */}
            {/* Правило выше сравнивает СЫРОЙ m.content с заголовком карточки — markdown
                ничего в нём не меняет, отрисовка идёт уже после решения. */}
            {m.content && !contentDuplicatesCard(m, { onRetry, onReparse }) && (
              <Markdown source={m.content} onEntityLink={openEntity} className="leading-relaxed" />
            )}
            {renderCards(m, { onRetry, onReparse })}
          </article>
        ),
      )}
      {/* key={id сообщения}: ряд принадлежит конкретному ответу — на смене ответа он
          монтируется заново и снова доступен, даже если формулировки повторились. */}
      {onPick && <Suggestions key={last?.id} items={suggestions} onPick={onPick} />}
      {isTyping && (
        <div
          data-testid="typing"
          role="status"
          aria-label="Ассистент печатает"
          className="flex items-center gap-1 self-start px-1 py-2"
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
