// apps/server/test/legacy-journal.ts
// Писатель журнала ПРЕЖНЕЙ формы — системными сообщениями чата (до задачи 5 плана А). Нужен ОДНОМУ потребителю:
// тестам переноса (`src/journal/transfer.test.ts`), которые обязаны положить в базу ровно то, что лежит в проде до
// переноса, и проверить, что `transferJournal` раскладывает это по таблице. Боевого писателя этой формы больше нет —
// поэтому копия здесь, а не импорт: прод-код не должен уметь писать журнал в сообщения даже случайно.
//
// Форма — дословно удалённого `makeChatJournalSink` (executor/journal.ts до задачи 5) и прежней записи отмены
// (`executor/undo.ts`): `metadata = {actions: [action], cards: [card], results?}`, PK пачки — uuidv5 от
// `batch:<граф>:<batch_id>`, отмена — `{type:'undo', undoes}` с текстом «Отменено действие <id>».
import { type GraphId, newId, ORBIS_NAMESPACE } from '@orbis/shared';
import { v5 as uuidv5 } from 'uuid';
import { ensureGlobalThread } from '../src/chat/threads';
import { chatMessages } from '../src/db/schema';
import type { Tx } from '../src/db/with-identity';
import type { ActionCard, ActionRecord } from '../src/executor/types';

/** Прежний детерминированный PK audit-сообщения пачки (бывший `batchAuditMessageId` из shared `ids.ts`). */
export function legacyBatchMessageId(graphId: string, batchId: string): string {
  return uuidv5(`batch:${graphId.toLowerCase()}:${batchId.toLowerCase()}`, ORBIS_NAMESPACE);
}

/** Прежняя карточка ленты `fast_path`/`routine` — клиентская форма с `kind` (бывший `feedCard`). */
function legacyFeedCard(action: ActionRecord, card: ActionCard): unknown {
  if ((action.source !== 'fast_path' && action.source !== 'routine') || card.entity_id === null) {
    return card;
  }
  return {
    kind: 'entity_card',
    entityId: card.entity_id,
    title: card.title,
    aspects: [],
    keyFields: {},
    undoActionId: action.id,
  };
}

async function insertMessage(
  tx: Tx,
  m: {
    id: string;
    threadId: string;
    role: 'system' | 'assistant' | 'user';
    content: string;
    metadata: Record<string, unknown>;
    createdAt?: Date;
  },
): Promise<void> {
  await tx.insert(chatMessages).values({
    id: m.id,
    threadId: m.threadId,
    role: m.role,
    content: m.content,
    metadata: m.metadata,
    ...(m.createdAt !== undefined && { createdAt: m.createdAt }),
  });
}

export interface LegacyActionWrite {
  graphId: GraphId;
  /** Тред сообщения; нет — глобальный тред графа (как у прежнего синка). */
  threadId?: string;
  action: ActionRecord;
  card: ActionCard;
  results?: unknown[];
  /** PK сообщения; нет — у пачки прежний uuidv5, у одиночного — случайный (как у прежнего синка). */
  messageId?: string;
  /** Явное время сообщения — порядок в тестах переноса; нет — `now()` базы. */
  createdAt?: Date;
}

/** Audit-сообщение прежней формы; возвращает id СООБЩЕНИЯ (≠ id действия у одиночных, Д-4). */
export async function writeLegacyAction(tx: Tx, w: LegacyActionWrite): Promise<string> {
  const threadId = w.threadId ?? (await ensureGlobalThread(tx, w.graphId));
  const isBatch = w.action.type === 'batch' || w.action.type === 'action';
  const id = w.messageId ?? (isBatch ? legacyBatchMessageId(w.graphId, w.action.id) : newId());
  const metadata: Record<string, unknown> = {
    actions: [w.action],
    cards: [legacyFeedCard(w.action, w.card)],
  };
  if (w.results !== undefined) metadata.results = w.results;
  await insertMessage(tx, {
    id,
    threadId,
    role: 'system',
    content: w.card.title,
    metadata,
    ...(w.createdAt !== undefined && { createdAt: w.createdAt }),
  });
  return id;
}

/** Сообщение отмены прежней формы: `{type:'undo', undoes}` в треде отменённого действия. */
export async function writeLegacyUndo(
  tx: Tx,
  w: { threadId: string; undoes: string; messageId?: string; createdAt?: Date },
): Promise<string> {
  const id = w.messageId ?? newId();
  await insertMessage(tx, {
    id,
    threadId: w.threadId,
    role: 'system',
    content: `Отменено действие ${w.undoes}`,
    metadata: { type: 'undo', undoes: w.undoes },
    ...(w.createdAt !== undefined && { createdAt: w.createdAt }),
  });
  return id;
}

/**
 * Ответ ассистента с живой карточкой действия чата (прежний `ai/send-message.ts`): его карточка несёт
 * `undoActionId` — по нему перенос ставит `card_in_reply` (§11.3: вторая карточка из журнала была бы дублем).
 */
export async function writeLegacyAssistantReply(
  tx: Tx,
  w: { threadId: string; undoActionId: string; entityId: string; title: string; createdAt?: Date },
): Promise<string> {
  const id = newId();
  await insertMessage(tx, {
    id,
    threadId: w.threadId,
    role: 'assistant',
    content: 'Готово.',
    metadata: {
      cards: [
        {
          kind: 'entity_card',
          entityId: w.entityId,
          title: w.title,
          aspects: [],
          keyFields: {},
          undoActionId: w.undoActionId,
        },
      ],
    },
    ...(w.createdAt !== undefined && { createdAt: w.createdAt }),
  });
  return id;
}
