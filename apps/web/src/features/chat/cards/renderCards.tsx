import type { ReactNode } from 'react';
import type { ChatMessage } from '../useChatThread';
import { ConfirmationCard } from './ConfirmationCard';
import { EntityCard } from './EntityCard';
import { ErrorCard } from './ErrorCard';
import { QueryResultCard } from './QueryResultCard';
import { SystemMessage } from './SystemMessage';
import type { Card } from './types';

// Диспетчер по metadata.cards[]: серверный Card-union рендерится клиентом (Task 10).
// author_kind==='agent' → всё сообщение оборачивается в SystemMessage (🤖 агент, 02 §2.3).
export function renderCards(msg: ChatMessage): ReactNode {
  const meta = (msg.metadata ?? {}) as { cards?: Card[]; author_kind?: string };
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
        // biome-ignore lint/suspicious/noArrayIndexKey: карточки статичны в пределах сообщения
        return <ErrorCard key={i} card={card} />;
      default:
        return null;
    }
  });
  if (meta.author_kind === 'agent') return <SystemMessage>{body}</SystemMessage>;
  return <>{body}</>;
}
