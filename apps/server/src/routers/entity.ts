// apps/server/src/routers/entity.ts
// Роутер entity (§9.1): ТОЛЬКО трансляция — вход → executor/компилятор, результат → wire,
// коды executor'а → TRPCError. Бизнес-логики здесь нет: мутации идут единственным путём
// через execute (§9.2), чтения — под withIdentity (RLS, §4.10).
import {
  entityCreateInput,
  entityGetInput,
  entityThreadId,
  entityUpdateInput,
  parseQuery,
} from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { desc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { chatMessages, entities, relations, userSettings } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { execErrorToTRPC } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { WireEntity } from '../executor/types';
import {
  type CompileContext,
  compileCount,
  compileQuery,
  loadCatalog,
  QueryCompileError,
} from '../query/compile';
import { protectedProcedure, router } from '../trpc';
import { toWireChatMessage, toWireEntity, toWireEntityFromSql, toWireRelation } from '../wire';

// Боевой синк — один инстанс на модуль: makeChatJournalSink состояния не хранит,
// а тред/сообщение он пишет тем же tx, что executor (§7.8).
const sink = makeChatJournalSink();

/**
 * CompileContext запроса (§6.1): каталог — из реестра на запрос (решение Task 8);
 * timezone — из user_settings владельца (RLS скоупит выборку), без строки
 * (онбординг-сидирование — Task 13) — дефолт 'Europe/Moscow'; today — «сегодня»
 * в этой таймзоне (en-CA даёт ровно YYYY-MM-DD).
 */
async function queryContext(
  tx: Tx,
  actorUserId: string,
  thisEntityId: string | null,
): Promise<CompileContext> {
  const catalog = await loadCatalog(tx);
  const rows = await tx
    .select({ timezone: userSettings.timezone })
    .from(userSettings)
    .where(eq(userSettings.ownerId, actorUserId));
  const timezone = rows[0]?.timezone ?? 'Europe/Moscow';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  return { catalog, thisEntityId, today, timezone };
}

/** Разбор + компиляция: ошибки парсинга/компиляции → BAD_REQUEST, структура в cause (§6.4). */
function compileOrThrow(
  query: string,
  cctx: CompileContext,
  compile: typeof compileQuery | typeof compileCount,
) {
  const parsed = parseQuery(query, cctx.catalog);
  if (!parsed.ok) {
    // Клиент (1c) рендерит красную плашку по {message, position}
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: parsed.error.message,
      cause: parsed.error,
    });
  }
  try {
    return compile(parsed.ast, cctx);
  } catch (e) {
    if (e instanceof QueryCompileError) {
      // Структурная ошибка компиляции (`this` вне контекста): позиция неизвестна
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: e.message,
        cause: { message: e.message },
      });
    }
    throw e;
  }
}

const querySignature = z
  .object({ query: z.string().min(1), thisEntityId: z.string().uuid().optional() })
  .strict();

export const entityRouter = router({
  // Источник клиентского create ограничен fast_path/quick_capture (§7.5, 02 §5);
  // 'chat'/'mcp'/'system' недостижимы через этот роутер по построению.
  create: protectedProcedure
    .input(z.object({ input: entityCreateInput, source: z.enum(['fast_path', 'quick_capture']) }))
    .mutation(async ({ ctx, input }): Promise<WireEntity> => {
      const r = await execute(
        ctx.db,
        {
          actorUserId: ctx.actorUserId,
          actorKind: 'owner',
          source: input.source,
          operations: [{ tool: 'entity_create', input: input.input }],
        },
        { sink },
      );
      if (!r.ok) throw execErrorToTRPC(r.error);
      return r.results[0] as WireEntity;
    }),

  update: protectedProcedure
    .input(entityUpdateInput)
    .mutation(async ({ ctx, input }): Promise<WireEntity> => {
      const r = await execute(
        ctx.db,
        {
          actorUserId: ctx.actorUserId,
          actorKind: 'owner',
          source: 'fast_path', // прямое действие владельца в UI (не chat/mcp/system)
          operations: [{ tool: 'entity_update', input }],
        },
        { sink },
      );
      if (!r.ok) throw execErrorToTRPC(r.error);
      return r.results[0] as WireEntity;
    }),

  // §9.2 entity_get: include по умолчанию body+relations; entity возвращается целиком
  // (wire-форма entitySchema всегда несёт body), include управляет доп. секциями.
  get: protectedProcedure.input(entityGetInput).query(({ ctx, input }) =>
    withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
      const include = new Set(input.include ?? ['body', 'relations']);
      const rows = await tx.select().from(entities).where(eq(entities.id, input.id));
      const row = rows[0];
      // RLS: чужая и несуществующая неразличимы — единый NOT_FOUND
      if (!row) {
        throw execErrorToTRPC({
          code: 'NOT_FOUND',
          message: 'сущность не найдена',
          details: { id: input.id },
        });
      }

      const out: {
        entity: WireEntity;
        relations?: ReturnType<typeof toWireRelation>[];
        backlinks?: WireEntity[];
        thread?: { threadId: string; messages: ReturnType<typeof toWireChatMessage>[] };
      } = { entity: toWireEntity(row) };

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
        const threadId = entityThreadId(ctx.actorUserId, row.id);
        const msgs = await tx
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.threadId, threadId))
          .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id));
        out.thread = { threadId, messages: msgs.map(toWireChatMessage) };
      }
      return out;
    }),
  ),

  query: protectedProcedure.input(querySignature).query(({ ctx, input }) =>
    withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
      const cctx = await queryContext(tx, ctx.actorUserId, input.thisEntityId ?? null);
      const compiled = compileOrThrow(input.query, cctx, compileQuery);
      const rows = await tx.execute(compiled);
      return [...rows].map((r) => toWireEntityFromSql(r as Record<string, unknown>));
    }),
  ),

  // Бейджи (02 §3.2): count игнорирует limit — compileCount не включает его по построению
  count: protectedProcedure.input(querySignature).query(({ ctx, input }) =>
    withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
      const cctx = await queryContext(tx, ctx.actorUserId, input.thisEntityId ?? null);
      const compiled = compileOrThrow(input.query, cctx, compileCount);
      const rows = await tx.execute(compiled);
      return { count: Number(rows[0]?.count) };
    }),
  ),
});
