// apps/server/src/executor/journal.ts
// Боевой JournalSink (§7.8): audit-сообщение в chat_messages ТЕМ ЖЕ tx, что и стадия 5.
// metadata = { actions: [action], cards: [card] } (§4.6) + results — источник ответа
// идемпотентного повтора batch (§7.8). Форма карточки зависит от source — см.
// FEED_CARD_SOURCES/feedCard. Целевой тред — entry.threadId, иначе глобальный
// тред владельца (создаётся в том же tx). Retention журнала (RET-02) здесь НЕ
// реализуется — отложен. Подключение по умолчанию не меняется (NOOP_SINK): боевой
// синк передают явно тесты и роутеры Task 12.
import { newId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appendMessage } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import { chatMessages, chatThreads } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import type { Card } from '../tools/registry';
import { pgErrorInfo } from './executor';
import type { ActionCard, ActionRecord, JournalSink, JournalWrite, MutationSource } from './types';
import { AuditIdConflictError } from './types';

/**
 * Источники, чьё audit-сообщение — ЕДИНСТВЕННЫЙ носитель карточки в ленте: только для
 * них в metadata.cards пишется форма клиентского union'а (02-core-os §2.3, с kind).
 * Без kind renderCards уходит в default (apps/web/.../cards/renderCards.tsx) и после
 * перезагрузки от карточки остаётся голая строка content.
 *
 * Почему белый список, а не «все, кроме chat»:
 * - 'chat' — у него СВОЙ, более богатый носитель: ответ ассистента персистит карточку
 *   с aspects/keyFields из реестра и ТЕМ ЖЕ undoActionId (ai/send-message.ts). Вторая
 *   карточка дала бы в ленте дубль с двумя кнопками «Отменить», причём беднее первой;
 * - 'fast_path' — единственная реальная деградация: клиентская карточка живёт лишь в
 *   кэше react-query (features/chat/useFastPath.ts), а из БД приезжает голая строка;
 * - 'mcp' | 'ui' | 'quick_capture' — карточки в ленте не было НИКОГДА, ни живьём, ни
 *   после перезагрузки: карточка тут была бы новой функцией, а не починкой;
 * - 'system' — audit скрыт фильтром ленты (chat/messages.ts), рисовать нечего;
 * - 'routine' (V1.5) — как fast_path, только хуже: у правки прогона НЕТ другого носителя
 *   вовсе. Ответа ассистента за ней не стоит (диалога не было), клиентского кэша тоже
 *   (владельца в этот момент не было в приложении) — audit-сообщение единственное, что
 *   он увидит, и без клиентской формы от него осталась бы голая строка без «Отменить».
 */
const FEED_CARD_SOURCES: ReadonlySet<MutationSource> = new Set<MutationSource>([
  'fast_path',
  'routine',
]);

/**
 * Карточка ленты — ВЕТКА серверного union'а Card (tools/registry.ts), а не копия его
 * полей: копий формы и так две (registry + web types.ts), третья молча отстала бы при
 * добавлении поля. Импорт type-only, цикла нет (registry тянет только shared/drizzle/zod/db).
 * Локальное ужесточение: у журнальной карточки undoActionId есть ВСЕГДА (в union он
 * опционален — у карточек LLM-ответа Undo может не быть).
 */
type FeedEntityCard = Extract<Card, { kind: 'entity_card' }> & { undoActionId: string };

/**
 * Что ляжет в metadata.cards[0]. Вне белого списка — сегодняшняя ActionCard дословно.
 *
 * Карточка НИКОГДА не пустая и cards[0] всегда есть: на нём стоит findByAuditId, а на
 * нём — идемпотентный replay batch (§7.8). Отсюда же второе условие: при entity_id ===
 * null (batch, одиночные relation-мутации) форма остаётся прежней — entityId клиентской
 * карточки обязан быть строкой, null там был бы враньём.
 *
 * aspects/keyFields пустые СОЗНАТЕЛЬНО, а не по недосмотру: у синка нет ни WireEntity,
 * ни viewConfig.keyFields (они собираются в tools/dispatch.ts из реестра аспектов) —
 * обогащать нечем. Карточка беднее живой, зато переживает перезагрузку и несёт «Отменить».
 */
function feedCard(action: ActionRecord, card: ActionCard): ActionCard | FeedEntityCard {
  if (!FEED_CARD_SOURCES.has(action.source) || card.entity_id === null) return card;
  return {
    kind: 'entity_card',
    entityId: card.entity_id,
    title: card.title,
    aspects: [],
    keyFields: {},
    // тот же id, что уходит в ai.undo({actionId}) у живых карточек (§7.8)
    undoActionId: action.id,
  };
}

/** Фабрика боевого синка; состояние не хранит — один инстанс переиспользуем. */
export function makeChatJournalSink(): JournalSink {
  return {
    async write(tx: Tx, entry: JournalWrite): Promise<void> {
      // Инвариант §7.8 «один action на audit-сообщение»: undo.ts (findLastUndoable/
      // findActionMessage) читает metadata.actions[0]. Несколько action в одном
      // сообщении молча потеряли бы всё, кроме первого, при отмене — поэтому нормализуем
      // и проверяем ровно один ДО любой записи (guard страхует будущий формат/баг
      // вызывающего; отказ — VALIDATION, как прочие ошибки конвейера §9.2).
      const asList = entry.action as ActionRecord | readonly ActionRecord[];
      const actions: readonly ActionRecord[] = Array.isArray(asList) ? asList : [asList];
      const action = actions.length === 1 ? actions[0] : undefined;
      if (action === undefined) {
        throw new ExecError('VALIDATION', 'audit-сообщение должно нести ровно один action (§7.8)', {
          count: actions.length,
        });
      }
      const threadId = entry.threadId ?? (await ensureGlobalThread(tx, entry.ownerId));
      const id = entry.id ?? newId();
      const metadata: Record<string, unknown> = {
        actions,
        cards: [feedCard(action, entry.card)],
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
      // Тип cards честен для всех читаемых здесь строк: искомый id — всегда
      // детерминированный batchAuditMessageId, а у batch card.entity_id === null,
      // то есть feedCard оставляет прежнюю ActionCard.
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
