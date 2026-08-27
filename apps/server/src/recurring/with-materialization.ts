// apps/server/src/recurring/with-materialization.ts
// Общий каркас «контекст → парс → окно из AST → материализация → исполнение» для ВСЕХ
// потребителей query-движка (01 §5.4: «любой запрос диапазона дат материализует»):
// tRPC-роутер entity (query/count) и LLM/MCP-диспатч entity_query. Роутер budget (A6)
// вызывает materializeInstances явно со своим окном — этот каркас ему не нужен.
import type { QueryAst } from '@orbis/shared/query';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import type { CompileCtx } from '../query/compile-ast';
import { queryContext } from '../query/context';
import { materializationWindow, materializeInstances } from './materialize';

export interface QueryWithMaterializationOpts<T> {
  db: Db;
  actorUserId: string;
  /** Сущность-контекст `this` (query-блок в body) или null. */
  thisEntityId: string | null;
  /** Разбор запроса; ошибку парсинга мапит вызывающий (TRPCError у роутера, ExecError у диспатча). */
  parse: (cctx: CompileCtx) => QueryAst;
  /** Компиляция + исполнение под withIdentity-tx. */
  run: (tx: Tx, ast: QueryAst, cctx: CompileCtx) => Promise<T>;
}

/**
 * Двухфазное исполнение запроса с хуком материализации. Детект окна — чистая прогулка по
 * ДЕРЕВУ (`materializationWindow`): запрос без условий по свойствам-триггерам исполняется
 * ТЕМ ЖЕ tx фазы 1, без единого лишнего обращения к БД. С окном — материализация МЕЖДУ
 * транзакциями (executor открывает собственные tx; вложенность в живой tx истощала бы пул
 * соединений), затем исполнение вторым tx.
 *
 * ТРИГГЕРОВ ТРИ, а не два: Задача 9b добавила к `orbis/start_at`/`orbis/occurred_on` ещё и
 * `orbis/due_date` — на нём стоят списки «Сегодня», «Ближайшие 7 дней» и «Позже», и без
 * него повторяющаяся задача со сроком в них просто не появлялась. Цена названа вслух:
 * запрос со сроком теперь ВСЕГДА идёт двумя транзакциями вместо одной (фаза 1 — контекст и
 * разбор, фаза 2 — исполнение), а между ними работает executor. Это ровно та цена, которую
 * §5.4 назначает за ленивую материализацию, — просто теперь её платит и Agenda.
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
        cctx: CompileCtx;
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
