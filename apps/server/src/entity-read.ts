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
import { toWireChatMessage, toWireEntity, toWireEntityFromSql, toWireRelation } from './wire';

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
  /**
   * Секция «Связанное» упёрлась в потолок — за списком есть ещё связи (DF п.4).
   * Присутствует, только когда усечение реально произошло: молчаливого обрезания быть
   * не должно (урок C6), а `false` на каждом чтении — шум и в UI, и в контексте модели.
   */
  backlinksTruncated?: boolean;
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
    // регистрозависимо). Подзапросы по relations тоже под RLS — чужие связи невидимы.
    //
    // ПОЧЕМУ UNION, А НЕ ОДИН WHERE С OR (уборочная фаза, E7). Условие вида
    // `body_refs @> ARRAY[id] OR id IN (SELECT … FROM relations) OR …` планировщик не
    // покрывает `entities_body_refs_gin` целиком: ветки с IN(подзапрос) дают hashed
    // SubPlan, BitmapOr не строится — остаётся seq scan по entities. А запрос горячий:
    // 'backlinks' входит в DETAIL_INCLUDE, то есть уходит на КАЖДОМ открытии detail,
    // и после CSV-импортов фазы C сканировать приходится тысячи строк. Развод на два
    // индексируемых источника (GIN по body_refs + два индексных доступа по relations)
    // с объединением в UNION даёт планировщику работать по индексам; пометка via
    // сохраняется LEFT JOIN'ом на тот же CTE связей.
    //
    // Форма ответа НЕ меняется — контракт readEntity общий с LLM/MCP-диспатчем и
    // запиннен entity-backlinks.test.ts, который правкой не тронут.
    const rows = await tx.execute(sql`
      WITH rel AS MATERIALIZED (
        SELECT target_id AS id FROM relations
          WHERE source_id = ${row.id} AND relation_type = 'related_to'
        UNION
        SELECT source_id AS id FROM relations
          WHERE target_id = ${row.id} AND relation_type = 'related_to'
      ), ids AS (
        SELECT id FROM entities WHERE body_refs @> ARRAY[${row.id}]::text[]
        UNION
        SELECT id FROM rel
      )
      SELECT e.id, e.owner_id, e.title, e.emoji, e.body, e.body_refs, e.tags, e.meta,
             e.aspects, e.created_at, e.updated_at, e.archived,
             rel.id IS NOT NULL AS via_relation
        FROM ids
        JOIN entities e ON e.id = ids.id
        LEFT JOIN rel ON rel.id = e.id
       WHERE NOT e.archived
       -- СВЕЖИЕ первыми (DF п.4): при возрастающем порядке потолок отбрасывал ровно ту
       -- связь, которую пользователь только что создал. Лишняя строка сверх потолка —
       -- проба усечения: точный ответ «за списком есть ещё» ценой одной строки.
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ${BACKLINKS_LIMIT + 1}`);
    const refs = [...rows] as Array<Record<string, unknown>>;
    const truncated = refs.length > BACKLINKS_LIMIT;
    // Связь сильнее упоминания: сущность, которая и связана, и ссылается в теле,
    // приходит ОДНОЙ строкой с пометкой «связь».
    out.backlinks = refs.slice(0, BACKLINKS_LIMIT).map((r) => ({
      // toWireEntityFromSql, а не toWireEntity: в сырой выдаче drizzle гасит date-парсеры
      // postgres.js, и created_at/updated_at приезжают строкой PG (прецедент — агрегаты).
      entity: toWireEntityFromSql(r),
      via: r.via_relation === true ? ('relation' as const) : ('mention' as const),
    }));
    if (truncated) out.backlinksTruncated = true;
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
