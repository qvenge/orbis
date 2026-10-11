// Два прохода окна простоя (РП-2): первый оставляет старый журнал читающему его коду;
// второй удаляет только уже перенесённое. После admin commit старые предложения снимает RLS владельца.
import type { GraphId } from '@orbis/shared';
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { batchIdsInJournalQuery } from '../executor/journal-read';
import { type Identity, identitiesForScheduler, parseGraphId } from '../identity';
import {
  legacyJournalReport,
  prospectiveJournalQuery,
  transferJournal,
  transferredLegacyMessagesQuery,
} from '../journal/transfer';
import { closeStaleBodyProposals, listStaleBodyProposals } from '../policy/pending';
import type { Db } from './client';
import { migrate1vGate, rehearsalDsnRefusal, type SqlClient } from './migrate-1v';
import { describeRoleAccess } from './role-access';
import * as schema from './schema';
import { type Tx, withIdentity } from './with-identity';

export type { SqlClient } from './migrate-1v';

export interface MigrateSpeedAReport {
  graph: string;
  legacyActions: number;
  legacyUndo: number;
  alreadyInTable: number;
  seedable: number;
  staleProposals: string[];
  missingRequired: number;
}
/** Последняя операция тела внутри пачки важнее предыдущей: порядок времени/id одинаков у всей пачки. */
function bodyWriters(journal: SQL): SQL {
  return sql`WITH journal AS (${journal})
    SELECT DISTINCT ON (lower(op.value->'payload'->>'id'))
           lower(op.value->'payload'->>'id') AS entity_id, j.id AS action_id,
           op.value->'payload'->>'body' AS new_body
      FROM journal j CROSS JOIN LATERAL jsonb_array_elements(j.operations)
        WITH ORDINALITY AS op(value, ord)
     WHERE j.type <> 'undo' AND op.value->>'op' = 'entity_update' AND op.value->'payload' ? 'body'
       AND NOT EXISTS (SELECT 1 FROM journal u WHERE u.undoes = j.id)
     ORDER BY lower(op.value->'payload'->>'id'), j.created_at DESC, j.id DESC, op.ord DESC`;
}
const currentJournal = (graph: GraphId): SQL => sql`
  SELECT id, created_at, type, operations, undoes FROM action_journal WHERE graph_id = ${graph}::uuid`;

/** Отчёт идёт сырыми SELECT без реестра и без каких-либо изменений. IO дополнительно ставит READ ONLY. */
export async function reportMigrateSpeedA(
  client: SqlClient,
  graph: string,
): Promise<MigrateSpeedAReport> {
  const g = parseGraphId(graph);
  // Каноничные читатели используют только execute; адаптер не открывает пишущую identity-транзакцию.
  const reader = {
    execute(query: SQL) {
      const q = new PgDialect().sqlToQuery(query);
      return client.unsafe(q.sql, q.params as never[]);
    },
  } as unknown as Tx;
  const legacy = await legacyJournalReport(reader, g);
  const already = await reader.execute(
    sql`SELECT count(*)::int AS n FROM action_journal WHERE graph_id=${g}::uuid`,
  );
  const prospective = prospectiveJournalQuery(g);
  const executed = await reader.execute(batchIdsInJournalQuery(prospective));
  const executedBeforeTransfer = new Set(executed.map((row) => String(row.id).toLowerCase()));
  const seeds = await reader.execute(sql`SELECT count(*)::int AS n FROM entities e
    JOIN (${bodyWriters(prospective)}) w ON e.id::text = w.entity_id
    WHERE e.graph_id=${g}::uuid AND e.body_action_id IS NULL AND e.body = w.new_body`);
  return {
    graph: g,
    legacyActions: legacy.legacyActions,
    legacyUndo: legacy.legacyUndo,
    alreadyInTable: Number(already[0]?.n ?? 0),
    seedable: Number(seeds[0]?.n ?? 0),
    staleProposals: await listStaleBodyProposals(reader, g, executedBeforeTransfer),
    missingRequired: legacy.untransferable,
  };
}

export async function applyMigrateSpeedA(
  db: Db,
  client: SqlClient,
  who: Identity,
  opts: { sweepMessages: boolean; beforeSweep?: () => Promise<void> },
) {
  const admin = drizzle(client as Sql, { schema });
  if (!(await describeRoleAccess(admin)).bypassRls)
    throw new Error('migrate-speed-a: нужна роль с BYPASSRLS');
  const graph = who.graph;
  const transferred = await admin.transaction(async (tx) => {
    const before = await legacyJournalReport(tx, graph);
    if (before.untransferable > 0)
      throw new Error(`migrate-speed-a: непереносимых записей ${before.untransferable} — СТОП`);
    const r = await transferJournal(tx, graph);
    // Старый писатель мог дописать после preflight; его непереносимое сообщение нельзя спрятать за успехом.
    if (r.skipped > 0)
      throw new Error(`migrate-speed-a: непереносимых записей ${r.skipped} — СТОП`);
    let deletedMessages = 0;
    if (opts.sweepMessages) {
      await opts.beforeSweep?.();
      // Одна инструкция, один снимок READ COMMITTED: старый писатель после переноса остаётся до следующего прохода.
      const deleted = await tx.execute(sql`DELETE FROM chat_messages m
        WHERE m.id::text IN (${transferredLegacyMessagesQuery(graph)}) RETURNING m.id`);
      deletedMessages = deleted.length;
    }
    // Только служебная колонка: триггер UPDATE OF body/body_doc не трогает тело, ревизию и время.
    // Создание/attach/merge не дают владения телом; чужая правка без совпадения текста также остаётся без него.
    const seeded = await tx.execute(sql`UPDATE entities e SET body_action_id = w.action_id
      FROM (${bodyWriters(currentJournal(graph))}) w
      WHERE e.id::text = w.entity_id AND e.graph_id=${graph}::uuid
        AND e.body_action_id IS NULL AND e.body = w.new_body RETURNING e.id`);
    return { moved: r.moved, undo: r.undo, deletedMessages, seeded: seeded.length };
  });
  // Ошибка снятия не откатывает состоявшийся перенос: повтор продолжает с уже заполненной таблицы.
  const closedProposals = await withIdentity(db, who, (tx) => closeStaleBodyProposals(tx, who));
  return { ...transferred, closedProposals };
}

export interface MigrateSpeedAIo {
  readDsn(): string;
  rehearsalDsn(): string | undefined;
  open(dsn: string): { db: Db; sql: Sql; close(): Promise<void> };
  identities(db: Db): Promise<Identity[]>;
  log(line: string): void;
  error(line: string): void;
  beforeSweep?(who: Identity): Promise<void>;
}
export function migrateSpeedAIo(deps: {
  readDsn(): string;
  env: Readonly<Record<string, string | undefined>>;
  openSql(dsn: string): Sql;
  log(line: string): void;
  error(line: string): void;
}): MigrateSpeedAIo {
  return {
    readDsn: deps.readDsn,
    rehearsalDsn: () => deps.env.ORBIS_REHEARSAL_DSN,
    open: (dsn) => {
      const pool = deps.openSql(dsn);
      return { sql: pool, db: drizzle(pool, { schema }), close: () => pool.end() };
    },
    identities: identitiesForScheduler,
    log: deps.log,
    error: deps.error,
  };
}
const USAGE =
  'migrate-speed-a: --report | --apply [--sweep-messages] --i-understand; --rehearsal — только модификатор режима';
export async function runMigrateSpeedA(args: string[], io: MigrateSpeedAIo): Promise<number> {
  const sweepMessages = args.includes('--sweep-messages');
  const gate = migrate1vGate(args.filter((a) => a !== '--sweep-messages'));
  if (!gate.proceed) {
    io.error((gate.lines[0] ?? USAGE).replaceAll('migrate-1v', 'migrate-speed-a'));
    io.error(USAGE);
    return gate.code;
  }
  if (
    (gate.mode !== 'report' && gate.mode !== 'apply') ||
    (sweepMessages && gate.mode !== 'apply')
  ) {
    io.error(USAGE);
    return 2;
  }
  const candidate = io.rehearsalDsn();
  let dsn: string;
  if (gate.rehearsal) {
    const refusal = rehearsalDsnRefusal(candidate);
    if (refusal !== null) {
      io.error(refusal.replaceAll('migrate-1v:', 'migrate-speed-a:'));
      return 2;
    }
    dsn = candidate as string;
    io.log('репетиция: локальная база из ORBIS_REHEARSAL_DSN');
  } else if (candidate !== undefined && candidate.trim() !== '') {
    io.error('migrate-speed-a: ORBIS_REHEARSAL_DSN задана без --rehearsal — добавьте флаг');
    return 2;
  } else {
    dsn = io.readDsn();
  }
  const { db, sql: pool, close } = io.open(dsn);
  let failed = 0;
  try {
    if (!(await describeRoleAccess(db)).bypassRls) {
      io.error(
        'migrate-speed-a: нужна роль с BYPASSRLS, иначе счёт под FORCE RLS будет ложным нулём',
      );
      return 1;
    }
    const whos = await io.identities(db);
    // Общий preflight до первой записи: STOP любого графа не оставляет другие наполовину переведёнными.
    for (const who of whos) {
      const r = await pool.begin('read only', (tx) => reportMigrateSpeedA(tx, who.graph));
      io.log(JSON.stringify(r));
      if (r.missingRequired > 0) {
        io.error(`граф ${who.graph}: непереносимых ${r.missingRequired} — СТОП`);
        failed++;
      }
    }
    if (gate.mode === 'report' || failed > 0) return failed > 0 ? 1 : 0;
    for (const who of whos) {
      try {
        const r = await applyMigrateSpeedA(db, pool, who, {
          sweepMessages,
          beforeSweep:
            io.beforeSweep === undefined ? undefined : () => io.beforeSweep?.(who) as Promise<void>,
        });
        io.log(`граф ${who.graph}: ${JSON.stringify(r)}`);
      } catch (e) {
        // Драйвер может включить DSN в ошибку подключения; секрет не выходит в транскрипт.
        io.error(
          `граф ${who.graph}: ${String(e instanceof Error ? e.message : e).replaceAll(dsn, '[DSN скрыт]')}`,
        );
        failed++;
      }
    }
  } finally {
    await close();
  }
  return failed > 0 ? 1 : 0;
}
