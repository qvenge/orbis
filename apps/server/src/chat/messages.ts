// apps/server/src/chat/messages.ts
// §4.6: chat_messages append-only — только INSERT, updated_at в таблице отсутствует,
// metadata неизменяема после записи. Журнал действий сообщений не пишет: он — своя таблица
// `action_journal` (спека скорости §11), и в тред попадает объединением на чтении
// (`journal/thread-page.ts`).
import { eq, type SQL, sql } from 'drizzle-orm';
import { chatMessages } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
// wire.ts импортирует отсюда ТОЛЬКО типы (import type, стирается) — цикла в рантайме нет
import { toWireChatMessage } from '../wire';

export type ChatRole = 'user' | 'assistant' | 'system';

/**
 * TTL маркера processing: моложе — первый прогон считается живым (ретраю отвечаем
 * { status: 'processing' }), старше — прогон умер без снятия маркера (краш процесса),
 * цикл перезапускается. Штатные исходы снимают маркер сами: успех — той же tx, что
 * пишет ответ; сбой — в catch (немедленный ретрай после ошибки легитимен, §7.9).
 *
 * Здесь, у разговора, а не в `ai/send-message.ts`: срок читает и выдача треда
 * (`journal-read.threadFeed`, рулинг R-13) — действие разговора без ответа старше срока
 * значит оборванный ход, и его карточка обязана появиться строкой журнала.
 */
export const PROCESSING_TTL_MS = 10 * 60_000;

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
 * Есть ли карточка-запрос подтверждения (§7.10) с этим id: карточка лежит сообщением с id = pendingId и ключом
 * `metadata.pending`. Одобренная единица исполняется пачкой с тем же ключом (`approvePending`, `batchId = pendingId`) —
 * так место продолжения отмены (`executor/body-chain.ts`, `undoContinuationOf`) отличает её от правки во вкладке.
 * Выборка по ключу сообщения (индекс берётся и под RLS).
 */
export async function isPendingCardMessage(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      sql`${chatMessages.id} = ${id}::uuid AND (${chatMessages.metadata} -> 'pending') IS NOT NULL`,
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * SQL-предикаты «инфраструктурная system-строка невидима» — фрагмент выборки сообщений
 * выдачи треда (`journal/thread-page.ts`: chat.listMessages, тред entity.get, историю
 * LLM-контекста §7.1) — в SQL до limit rolling-окна (иначе плотный служебный шум вытеснял
 * бы живой диалог из окна модели). Скрывается processing-маркер ai.sendMessage (§7.9): живой
 * давал бы пустой system-пузырь в окне рефетча, маркер краша висел бы навсегда;
 * IS NOT DISTINCT FROM — NULL-безопасно (у прочих system-строк ключа type нет, обычное `=`
 * выкинуло бы их вместе с маркерами).
 *
 * Условия по прежнему журналу в сообщениях (`metadata.actions` системной материализации) здесь
 * больше нет: журнал пишется своей таблицей (спека скорости §11), и системные записи скрывает её
 * выборка (`journal-read.threadFeed`), а прежние сообщения журнала переносит в таблицу и сносит
 * прод-операция плана А (задача 21) — держать фильтр по форме, которой в сообщениях не будет,
 * значило бы платить за него на каждой выдаче треда.
 */
export function excludeInfraSystemRows(): SQL[] {
  return [
    sql`NOT (${chatMessages.role} = 'system' AND ${chatMessages.metadata} ->> 'type' IS NOT DISTINCT FROM 'processing')`,
  ];
}

/**
 * Append-only вставка; RLS отклоняет чужой тред политикой БД (§4.10, §13 п.5).
 * Занятый id пробрасывается сырым 23505: молча принять его за повтор здесь нельзя —
 * клиентскому пути, которому повтор штатен, нужен appendMessageIdempotent.
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
 *
 * replayed (fix round Task 9): true — вставки не было, вернулась исходная строка.
 * Потребитель — ai.sendMessage: ретрай с тем же client-id при уже существующем
 * ответе не должен гнать tool-цикл заново (replay ответа вместо второго прогона).
 */
export async function appendMessageIdempotent(
  tx: Tx,
  msg: AppendMessageInput,
): Promise<{ message: WireChatMessage; replayed: boolean }> {
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
  if (row) return { message: toWireChatMessage(row), replayed: false };

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
  return { message: toWireChatMessage(own), replayed: true };
}
