// apps/server/src/entity-read.ts
// §9.2 entity_get: include-логика полного чтения одной сущности — ОБЩИЙ хелпер
// роутера entity (tRPC) и диспатча тулов LLM/MCP (tools/dispatch.ts), не копия.
// include по умолчанию body+relations; entity возвращается целиком (wire-форма
// entitySchema всегда несёт body), include управляет доп. секциями.
// Вызывается ТОЛЬКО под withIdentity (RLS, §4.10); ошибки — ExecError (роутер
// мапит в TRPCError, диспатч — в структурированный error-результат).
import { type EntityGetInput, entityThreadId } from '@orbis/shared';
import { desc, eq, or, sql } from 'drizzle-orm';
import type { WireChatMessage } from './chat/messages';
import { chatMessages, entities, relations } from './db/schema';
import type { Tx } from './db/with-identity';
import { ExecError } from './errors';
import type { WireEntity, WireRelation } from './executor/types';
import { toWireChatMessage, toWireEntity, toWireRelation } from './wire';

export interface EntityReadResult {
  entity: WireEntity;
  relations?: WireRelation[];
  backlinks?: WireEntity[];
  thread?: { threadId: string; messages: WireChatMessage[] };
}

export async function readEntity(
  tx: Tx,
  ownerId: string,
  input: EntityGetInput,
): Promise<EntityReadResult> {
  const include = new Set(input.include ?? ['body', 'relations']);
  const rows = await tx.select().from(entities).where(eq(entities.id, input.id));
  const row = rows[0];
  // RLS: чужая и несуществующая неразличимы — единый NOT_FOUND
  if (!row) {
    throw new ExecError('NOT_FOUND', 'сущность не найдена', { id: input.id });
  }

  const out: EntityReadResult = { entity: toWireEntity(row) };

  if (include.has('relations')) {
    const rels = await tx
      .select()
      .from(relations)
      .where(or(eq(relations.sourceId, row.id), eq(relations.targetId, row.id)))
      .orderBy(relations.createdAt, relations.id);
    out.relations = rels.map(toWireRelation);
  }
  if (include.has('backlinks')) {
    // §9.2: кто ссылается через body_refs; row.id — каноничный lowercase из БД
    // (body_refs нормализованы экстрактором, сравнение text[] регистрозависимо)
    const refs = await tx
      .select()
      .from(entities)
      .where(sql`${entities.bodyRefs} @> ARRAY[${row.id}]::text[]`)
      .orderBy(entities.createdAt, entities.id);
    out.backlinks = refs.map(toWireEntity);
  }
  if (include.has('thread')) {
    // Детерминированный id (§4.5); лениво НЕ создаёт: нет треда → пустой список
    const threadId = entityThreadId(ownerId, row.id);
    const msgs = await tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id));
    out.thread = { threadId, messages: msgs.map(toWireChatMessage) };
  }
  return out;
}
