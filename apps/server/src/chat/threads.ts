// apps/server/src/chat/threads.ts
// Треды §4.5: детерминированные ID (uuidv5, формулы Task 4) + INSERT … ON CONFLICT
// DO NOTHING + SELECT. Конкурентные вызовы сходятся к одной строке (§13.3): проигравшая
// вставка ждёт исход чужой транзакции на PK, гасится конфликтом и читает строку
// свежим statement-снапшотом (READ COMMITTED). Partial unique index'ы §4.5 остаются
// страховочным инвариантом сервера.
import { entityThreadId, globalThreadId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { chatThreads, entities } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';

/** Общий примитив: идемпотентная вставка треда с детерминированным id + чтение. */
async function ensureThread(
  tx: Tx,
  values: { id: string; ownerId: string; entityId: string | null },
): Promise<string> {
  // Без цели конфликта: гасим и PK, и partial unique (§4.5) — при детерминированном id
  // любой из них означает «строка уже есть»
  await tx.insert(chatThreads).values(values).onConflictDoNothing();
  const rows = await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, values.id));
  if (rows.length === 0) {
    // Недостижимо при identity == ownerId: RLS спрятала строку → ошибка вызывающего
    throw new Error(`ensureThread: тред ${values.id} не виден после вставки (identity ≠ owner?)`);
  }
  return values.id;
}

/** Глобальный тред владельца (§4.5): NULL entity_id, id = uuidv5(owner:global-thread). */
export async function ensureGlobalThread(tx: Tx, ownerId: string): Promise<string> {
  return ensureThread(tx, { id: globalThreadId(ownerId), ownerId, entityId: null });
}

/**
 * Ленивый тред сущности (§4.5): id = uuidv5(owner:entity-thread:entity).
 * Тред создаётся только для видимой владельцу сущности; чужая и несуществующая
 * под RLS неразличимы — единый NOT_FOUND.
 */
export async function ensureEntityThread(
  tx: Tx,
  ownerId: string,
  entityId: string,
): Promise<string> {
  const visible = await tx
    .select({ id: entities.id })
    .from(entities)
    .where(eq(entities.id, entityId));
  if (visible.length === 0) {
    throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: entityId });
  }
  return ensureThread(tx, { id: entityThreadId(ownerId, entityId), ownerId, entityId });
}
