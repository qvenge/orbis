// Отметка «думает» ответа AI (спека скорости §10.2 п. 3): семантика разговоров собирается в модуле разговоров — прежде
// её вставка и три удаления шли прямо из `ai/send-message.ts` мимо `chat/*`. id маркера — `processingMessageId(replyTo)`:
// повтор того же сообщения пользователя встречает ТОТ ЖЕ маркер (§7.9).
import { processingMessageId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { chatMessages } from '../db/schema';
import type { Tx } from '../db/with-identity';

/** Поставить маркер; `false` — маркер уже стоит (конкурентный перезапуск, цикл ведёт другой). */
export async function markProcessing(
  tx: Tx,
  m: { threadId: string; replyTo: string; now: Date },
): Promise<boolean> {
  const inserted = await tx
    .insert(chatMessages)
    .values({
      id: processingMessageId(m.replyTo),
      threadId: m.threadId,
      role: 'system',
      content: '',
      metadata: { type: 'processing', replyTo: m.replyTo },
      createdAt: m.now,
    })
    .onConflictDoNothing({ target: chatMessages.id })
    .returning({ id: chatMessages.id });
  return inserted.length > 0;
}
export async function clearProcessing(tx: Tx, replyTo: string): Promise<void> {
  await tx.delete(chatMessages).where(eq(chatMessages.id, processingMessageId(replyTo)));
}
/** Когда поставлен маркер (проба «прогон идёт», TTL — `PROCESSING_TTL_MS` отправителя); нет маркера — `undefined`. */
export async function processingStartedAt(tx: Tx, replyTo: string): Promise<Date | undefined> {
  const [row] = await tx
    .select({ createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(eq(chatMessages.id, processingMessageId(replyTo)));
  return row?.createdAt;
}
