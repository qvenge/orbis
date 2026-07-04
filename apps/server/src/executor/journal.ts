// apps/server/src/executor/journal.ts
// Боевой JournalSink (§7.8): audit-сообщение в chat_messages ТЕМ ЖЕ tx, что и стадия 5.
// metadata = { actions: [action], cards: [card] } (§4.6) + results — источник ответа
// идемпотентного повтора batch (§7.8). Целевой тред — entry.threadId, иначе глобальный
// тред владельца (создаётся в том же tx). Retention журнала (RET-02) здесь НЕ
// реализуется — отложен. Подключение по умолчанию не меняется (NOOP_SINK): боевой
// синк передают явно тесты и роутеры Task 12.
import { newId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appendMessage } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import { chatMessages, chatThreads } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { pgErrorInfo } from './executor';
import type { ActionCard, ActionRecord, JournalSink, JournalWrite } from './types';
import { AuditIdConflictError } from './types';

/** Фабрика боевого синка; состояние не хранит — один инстанс переиспользуем. */
export function makeChatJournalSink(): JournalSink {
  return {
    async write(tx: Tx, entry: JournalWrite): Promise<void> {
      const threadId = entry.threadId ?? (await ensureGlobalThread(tx, entry.ownerId));
      const id = entry.id ?? newId();
      const metadata: Record<string, unknown> = {
        actions: [entry.action],
        cards: [entry.card],
      };
      // Результаты операций batch — сохранённый ответ идемпотентного повтора (§7.8)
      if (entry.results !== undefined) metadata.results = entry.results;
      try {
        await appendMessage(tx, {
          id,
          threadId,
          role: 'system',
          content: entry.card.title,
          metadata,
        });
      } catch (e) {
        // Контракт JournalSink: явный id уже занят (конкурент вставил audit первым) →
        // 23505 по PK chat_messages → AuditIdConflictError. tx уже abort'нут PG —
        // executor откатит его и вернёт сохранённый результат отдельным tx (§7.8).
        const pg = pgErrorInfo(e);
        if (
          entry.id !== undefined &&
          pg.code === '23505' &&
          pg.constraint === 'chat_messages_pkey'
        ) {
          throw new AuditIdConflictError(entry.id);
        }
        throw e;
      }
    },

    async findByAuditId(tx: Tx, id: string): Promise<JournalWrite | undefined> {
      const rows = await tx
        .select({
          id: chatMessages.id,
          threadId: chatMessages.threadId,
          metadata: chatMessages.metadata,
          ownerId: chatThreads.ownerId,
        })
        .from(chatMessages)
        .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
        .where(eq(chatMessages.id, id));
      const row = rows[0];
      if (!row) return undefined;
      const md = row.metadata as {
        actions?: ActionRecord[];
        cards?: ActionCard[];
        results?: unknown[];
      };
      const action = md.actions?.[0];
      const card = md.cards?.[0];
      // id занят не-audit сообщением — источником replay быть не может
      if (!action || !card) return undefined;
      return {
        id: row.id,
        ownerId: row.ownerId,
        threadId: row.threadId,
        action,
        card,
        results: md.results,
      };
    },
  };
}
