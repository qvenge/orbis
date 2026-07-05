import type { ReactNode } from 'react';
import type { ChatMessage } from '../useChatThread';

// Плейсхолдер Task 9: MessageList/ChatThread уже потребляют renderCards, но полноценные
// карточки (entity/query_result/confirmation/error/system) реализует Task 10 — он заменит
// этот файл. До тех пор чат рендерит только текст сообщения (metadata.cards не разбираются).
export function renderCards(_msg: ChatMessage): ReactNode {
  return null;
}
