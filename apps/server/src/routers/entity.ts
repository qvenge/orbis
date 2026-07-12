// apps/server/src/routers/entity.ts
// Роутер entity (§9.1): ТОЛЬКО трансляция — вход → executor/компилятор, результат → wire,
// коды executor'а → TRPCError. Бизнес-логики здесь нет: мутации идут единственным путём
// через execute (§9.2), чтения — под withIdentity (RLS, §4.10).
import {
  entityCreateInput,
  entityGetInput,
  entityUpdateInput,
  parseQuery,
  type QueryAst,
} from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import { readEntity } from '../entity-read';
import { ExecError, execErrorToTRPC } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { WireEntity } from '../executor/types';
import {
  type CompileContext,
  compileCount,
  compileQuery,
  QueryCompileError,
} from '../query/compile';
import { queryWithMaterialization } from '../recurring/with-materialization';
import { ownerOnlyProcedure, protectedProcedure, router } from '../trpc';
import { toWireEntityFromSql } from '../wire';

// Боевой синк — один инстанс на модуль: makeChatJournalSink состояния не хранит,
// а тред/сообщение он пишет тем же tx, что executor (§7.8).
const sink = makeChatJournalSink();

/** Разбор запроса: ошибки парсинга → BAD_REQUEST, структура в cause (§6.4). */
function parseOrThrow(query: string, cctx: CompileContext): QueryAst {
  const parsed = parseQuery(query, cctx.catalog);
  if (!parsed.ok) {
    // Клиент (1c) рендерит красную плашку по {message, position}
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: parsed.error.message,
      cause: parsed.error,
    });
  }
  return parsed.ast;
}

/** Компиляция AST: ошибки компиляции → BAD_REQUEST (§6.4). */
function compileAstOrThrow(
  ast: QueryAst,
  cctx: CompileContext,
  compile: typeof compileQuery | typeof compileCount,
) {
  try {
    return compile(ast, cctx);
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

/**
 * Хук материализации (01 §5.4) для query/count: общий каркас queryWithMaterialization —
 * контекст + парс, при окне по start_at/occurred_on — материализация recurring-инстансов
 * ДО компиляции/исполнения; без окна запрос исполняется тем же tx (детали — в
 * recurring/with-materialization.ts, тот же каркас у LLM/MCP-диспатча entity_query).
 */
function runQueryWithMaterialization<T>(
  db: Db,
  actorUserId: string,
  input: { query: string; thisEntityId?: string },
  run: (tx: Tx, ast: QueryAst, cctx: CompileContext) => Promise<T>,
): Promise<T> {
  return queryWithMaterialization({
    db,
    actorUserId,
    thisEntityId: input.thisEntityId ?? null,
    parse: (cctx) => parseOrThrow(input.query, cctx),
    run,
  });
}

const querySignature = z
  .object({ query: z.string().min(1), thisEntityId: z.string().uuid().optional() })
  .strict();

export const entityRouter = router({
  // Источник клиентского create ограничен fast_path/quick_capture/ui (§7.5, 02 §5;
  // 'ui' — прямое действие владельца в форме, например создание конверта 03 §3.1);
  // 'chat'/'mcp'/'system' недостижимы через этот роутер по построению.
  create: ownerOnlyProcedure
    .input(
      z.object({ input: entityCreateInput, source: z.enum(['fast_path', 'quick_capture', 'ui']) }),
    )
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

  update: ownerOnlyProcedure
    .input(entityUpdateInput)
    .mutation(async ({ ctx, input }): Promise<WireEntity> => {
      const r = await execute(
        ctx.db,
        {
          actorUserId: ctx.actorUserId,
          actorKind: 'owner',
          source: 'ui', // прямое действие владельца в UI (не chat/mcp/system)
          operations: [{ tool: 'entity_update', input }],
        },
        { sink },
      );
      if (!r.ok) throw execErrorToTRPC(r.error);
      return r.results[0] as WireEntity;
    }),

  // §9.2 entity_get: include-логика вынесена в общий хелпер entity-read.ts —
  // его же переиспользует диспатч тулов LLM/MCP (tools/dispatch.ts, 1b Task 4).
  get: protectedProcedure.input(entityGetInput).query(async ({ ctx, input }) => {
    try {
      return await withIdentity(ctx.db, ctx.actorUserId, (tx) =>
        readEntity(tx, ctx.actorUserId, input),
      );
    } catch (e) {
      if (e instanceof ExecError) throw execErrorToTRPC(e);
      throw e;
    }
  }),

  query: protectedProcedure.input(querySignature).query(({ ctx, input }) =>
    runQueryWithMaterialization(ctx.db, ctx.actorUserId, input, async (tx, ast, cctx) => {
      const compiled = compileAstOrThrow(ast, cctx, compileQuery);
      const rows = await tx.execute(compiled);
      return [...rows].map((r) => toWireEntityFromSql(r as Record<string, unknown>));
    }),
  ),

  // Бейджи (02 §3.2): count игнорирует limit — compileCount не включает его по построению
  count: protectedProcedure.input(querySignature).query(({ ctx, input }) =>
    runQueryWithMaterialization(ctx.db, ctx.actorUserId, input, async (tx, ast, cctx) => {
      const compiled = compileAstOrThrow(ast, cctx, compileCount);
      const rows = await tx.execute(compiled);
      return { count: Number(rows[0]?.count) };
    }),
  ),
});
