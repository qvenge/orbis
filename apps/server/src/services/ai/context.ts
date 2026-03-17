import type { LLMMessage } from '../llm/types.ts';

const MAX_MESSAGES = 40;
const conversationStore = new Map<string, LLMMessage[]>();

export function getConversationHistory(userId: string): LLMMessage[] {
  return conversationStore.get(userId) ?? [];
}

export function appendMessage(userId: string, message: LLMMessage): void {
  const history = conversationStore.get(userId) ?? [];
  history.push(message);

  // Rolling window: keep only last MAX_MESSAGES
  if (history.length > MAX_MESSAGES) {
    history.splice(0, history.length - MAX_MESSAGES);
  }

  conversationStore.set(userId, history);
}

export function clearHistory(userId: string): void {
  conversationStore.delete(userId);
}
