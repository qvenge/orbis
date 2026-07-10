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
import { queryContext } from '../query/context';
import { materializationWindow, materializeInstances } from '../recurring/materialize';
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
 * Общий каркас query/count с хуком материализации (01 §5.4): контекст + парс, затем —
 * если AST содержит условие по date/timestamp-полю orbis/schedule/orbis/financial
 * (start_at/occurred_on) — материализация recurring-инстансов окна запроса ДО
 * компиляции/исполнения. Детект окна — чистая AST-прогулка: запрос без date-условий
 * исполняется ТЕМ ЖЕ tx без единого лишнего обращения к БД. С окном — материализация
 * между транзакциями: executor открывает собственные tx, вложенность в живой tx
 * истощала бы пул соединений.
 */
async function runQueryWithMaterialization<T>(
  db: Db,
  actorUserId: string,
  input: { query: string; thisEntityId?: string },
  run: (tx: Tx, ast: QueryAst, cctx: CompileContext) => Promise<T>,
): Promise<T> {
  type Phase1 =
    | { kind: 'done'; result: T }
    | {
        kind: 'materialize';
        window: { from: string; to: string };
        ast: QueryAst;
        cctx: CompileContext;
      };
  const phase1 = await withIdentity(db, actorUserId, async (tx): Promise<Phase1> => {
    const cctx = await queryContext(tx, actorUserId, input.thisEntityId ?? null);
    const ast = parseOrThrow(input.query, cctx);
    const window = materializationWindow(ast, cctx.today);
    if (window) return { kind: 'materialize', window, ast, cctx };
    return { kind: 'done', result: await run(tx, ast, cctx) };
  });
  if (phase1.kind === 'done') return phase1.result;
  await materializeInstances({
    db,
    ownerId: actorUserId,
    from: phase1.window.from,
    to: phase1.window.to,
    today: phase1.cctx.today,
  });
  return withIdentity(db, actorUserId, (tx) => run(tx, phase1.ast, phase1.cctx));
}

const querySignature = z
  .object({ query: z.string().min(1), thisEntityId: z.string().uuid().optional() })
  .strict();

export const entityRouter = router({
  // Источник клиентского create ограничен fast_path/quick_capture (§7.5, 02 §5);
  // 'chat'/'mcp'/'system' недостижимы через этот роутер по построению.
  create: ownerOnlyProcedure
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
