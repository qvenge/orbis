import type { ReactNode } from 'react';
import { Button } from '../../../ui/Button';
import type { ChatMessage } from '../useChatThread';
import { ConfirmationCard } from './ConfirmationCard';
import { EntityCard } from './EntityCard';
import { ErrorCard } from './ErrorCard';
import { QueryResultCard } from './QueryResultCard';
import { SystemMessage } from './SystemMessage';
import type { Card } from './types';

// Метка синтетической карточки fast-path (useFastPath): entityId+исходная строка.
type FastPathMeta = { entityId?: string; text: string; status: 'confirmed' | 'pending' };

// Обработчики chat-действий, прокидываемые сверху (ChatScreen → MessageList):
//  - onRetry: §3 — переотправить строку упавшего ai.sendMessage (кнопка ErrorCard);
//  - onReparse: «разобрать с AI» — архив fast-сущности + LLM (только у подтверждённой карточки).
export type CardHandlers = {
  onRetry?: (text: string) => void;
  onReparse?: (entityId: string, text: string) => void;
};

// Диспетчер по metadata.cards[]: серверный Card-union рендерится клиентом (Task 10).
// author_kind==='agent' → всё сообщение оборачивается в SystemMessage (🤖 агент, 02 §2.3).
export function renderCards(msg: ChatMessage, handlers: CardHandlers = {}): ReactNode {
  const meta = (msg.metadata ?? {}) as {
    cards?: Card[];
    author_kind?: string;
    retryText?: string;
    fastPath?: FastPathMeta;
  };
  const cards = meta.cards ?? [];
  const body = cards.map((card, i) => {
    switch (card.kind) {
      case 'entity_card':
        // biome-ignore lint/suspicious/noArrayIndexKey: карточки статичны в пределах сообщения
        return <EntityCard key={i} card={card} />;
      case 'query_result':
        // biome-ignore lint/suspicious/noArrayIndexKey: карточки статичны в пределах сообщения
        return <QueryResultCard key={i} card={card} />;
      case 'confirmation_card':
        // biome-ignore lint/suspicious/noArrayIndexKey: карточки статичны в пределах сообщения
        return <ConfirmationCard key={i} card={card} createdAt={msg.createdAt} />;
      case 'error_card':
        // §3: retryText есть → «Повторить» переотправит строку тем же LLM-путём.
        return (
          <ErrorCard
            // biome-ignore lint/suspicious/noArrayIndexKey: карточки статичны в пределах сообщения
            key={i}
            card={card}
            onRetry={
              meta.retryText && handlers.onRetry
                ? () => handlers.onRetry?.(meta.retryText as string)
                : undefined
            }
          />
        );
      default:
        return null;
    }
  });

  // «Разобрать с AI» — только у подтверждённой fast-карточки (офлайн «⏳» недоступна до confirm).
  const fp = meta.fastPath;
  if (fp?.status === 'confirmed' && fp.entityId && handlers.onReparse) {
    body.push(
      <Button
        key="reparse"
        variant="ghost"
        onClick={() => handlers.onReparse?.(fp.entityId as string, fp.text)}
      >
        Разобрать с AI
      </Button>,
    );
  }

  if (meta.author_kind === 'agent') return <SystemMessage>{body}</SystemMessage>;
  return <>{body}</>;
}
