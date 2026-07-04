// apps/server/src/chat/messages.ts
// §4.6: chat_messages append-only — только INSERT, updated_at в таблице отсутствует,
// metadata неизменяема после записи. Отмена действия — не правка журнала, а НОВОЕ
// системное сообщение {type:'undo', undoes} (§7.8) — тоже через appendMessage.
import { eq } from 'drizzle-orm';
import { chatMessages } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
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

/**
 * Append-only вставка; RLS отклоняет чужой тред политикой БД (§4.10, §13 п.5).
 * Занятый id пробрасывает сырой 23505 НАМЕРЕННО: на нём стоит контракт боевого
 * JournalSink (23505 по PK → AuditIdConflictError → replay batch, §7.8).
 * Клиентскому пути нужен appendMessageIdempotent.
 */
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

/**
 * Идемпотентная вставка по client-UUID (fix round Task 12): повтор отправки с тем же
 * client-UUID — штатный ретрай (упавшая вкладка, разрыв после запроса до ответа),
 * зеркалим семантику §5.3 entity_create — вернуть исходную строку, а не отказ.
 * Механика — ON CONFLICT DO NOTHING + SELECT (как entity_create и ensureThread), а не
 * catch 23505: пойманный 23505 абортит tx (25P02), и SELECT после него невозможен.
 * Занятый ЧУЖИМ (невидимым под RLS) сообщением id — структурированный CONFLICT
 * с нейтральным текстом, без раскрытия SQL/параметров.
 */
export async function appendMessageIdempotent(
  tx: Tx,
  msg: AppendMessageInput,
): Promise<WireChatMessage> {
  const inserted = await tx
    .insert(chatMessages)
    .values({
      id: msg.id,
      threadId: msg.threadId,
      role: msg.role,
      content: msg.content,
      metadata: msg.metadata ?? {},
    })
    .onConflictDoNothing({ target: chatMessages.id })
    .returning();
  const row = inserted[0];
  if (row) return toWireChatMessage(row);

  // Конфликт PK. Своя строка (RLS видит) → идемпотентный повтор: исходная запись,
  // содержимое повторного запроса игнорируется (append-only, §4.6 — правок нет).
  const existing = await tx.select().from(chatMessages).where(eq(chatMessages.id, msg.id));
  const own = existing[0];
  if (!own) {
    // Чужая строка (RLS скрывает SELECT) — это не replay, а занятый id
    throw new ExecError('CONFLICT', 'id сообщения уже занят — сгенерируйте новый UUID', {
      id: msg.id,
      reason: 'id_conflict',
    });
  }
  return toWireChatMessage(own);
}
