// apps/server/src/db/perf-report.ts — `bun scripts/ops.ts perf` (спека §3.3): объём журнала по графам, дням
// (UTC) и источникам действия (§3.1), перцентили полевых замеров с разрезами и состояние чистки `pg_cron`.
// Только чтение (транзакция READ ONLY — забор, как у `check`).
import { PERF_METRICS } from '@orbis/shared';
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
      if (v === undefined || !(PERF_METRICS as readonly string[]).includes(v)) {
        return { error: `--metric <имя метрики>: одна из ${PERF_METRICS.join(', ')}` };
      }
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
  /** День по UTC, `YYYY-MM-DD` — не по поясу сеанса базы. */
  day: string;
  /** Источник действия (спека §3.1, разрез объёма журнала): ui, mcp, chat, routine, quick_capture… */
  actionSource: string;
  records: number;
  bytes: number;
  sessions: number;
}

/** Что меряют байты источника (M-6): числа двух источников меряют разное — это печатается рядом с ними. */
export const BYTES_MEANING: Record<JournalSource, string> = {
  chat_messages:
    'pg_column_size(metadata) системного сообщения чата: только jsonb действия, без прочих колонок строки',
  action_journal: 'pg_column_size строки action_journal целиком + её строк action_journal_entities',
};
/** Что считается «сеансом» в источнике: до плана А колонки нет, признак выводится из формы правки. */
export const SESSIONS_MEANING: Record<JournalSource, string> = {
  chat_messages:
    'одиночная правка ТОЛЬКО тела из интерфейса (source ui, entity_updated, в правке id и тело)',
  action_journal: 'строка с text_session = true (§8.5)',
};

/**
 * Объём журнала до плана А — системные сообщения чата с действием. «Сеанс» — одиночная правка ТОЛЬКО тела из
 * интерфейса (так пишет автосохранение): в `payload` правки лежат изменённые поля и `id`, поэтому «только тело» —
 * `payload` без `id` и `body` пуст. День — `AT TIME ZONE 'UTC'`, иначе `to_char` взял бы пояс сеанса базы.
 */
export async function chatJournalVolume(
  sql: SqlTx,
  sinceDays: number,
): Promise<JournalVolumeRow[]> {
  const rows = await sql<JournalVolumeRow[]>`
    SELECT t.graph_id::text AS "graphId",
           to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
           coalesce(m.metadata->'actions'->0->>'source', '-') AS "actionSource",
           count(*)::int AS records, sum(pg_column_size(m.metadata))::float8 AS bytes,
           count(*) FILTER (WHERE m.metadata->'actions'->0->>'source' = 'ui'
             AND m.metadata->'actions'->0->>'type' = 'entity_updated'
             AND m.metadata->'actions'->0->'operations'->0->'payload' ? 'body'
             AND (m.metadata->'actions'->0->'operations'->0->'payload') - 'id' - 'body' = '{}'::jsonb)::int AS sessions
      FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
     WHERE m.role = 'system' AND m.metadata ? 'actions'
       AND m.created_at >= now() - make_interval(days => ${sinceDays})
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
  return [...rows];
}

/**
 * Объём журнала с задачи 5 — таблица `action_journal` (§11). «Сеанс» — колонка `text_session` (§8.5). Байты —
 * строка целиком и её строки боковой `action_journal_entities` (РП-8): журнал занимает место в обеих.
 */
export async function tableJournalVolume(
  sql: SqlTx,
  sinceDays: number,
): Promise<JournalVolumeRow[]> {
  const rows = await sql<JournalVolumeRow[]>`
    SELECT j.graph_id::text AS "graphId",
           to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
           j.source AS "actionSource",
           count(*)::int AS records,
           (sum(pg_column_size(j.*)) + coalesce(sum(e.bytes), 0))::float8 AS bytes,
           count(*) FILTER (WHERE j.text_session)::int AS sessions
      FROM action_journal j
      LEFT JOIN LATERAL (
        SELECT sum(pg_column_size(x.*)) AS bytes FROM action_journal_entities x
         WHERE x.graph_id = j.graph_id AND x.action_id = j.id
      ) e ON true
     WHERE j.created_at >= now() - make_interval(days => ${sinceDays})
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
  return [...rows];
}

export async function journalVolume(
  sql: SqlTx,
  sinceDays: number,
): Promise<{ source: JournalSource; rows: JournalVolumeRow[] }> {
  const source = await journalSourceOf(sql);
  const rows =
    source === 'action_journal'
      ? await tableJournalVolume(sql, sinceDays)
      : await chatJournalVolume(sql, sinceDays);
  return { source, rows };
}

export function formatJournalVolume(
  v: { source: JournalSource; rows: JournalVolumeRow[] },
  sinceDays: number,
): string[] {
  const share = (s: number, n: number) => (n === 0 ? '—' : `${Math.round((100 * s) / n)}%`);
  const add = (a: { records: number; sessions: number }, r: JournalVolumeRow) => ({
    records: a.records + r.records,
    sessions: a.sessions + r.sessions,
  });
  const bySource = new Map<string, { records: number; sessions: number }>();
  for (const r of v.rows) {
    bySource.set(
      r.actionSource,
      add(bySource.get(r.actionSource) ?? { records: 0, sessions: 0 }, r),
    );
  }
  const total = v.rows.reduce((a, r) => ({ ...add(a, r), bytes: a.bytes + r.bytes }), {
    records: 0,
    sessions: 0,
    bytes: 0,
  });
  return [
    `Объём журнала за ${sinceDays} дн. (источник: ${v.source}; день — UTC)`,
    `Байты — ${BYTES_MEANING[v.source]}.`,
    `Сеанс — ${SESSIONS_MEANING[v.source]}.`,
    'Сравнимость chat_messages (база) и action_journal (после А): записи — да; байты и сеансы меряются по-разному ' +
      '(строки выше) — их сравнивать только внутри одного источника.',
    'граф                                  день        источник       записей  байт       сеансов',
    ...v.rows.map(
      (r) =>
        `${r.graphId}  ${r.day}  ${r.actionSource.padEnd(13)}  ${String(r.records).padStart(7)}  ${String(r.bytes).padStart(9)}  ${r.sessions} (${share(r.sessions, r.records)})`,
    ),
    `По источникам действия: ${
      [...bySource]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([k, t]) =>
            `${k} — записей ${t.records}, сеансов ${t.sessions} (${share(t.sessions, t.records)})`,
        )
        .join('; ') || '—'
    }`,
    `Итого: записей ${total.records}, байт ${total.bytes}, сеансов ${total.sessions} (${share(total.sessions, total.records)})`,
  ];
}

export const PERF_CLEANUP_JOB = 'orbis_perf_samples_cleanup';
export interface PerfStatRow {
  metric: string;
  appVersion: string;
  cached: boolean | null;
  screen: string | null;
  kind: string | null;
  procedure: string | null;
  n: number;
  p50: number;
  p75: number;
  p95: number;
  serverP75: number | null;
  dbP75: number | null;
}
/** Разрезы §3.3 (кеш, версия приложения) + вид экрана и действия; процедура — разрез «сервер против сети» (§3.1). */
export async function perfPercentiles(
  sql: SqlTx,
  sinceDays: number,
  metric: string | null,
): Promise<PerfStatRow[]> {
  return [
    ...(await sql<PerfStatRow[]>`
    SELECT metric, app_version AS "appVersion", cached, screen, kind, procedure, count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY dur_ms)::float8 AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY dur_ms)::float8 AS p75,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY dur_ms)::float8 AS p95,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY server_ms)::float8 AS "serverP75",
           percentile_cont(0.75) WITHIN GROUP (ORDER BY db_ms)::float8 AS "dbP75"
      FROM perf_samples
     WHERE created_at >= now() - make_interval(days => ${sinceDays}) ${metric === null ? sql`` : sql`AND metric = ${metric}`}
     GROUP BY metric, app_version, cached, screen, kind, procedure
     ORDER BY metric, app_version, screen NULLS FIRST, kind NULLS FIRST, procedure NULLS FIRST, cached NULLS FIRST`),
  ];
}
/**
 * Последний прогон чистки — в точке сохранения: нет доступа к схеме cron — строка, а не сбой отчёта. Расширения нет
 * вовсе (прод до миграции 0024) — тоже строка, и названа прямо, а не текстом ошибки.
 */
export async function cronCleanupStatus(sql: SqlTx): Promise<string> {
  try {
    return await sql.savepoint(async (sp) => {
      const [has] = await sp<{ t: string | null }[]>`SELECT to_regclass('cron.job')::text AS t`;
      if (!has?.t) return `задача pg_cron ${PERF_CLEANUP_JOB}: расширение pg_cron не установлено`;
      const [r] = await sp<{ status: string | null; at: string | null }[]>`
        SELECT d.status, d.start_time::text AS at FROM cron.job j
          LEFT JOIN LATERAL (SELECT status, start_time FROM cron.job_run_details x WHERE x.jobid = j.jobid
                              ORDER BY start_time DESC LIMIT 1) d ON true
         WHERE j.jobname = ${PERF_CLEANUP_JOB}`;
      if (r === undefined) return `задача pg_cron ${PERF_CLEANUP_JOB}: не найдена`;
      return r.status === null
        ? `задача pg_cron ${PERF_CLEANUP_JOB}: ещё не запускалась`
        : `задача pg_cron ${PERF_CLEANUP_JOB}: последний прогон ${r.at} — ${r.status}`;
    });
  } catch (e) {
    return `задача pg_cron ${PERF_CLEANUP_JOB}: нет доступа (${e instanceof Error ? e.message : String(e)})`;
  }
}

/**
 * Есть ли таблица замеров (гейт задачи 3, I-2): отчёт снимают и ДО миграции 0024 — прод-задача плана А пишет базу
 * «до» раньше, чем накатывает схему. Решает каталог, как у источника журнала (`journalSourceOf`), а не версия кода.
 */
export async function perfSamplesTableExists(sql: SqlTx): Promise<boolean> {
  const [r] = await sql<
    { t: string | null }[]
  >`SELECT to_regclass('public.perf_samples')::text AS t`;
  return Boolean(r?.t);
}
export const NO_PERF_TABLE = 'таблицы замеров нет (миграция 0024 не применена)';

const perfHead = (sinceDays: number, metric: string | null) =>
  `Замеры за ${sinceDays} дн.${metric === null ? '' : ` (метрика ${metric})`}`;

/** Раздел замеров отчёта: перцентили, а без таблицы — шапка и строка о ненакатанной миграции. */
export async function perfSection(
  sql: SqlTx,
  sinceDays: number,
  metric: string | null,
): Promise<string[]> {
  if (!(await perfSamplesTableExists(sql))) return [perfHead(sinceDays, metric), NO_PERF_TABLE];
  return formatPerfPercentiles(await perfPercentiles(sql, sinceDays, metric), sinceDays, metric);
}

/**
 * Печать перцентилей: строка на группу разрезов. Пустые разрезы — «—»; кеш — «кеш» (экран из кеша) или «сеть»
 * (данные ждали сети); время сервера и базы — в скобках, где замер его несёт (метрика `request`).
 */
export function formatPerfPercentiles(
  rows: readonly PerfStatRow[],
  sinceDays: number,
  metric: string | null,
): string[] {
  const head = perfHead(sinceDays, metric);
  if (rows.length === 0) return [head, 'замеров нет'];
  const num = (v: number) => String(Math.round(v * 10) / 10);
  const cell = (v: string | null) => v ?? '—';
  const cache = (v: boolean | null) => (v === null ? '—' : v ? 'кеш' : 'сеть');
  return [
    head,
    'метрика              версия   экран     вид       процедура                 кеш|сеть  n       p50/p75/p95',
    ...rows.map((r) => {
      const server =
        r.serverP75 === null && r.dbP75 === null
          ? ''
          : `  [сервер p75 ${r.serverP75 === null ? '—' : num(r.serverP75)}, база p75 ${r.dbP75 === null ? '—' : num(r.dbP75)}]`;
      return `${r.metric.padEnd(19)}  ${r.appVersion.padEnd(7)}  ${cell(r.screen).padEnd(8)}  ${cell(r.kind).padEnd(8)}  ${cell(r.procedure).padEnd(24)}  ${cache(r.cached).padEnd(8)}  ${String(r.n).padEnd(6)}  ${num(r.p50)}/${num(r.p75)}/${num(r.p95)} мс${server}`;
    }),
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
    for (const line of await perfSection(tx, parsed.sinceDays, parsed.metric)) io.log(line);
    io.log(await cronCleanupStatus(tx));
  });
  return 0;
}
