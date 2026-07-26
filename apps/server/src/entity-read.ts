// apps/server/src/entity-read.ts
// §9.2 entity_get: include-логика полного чтения одной сущности — ОБЩИЙ хелпер
// роутера entity (tRPC) и диспатча тулов LLM/MCP (tools/dispatch.ts), не копия.
// include по умолчанию body+relations; entity возвращается целиком (wire-форма
// entitySchema всегда несёт body), include управляет доп. секциями.
// Вызывается ТОЛЬКО под withIdentity (RLS, §4.10); ошибки — ExecError (роутер
// мапит в TRPCError, диспатч — в структурированный error-результат).
import { type EntityGetInput, entityThreadId } from '@orbis/shared';
import { and, desc, eq, not, or, sql } from 'drizzle-orm';
import type { WireChatMessage } from './chat/messages';
import { chatMessages, entities, relations } from './db/schema';
import type { Tx } from './db/with-identity';
import { ExecError } from './errors';
import type { WireEntity, WireRelation } from './executor/types';
import { toWireChatMessage, toWireEntity, toWireRelation } from './wire';

/** Источник обратной ссылки (02-core-os §3.5.7): явная related_to-связь или body_refs. */
export type BacklinkVia = 'relation' | 'mention';

export interface Backlink {
  entity: WireEntity;
  via: BacklinkVia;
}

/** Потолок объединённой секции «Связанное» (sign-off K1): это экран, а не выгрузка. */
const BACKLINKS_LIMIT = 100;

export interface EntityReadResult {
  entity: WireEntity;
  relations?: WireRelation[];
  backlinks?: Backlink[];
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
    // §3.5.7: ОДНА секция из двух источников — явные related_to обеих сторон («связь») и
    // упоминания через body_refs («упоминание», GIN-индекс §4.9). row.id — каноничный
    // lowercase из БД (body_refs нормализованы экстрактором, сравнение text[]
    // регистрозависимо). Подзапрос по relations тоже под RLS — чужие связи невидимы.
    // Некоррелированные подзапросы (стиль children_of/parents_of компилятора §6.1): в
    // списке SELECT drizzle рендерит колонку без квалификатора таблицы, и коррелированный
    // EXISTS сравнивал бы relations.id вместо entities.id.
    const viaRelation = sql<boolean>`(${entities.id} IN (
      SELECT target_id FROM relations WHERE source_id = ${row.id} AND relation_type = 'related_to')
      OR ${entities.id} IN (
      SELECT source_id FROM relations WHERE target_id = ${row.id} AND relation_type = 'related_to'))`;
    const refs = await tx
      .select({ row: entities, viaRelation })
      .from(entities)
      .where(
        and(
          not(entities.archived),
          or(sql`${entities.bodyRefs} @> ARRAY[${row.id}]::text[]`, viaRelation),
        ),
      )
      .orderBy(entities.createdAt, entities.id)
      .limit(BACKLINKS_LIMIT);
    // Связь сильнее упоминания: сущность, которая и связана, и ссылается в теле,
    // приходит ОДНОЙ строкой с пометкой «связь».
    out.backlinks = refs.map((r) => ({
      entity: toWireEntity(r.row),
      via: r.viaRelation ? ('relation' as const) : ('mention' as const),
    }));
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
