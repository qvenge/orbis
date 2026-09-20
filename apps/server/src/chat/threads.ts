// apps/server/src/chat/threads.ts
// Треды §4.5: детерминированные ID (uuidv5, формулы Task 4) + INSERT … ON CONFLICT
// DO NOTHING + SELECT. Конкурентные вызовы сходятся к одной строке (§13.3): проигравшая
// вставка ждёт исход чужой транзакции на PK, гасится конфликтом и читает строку
// свежим statement-снапшотом (READ COMMITTED). Partial unique index'ы §4.5 остаются
// страховочным инвариантом сервера.
import { entityThreadId, type GraphId, globalThreadId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { chatThreads, entities } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';

/** Общий примитив: идемпотентная вставка треда с детерминированным id + чтение. */
async function ensureThread(
  tx: Tx,
  values: { id: string; graphId: GraphId; entityId: string | null },
): Promise<string> {
  // Без цели конфликта: гасим и PK, и partial unique (§4.5) — при детерминированном id
  // любой из них означает «строка уже есть»
  await tx.insert(chatThreads).values(values).onConflictDoNothing();
  const rows = await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, values.id));
  if (rows.length === 0) {
    // Недостижимо, пока тред заводится в ТЕКУЩЕМ графе вызова: RLS спрятала строку →
    // ошибка вызывающего. Сегодня это значит, что вызывающий собрал id треда по одному графу,
    // а транзакцию открыл в другом.
    throw new Error(
      `ensureThread: тред ${values.id} не виден после вставки: текущий граф транзакции ≠ граф треда`,
    );
  }
  return values.id;
}

/**
 * Глобальный тред ГРАФА (§4.5): NULL entity_id, id = uuidv5(owner:global-thread). Слаг формулы
 * остаётся словом owner — это ДАННЫЕ: сменив его, мы сменили бы id всех уже заведённых тредов.
 * Чей этот тред в графе компании (общий на граф или свой у каждого участника) — открытый вопрос
 * спеки §3.4, и срез Г его не решает.
 */
export async function ensureGlobalThread(tx: Tx, graph: GraphId): Promise<string> {
  return ensureThread(tx, { id: globalThreadId(graph), graphId: graph, entityId: null });
}

/**
 * Ленивый тред сущности (§4.5): id = uuidv5(owner:entity-thread:entity).
 * Тред создаётся только для видимой в ТЕКУЩЕМ ГРАФЕ сущности; чужая и несуществующая
 * под RLS неразличимы — единый NOT_FOUND.
 */
export async function ensureEntityThread(
  tx: Tx,
  graph: GraphId,
  entityId: string,
): Promise<string> {
  const visible = await tx
    .select({ id: entities.id })
    .from(entities)
    .where(eq(entities.id, entityId));
  if (visible.length === 0) {
    throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: entityId });
  }
  return ensureThread(tx, { id: entityThreadId(graph, entityId), graphId: graph, entityId });
}
