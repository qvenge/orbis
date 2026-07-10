// apps/server/src/recurring/with-materialization.ts
// Общий каркас «контекст → парс → окно из AST → материализация → исполнение» для ВСЕХ
// потребителей query-движка (01 §5.4: «любой запрос диапазона дат материализует»):
// tRPC-роутер entity (query/count) и LLM/MCP-диспатч entity_query. Роутер budget (A6)
// вызывает materializeInstances явно со своим окном — этот каркас ему не нужен.
import type { QueryAst } from '@orbis/shared';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import type { CompileContext } from '../query/compile';
import { queryContext } from '../query/context';
import { materializationWindow, materializeInstances } from './materialize';

export interface QueryWithMaterializationOpts<T> {
  db: Db;
  actorUserId: string;
  /** Сущность-контекст `this` (query-блок в body) или null. */
  thisEntityId: string | null;
  /** Разбор запроса; ошибку парсинга мапит вызывающий (TRPCError у роутера, ExecError у диспатча). */
  parse: (cctx: CompileContext) => QueryAst;
  /** Компиляция + исполнение под withIdentity-tx. */
  run: (tx: Tx, ast: QueryAst, cctx: CompileContext) => Promise<T>;
}

/**
 * Двухфазное исполнение запроса с хуком материализации. Детект окна —
 * чистая AST-прогулка (materializationWindow): запрос без date-условий по
 * start_at/occurred_on исполняется ТЕМ ЖЕ tx фазы 1 без единого лишнего обращения
 * к БД. С окном — материализация МЕЖДУ транзакциями (executor открывает собственные
 * tx; вложенность в живой tx истощала бы пул соединений), затем исполнение вторым tx.
 */
export async function queryWithMaterialization<T>(
  opts: QueryWithMaterializationOpts<T>,
): Promise<T> {
  const { db, actorUserId } = opts;
  type Phase1 =
    | { kind: 'done'; result: T }
    | {
        kind: 'materialize';
        window: { from: string; to: string };
        ast: QueryAst;
        cctx: CompileContext;
      };
  const phase1 = await withIdentity(db, actorUserId, async (tx): Promise<Phase1> => {
    const cctx = await queryContext(tx, actorUserId, opts.thisEntityId);
    const ast = opts.parse(cctx);
    const window = materializationWindow(ast, cctx.today);
    if (window) return { kind: 'materialize', window, ast, cctx };
    return { kind: 'done', result: await opts.run(tx, ast, cctx) };
  });
  if (phase1.kind === 'done') return phase1.result;
  await materializeInstances({
    db,
    ownerId: actorUserId,
    from: phase1.window.from,
    to: phase1.window.to,
    today: phase1.cctx.today,
  });
  return withIdentity(db, actorUserId, (tx) => opts.run(tx, phase1.ast, phase1.cctx));
}
