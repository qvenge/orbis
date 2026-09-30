// apps/server/src/db/perf-report.ts — `bun scripts/ops.ts perf` (спека §3.3): объём журнала по графам и дням.
// Только чтение (транзакция READ ONLY — забор, как у `check`). Перцентили замеров добавит задача 3.
import type postgres from 'postgres';

export type SqlTx = postgres.TransactionSql;
export interface PerfArgs {
  sinceDays: number;
  metric: string | null;
}

export function parsePerfArgs(args: readonly string[]): PerfArgs | { error: string } {
  const out: PerfArgs = { sinceDays: 7, metric: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--since') {
      const m = /^(\d{1,3})d$/.exec(args[++i] ?? '');
      const days = m ? Number(m[1]) : 0;
      if (days < 1 || days > 365) return { error: '--since <N>d, N от 1 до 365' };
      out.sinceDays = days;
    } else if (a === '--metric') {
      const v = args[++i];
      if (v === undefined) return { error: '--metric <имя метрики>' };
      out.metric = v;
    } else return { error: `неизвестный флаг «${a}»` };
  }
  return out;
}

export type JournalSource = 'action_journal' | 'chat_messages';
/** Журнал — таблица с задачи 5 (§11); до неё — системные сообщения чата. Решает каталог, а не версия кода. */
export async function journalSourceOf(sql: SqlTx): Promise<JournalSource> {
  const [r] = await sql<
    { t: string | null }[]
  >`SELECT to_regclass('public.action_journal')::text AS t`;
  return r?.t ? 'action_journal' : 'chat_messages';
}

export interface JournalVolumeRow {
  graphId: string;
  day: string;
  records: number;
  bytes: number;
  sessions: number;
}

export async function journalVolume(
  sql: SqlTx,
  sinceDays: number,
): Promise<{ source: JournalSource; rows: JournalVolumeRow[] }> {
  const source = await journalSourceOf(sql);
  // «Сеанс» до плана А — одиночная правка ТОЛЬКО тела из интерфейса (так пишет автосохранение);
  // после — колонка `text_session` (§8.5). День — UTC.
  const rows =
    source === 'action_journal'
      ? await sql<JournalVolumeRow[]>`
          SELECT graph_id::text AS "graphId", to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                 count(*)::int AS records, sum(pg_column_size(j.*))::float8 AS bytes,
                 count(*) FILTER (WHERE text_session)::int AS sessions
            FROM action_journal j
           WHERE created_at >= now() - make_interval(days => ${sinceDays})
           GROUP BY 1, 2 ORDER BY 1, 2`
      : await sql<JournalVolumeRow[]>`
          SELECT t.graph_id::text AS "graphId", to_char(date_trunc('day', m.created_at), 'YYYY-MM-DD') AS day,
                 count(*)::int AS records, sum(pg_column_size(m.metadata))::float8 AS bytes,
                 count(*) FILTER (WHERE m.metadata->'actions'->0->>'source' = 'ui'
                   AND m.metadata->'actions'->0->>'type' = 'entity_updated'
                   AND m.metadata->'actions'->0->'operations'->0->'payload' ? 'body'
                   AND (m.metadata->'actions'->0->'operations'->0->'payload') - 'id' - 'body' = '{}'::jsonb)::int AS sessions
            FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
           WHERE m.role = 'system' AND m.metadata ? 'actions'
             AND m.created_at >= now() - make_interval(days => ${sinceDays})
           GROUP BY 1, 2 ORDER BY 1, 2`;
  return { source, rows: [...rows] };
}

export function formatJournalVolume(
  v: { source: JournalSource; rows: JournalVolumeRow[] },
  sinceDays: number,
): string[] {
  const total = v.rows.reduce(
    (a, r) => ({
      records: a.records + r.records,
      bytes: a.bytes + r.bytes,
      sessions: a.sessions + r.sessions,
    }),
    { records: 0, bytes: 0, sessions: 0 },
  );
  const share = (s: number, n: number) => (n === 0 ? '—' : `${Math.round((100 * s) / n)}%`);
  return [
    `Объём журнала за ${sinceDays} дн. (источник: ${v.source})`,
    'граф                                  день        записей  байт       сеансов',
    ...v.rows.map(
      (r) =>
        `${r.graphId}  ${r.day}  ${String(r.records).padStart(7)}  ${String(r.bytes).padStart(9)}  ${r.sessions} (${share(r.sessions, r.records)})`,
    ),
    `Итого: записей ${total.records}, байт ${total.bytes}, сеансов ${total.sessions} (${share(total.sessions, total.records)})`,
  ];
}

export interface PerfReportIo {
  sql: postgres.Sql;
  log(line: string): void;
  error(line: string): void;
}

export async function runPerfReport(args: readonly string[], io: PerfReportIo): Promise<number> {
  const parsed = parsePerfArgs(args);
  if ('error' in parsed) {
    io.error(`ops perf: ${parsed.error}`);
    return 2;
  }
  await io.sql.begin('read only', async (tx) => {
    for (const line of formatJournalVolume(
      await journalVolume(tx, parsed.sinceDays),
      parsed.sinceDays,
    ))
      io.log(line);
  });
  return 0;
}
