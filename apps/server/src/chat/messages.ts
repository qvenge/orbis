// apps/server/src/chat/messages.ts
// §4.6: chat_messages append-only — только INSERT, updated_at в таблице отсутствует,
// metadata неизменяема после записи. Отмена действия — не правка журнала, а НОВОЕ
// системное сообщение {type:'undo', undoes} (§7.8) — тоже через appendMessage.
import { chatMessages } from '../db/schema';
import type { Tx } from '../db/with-identity';
// wire.ts импортирует отсюда ТОЛЬКО типы (import type, стирается) — цикла в рантайме нет
import { toWireChatMessage } from '../wire';

export type ChatRole = 'user' | 'assistant' | 'system';

/** Wire-форма сообщения: createdAt — всегда Date.toISOString() (решение 12 плана). */
export interface WireChatMessage {
  id: string;
  threadId: string;
  role: ChatRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AppendMessageInput {
  id: string;
  threadId: string;
  role: ChatRole;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Append-only вставка; RLS отклоняет чужой тред политикой БД (§4.10, §13 п.5). */
export async function appendMessage(tx: Tx, msg: AppendMessageInput): Promise<WireChatMessage> {
  const rows = await tx
    .insert(chatMessages)
    .values({
      id: msg.id,
      threadId: msg.threadId,
      role: msg.role,
      content: msg.content,
      metadata: msg.metadata ?? {},
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('appendMessage: INSERT не вернул строку'); // недостижимо
  return toWireChatMessage(row);
}
