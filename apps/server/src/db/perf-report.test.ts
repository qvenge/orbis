import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import type postgres from 'postgres';
import { adminDb, appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import {
  chatJournalVolume,
  cronCleanupStatus,
  formatJournalVolume,
  formatPerfPercentiles,
  type JournalVolumeRow,
  journalSourceOf,
  journalVolume,
  NO_PERF_TABLE,
  PERF_CLEANUP_JOB,
  type PerfStatRow,
  parsePerfArgs,
  perfPercentiles,
  perfSection,
  runPerfReport,
} from './perf-report';

requireEnv();
const { db, client } = appDb();
const admin = adminDb();
const sink = makeJournalSink();
beforeAll(truncateAll);
afterAll(async () => {
  await truncateAll();
  await client.end();
  await admin.client.end();
});

/** Пояс сеанса UTC+14: у отметки 23:30 UTC местный день — уже следующий, «день — UTC» проверяем на нём. */
const FAR_EAST = 'Etc/GMT-14';
/**
 * 23:30 UTC вчерашнего дня — в окне `--since`, и в поясе UTC+14 это уже другой календарный день. Отметка — строкой
 * ISO, день — из неё же средствами JS (независимо от SQL отчёта): у клиента, обёрнутого drizzle, разбор дат и
 * сериализация json отключены.
 */
async function lateUtc(
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<{ iso: string; day: string }> {
  const [r] = await sql<{ epoch: number }[]>`
    SELECT extract(epoch FROM date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                   - interval '30 minutes')::float8 AS epoch`;
  if (r === undefined) throw new Error('нет отметки времени');
  const iso = new Date(r.epoch * 1000).toISOString();
  return { iso, day: iso.slice(0, 10) };
}

describe('ops.ts perf: разбор флагов', () => {
  test('умолчание 7 дней; --since Nd; --metric; мусор — ошибка', () => {
    expect(parsePerfArgs([])).toEqual({ sinceDays: 7, metric: null });
    expect(parsePerfArgs(['--since', '30d', '--metric', 'inp'])).toEqual({
      sinceDays: 30,
      metric: 'inp',
    });
    expect(parsePerfArgs(['--since', '30'])).toHaveProperty('error');
    expect(parsePerfArgs(['--since', '400d'])).toHaveProperty('error');
    expect(parsePerfArgs(['--wat'])).toHaveProperty('error');
  });

  test('--metric сверяется со списком метрик: неизвестная — ошибка разбора', () => {
    expect(parsePerfArgs(['--metric', 'wat'])).toHaveProperty('error');
    expect(parsePerfArgs(['--metric'])).toHaveProperty('error');
    expect(parsePerfArgs(['--metric', 'cold_start_content'])).toEqual({
      sinceDays: 7,
      metric: 'cold_start_content',
    });
  });
});

describe('ops.ts perf: перцентили замеров и чистка pg_cron', () => {
  const createCaller = createCallerFactory(appRouter);

  test('perf.report десять inp 10…100 → p50 55, p75 77.5; --metric отсекает прочие', async () => {
    const g = await freshGraph();
    const caller = createCaller({
      identity: personal(g),
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    const base = { device: 'desktop', appVersion: '0.6.0' } as const;
    await caller.perf.report({
      samples: [
        ...Array.from({ length: 10 }, (_, i) => ({
          ...base,
          metric: 'inp' as const,
          durMs: 10 * (i + 1),
        })),
        { ...base, metric: 'lcp', durMs: 1200, screen: 'record', cached: true },
      ],
    });
    const only = await admin.client.begin('read only', (tx) => perfPercentiles(tx, 7, 'inp'));
    expect(only).toContainEqual(
      expect.objectContaining({ metric: 'inp', appVersion: '0.6.0', n: 10, p50: 55, p75: 77.5 }),
    );
    expect(only.every((r) => r.metric === 'inp')).toBe(true);
    const all = await admin.client.begin('read only', (tx) => perfPercentiles(tx, 7, null));
    expect(all.map((r) => r.metric)).toContain('lcp');
  });

  test('база без таблицы замеров (прод до 0024): раздел — строка о миграции, отчёт не падает и печатает журнал (I-2)', async () => {
    // Прод-задача плана А снимает `ops.ts perf` ДО `migrate`: таблицы там ещё нет. Таблица прячется переименованием в
    // транзакции, которая откатывается, — как её отсутствие видит каталог (`to_regclass`).
    const ROLLBACK = new Error('откат: таблица замеров на месте');
    let section: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    let code = -1;
    await admin.client
      .begin(async (tx) => {
        await tx.unsafe('ALTER TABLE public.perf_samples RENAME TO perf_samples_hidden_t3');
        section = await perfSection(tx, 7, 'inp');
        const sql = {
          begin: (_mode: string, fn: (t: postgres.TransactionSql) => Promise<unknown>) =>
            tx.savepoint(fn),
        } as unknown as postgres.Sql;
        code = await runPerfReport(['--since', '7d'], {
          sql,
          log: (l) => out.push(l),
          error: (l) => err.push(l),
        });
        throw ROLLBACK;
      })
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(section).toEqual(['Замеры за 7 дн. (метрика inp)', NO_PERF_TABLE]);
    expect([code, err]).toEqual([0, []]);
    expect(out[0]).toStartWith('Объём журнала за 7 дн.');
    expect(out).toContain(NO_PERF_TABLE);
    expect(out.at(-1)).toStartWith(`задача pg_cron ${PERF_CLEANUP_JOB}: `);
  });

  test('cronCleanupStatus — строка о задаче чистки, а не «не найдена» и не «нет доступа»', async () => {
    const line = await admin.client.begin('read only', (tx) => cronCleanupStatus(tx));
    expect(line).toContain(PERF_CLEANUP_JOB);
    expect(line).not.toContain('не найдена');
    expect(line).not.toContain('нет доступа');
  });
});

describe('ops.ts perf: объём журнала', () => {
  test('записи, байты и «сеансы» по графу, дню и источнику действия — только чтение', async () => {
    const g = await freshGraph();
    const id = newId();
    const run = (input: unknown, tool = 'entity_update', source: 'ui' | 'quick_capture' = 'ui') =>
      execute(
        db,
        { identity: personal(g), actorKind: 'owner', source, operations: [{ tool, input }] },
        { sink },
      );
    const created = await run({ id, title: 'Замер', tags: [] }, 'entity_create');
    if (!created.ok) throw new Error(created.error.message);
    const at = (created.results[0] as { updatedAt: string }).updatedAt;
    const bodyOnly = await run({ id, body: 'только текст', expectedUpdatedAt: at });
    if (!bodyOnly.ok) throw new Error(bodyOnly.error.message);
    const at2 = (bodyOnly.results[0] as { updatedAt: string }).updatedAt;
    const mixed = await run({
      id,
      title: 'Замер 2',
      body: 'текст и заголовок',
      expectedUpdatedAt: at2,
    });
    if (!mixed.ok) throw new Error(mixed.error.message);
    const captured = await run(
      { id: newId(), title: 'Быстрая запись', tags: [] },
      'entity_create',
      'quick_capture',
    );
    if (!captured.ok) throw new Error(captured.error.message);

    const { source, rows } = await admin.client.begin('read only', (tx) => journalVolume(tx, 7));
    const mine = rows.filter((r) => r.graphId === g);
    // Разрез спеки §3.1 «источник действия»: ui и «＋» — разные строки одного графа и дня.
    expect(mine.map((r) => r.actionSource)).toEqual(['quick_capture', 'ui']);
    const ui = mine.find((r) => r.actionSource === 'ui');
    expect(ui?.records).toBe(3);
    expect(ui?.bytes).toBeGreaterThan(0);
    // до плана А «сеанс» — одиночная правка ТОЛЬКО тела из ui; после задачи 9 — колонка text_session
    // (правка без autosave сеансом не считается) — ожидание зависит от источника, не от задачи
    expect(ui?.sessions).toBe(source === 'chat_messages' ? 1 : 0);
    const quick = mine.find((r) => r.actionSource === 'quick_capture');
    expect([quick?.records, quick?.sessions]).toEqual([1, 0]);
  });

  test('источник — по каталогу: есть таблица action_journal — она, нет — сообщения чата', async () => {
    const [catalog] = await admin.client<{ has: boolean }[]>`
      SELECT to_regclass('public.action_journal') IS NOT NULL AS has`;
    const source = await admin.client.begin('read only', (tx) => journalSourceOf(tx));
    expect(source).toBe(catalog?.has ? 'action_journal' : 'chat_messages');
  });

  test('сообщения чата: сеанс — только ui, только entity_updated, в правке есть тело и больше ничего', async () => {
    // Формы полезной нагрузки — как их пишет боевой синк сегодня (payload правки — изменённые поля и id);
    // строки «без тела» и «создание с одним телом» боевой путь не пишет, но условие фильтра обязано их отсечь.
    const g = await freshGraph();
    const thread = newId();
    await admin.client`INSERT INTO chat_threads (id, graph_id) VALUES (${thread}, ${g})`;
    const id = newId();
    const action = (source: string, type: string, payload: Record<string, unknown>) => ({
      actions: [{ source, type, operations: [{ op: 'entity_update', payload }] }],
    });
    for (const m of [
      action('ui', 'entity_updated', { id, body: 'сеанс' }),
      action('mcp', 'entity_updated', { id, body: 'правка агента' }),
      action('ui', 'entity_created', { id, body: 'создание' }),
      action('ui', 'entity_updated', { id }),
      action('ui', 'entity_updated', { id, title: 'и заголовок', body: 'и тело' }),
    ]) {
      await admin.client`
        INSERT INTO chat_messages (id, thread_id, role, content, metadata)
        VALUES (${newId()}, ${thread}, 'system', 'фикстура', ${JSON.stringify(m)}::jsonb)`;
    }
    const rows = await admin.client.begin('read only', (tx) => chatJournalVolume(tx, 7));
    expect(
      rows.filter((r) => r.graphId === g).map((r) => [r.actionSource, r.records, r.sessions]),
    ).toEqual([
      ['mcp', 1, 0],
      ['ui', 4, 1],
    ]);
  });

  test('сообщения чата: день — UTC, а не пояс сеанса базы', async () => {
    const g = await freshGraph();
    const thread = newId();
    await admin.client`INSERT INTO chat_threads (id, graph_id) VALUES (${thread}, ${g})`;
    const at = await lateUtc(admin.client);
    await admin.client`
      INSERT INTO chat_messages (id, thread_id, role, content, metadata, created_at)
      VALUES (${newId()}, ${thread}, 'system', 'фикстура',
              ${JSON.stringify({ actions: [{ source: 'ui', type: 'entity_updated' }] })}::jsonb,
              ${at.iso}::timestamptz)`;
    const rows = await admin.client.begin('read only', async (tx) => {
      await tx.unsafe(`SET LOCAL TIME ZONE '${FAR_EAST}'`);
      return chatJournalVolume(tx, 7);
    });
    expect(rows.filter((r) => r.graphId === g).map((r) => r.day)).toEqual([at.day]);
  });

  test('таблица журнала: разрез по источнику, сеанс — text_session, байты — строка и её боковые строки, день — UTC', async () => {
    const g = await freshGraph();
    const ROLLBACK = new Error('откат фикстуры таблицы журнала');
    const withSide = newId();
    let seen:
      | { source: string; rows: JournalVolumeRow[]; uiRowBytes: number; sideBytes: number }
      | undefined;
    let utcDay = '';
    await admin.client
      .begin(async (tx) => {
        const [catalog] = await tx<{ has: boolean }[]>`
          SELECT to_regclass('public.action_journal') IS NOT NULL AS has`;
        if (!catalog?.has) await tx.unsafe(SYNTHETIC_JOURNAL_DDL);
        await tx.unsafe(`SET LOCAL TIME ZONE '${FAR_EAST}'`);
        const at = await lateUtc(tx);
        utcDay = at.day;
        const journal = (id: string, source: string, session: boolean) => tx`
          INSERT INTO public.action_journal (graph_id, id, created_at, type, actor_user_id, actor_kind, source,
                                             mechanism, title, card_tool, operations, inverse, text_session)
          VALUES (${g}, ${id}, ${at.iso}::timestamptz, 'entity_updated', ${g}, 'owner', ${source}, 'user', 'фикстура',
                  'entity_update', '[]'::jsonb, '[]'::jsonb, ${session})`;
        await journal(withSide, 'ui', true);
        await journal(newId(), 'ui', false);
        await journal(newId(), 'mcp', false);
        for (const entity of [newId(), newId()]) {
          await tx`
            INSERT INTO public.action_journal_entities (graph_id, action_id, entity_id, created_at)
            VALUES (${g}, ${withSide}, ${entity}, ${at.iso}::timestamptz)`;
        }
        const v = await journalVolume(tx, 7);
        const [ui] = await tx<{ b: number }[]>`
          SELECT sum(pg_column_size(j.*))::float8 AS b FROM public.action_journal j
           WHERE j.graph_id = ${g} AND j.source = 'ui'`;
        const [side] = await tx<{ b: number }[]>`
          SELECT sum(pg_column_size(x.*))::float8 AS b FROM public.action_journal_entities x
           WHERE x.graph_id = ${g}`;
        seen = {
          source: v.source,
          rows: v.rows.filter((r) => r.graphId === g),
          uiRowBytes: ui?.b ?? 0,
          sideBytes: side?.b ?? 0,
        };
        throw ROLLBACK;
      })
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(seen?.source).toBe('action_journal');
    expect(seen?.rows.map((r) => [r.day, r.actionSource, r.records, r.sessions])).toEqual([
      [utcDay, 'mcp', 1, 0],
      [utcDay, 'ui', 2, 1],
    ]);
    expect(seen?.sideBytes).toBeGreaterThan(0);
    const ui = seen?.rows.find((r) => r.actionSource === 'ui');
    expect(ui?.bytes).toBe((seen?.uiRowBytes ?? 0) + (seen?.sideBytes ?? 0));
  });
});

describe('ops.ts perf: печать и обвязка', () => {
  const ROWS: JournalVolumeRow[] = [
    { graphId: 'g1', day: '2026-09-29', actionSource: 'mcp', records: 1, bytes: 200, sessions: 0 },
    { graphId: 'g1', day: '2026-09-29', actionSource: 'ui', records: 4, bytes: 1000, sessions: 1 },
    { graphId: 'g2', day: '2026-09-30', actionSource: 'ui', records: 2, bytes: 300, sessions: 2 },
  ];

  test('шапка с источником и поясом, что меряют байты и сеансы, строки с источником действия, итоги', () => {
    const lines = formatJournalVolume({ source: 'chat_messages', rows: ROWS }, 30);
    expect(lines[0]).toBe('Объём журнала за 30 дн. (источник: chat_messages; день — UTC)');
    expect(lines[1]).toBe(
      'Байты — pg_column_size(metadata) системного сообщения чата: только jsonb действия, без прочих колонок строки.',
    );
    expect(lines[2]).toBe(
      'Сеанс — одиночная правка ТОЛЬКО тела из интерфейса (source ui, entity_updated, в правке id и тело).',
    );
    expect(lines[3]).toStartWith(
      'Сравнимость chat_messages (база) и action_journal (после А): записи — да;',
    );
    expect(lines.some((l) => /^g1\s+2026-09-29\s+ui\s+4\s+1000\s+1 \(25%\)$/.test(l))).toBe(true);
    expect(lines.at(-2)).toBe(
      'По источникам действия: mcp — записей 1, сеансов 0 (0%); ui — записей 6, сеансов 3 (50%)',
    );
    expect(lines.at(-1)).toBe('Итого: записей 7, байт 1500, сеансов 3 (43%)');
    const table = formatJournalVolume({ source: 'action_journal', rows: [] }, 7);
    expect(table[1]).toBe(
      'Байты — pg_column_size строки action_journal целиком + её строк action_journal_entities.',
    );
    expect(table.at(-1)).toBe('Итого: записей 0, байт 0, сеансов 0 (—)');
  });

  test('runPerfReport: плохой флаг — код 2 и ни одной строки отчёта; иначе код 0, печать в транзакции READ ONLY', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const modes: string[] = [];
    const sql = {
      begin: (mode: string, fn: (tx: postgres.TransactionSql) => Promise<unknown>) => {
        modes.push(mode);
        return admin.client.begin(mode, fn);
      },
    } as unknown as postgres.Sql;
    const io = { sql, log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
    expect(await runPerfReport(['--wat'], io)).toBe(2);
    expect([err, out, modes]).toEqual([['ops perf: неизвестный флаг «--wat»'], [], []]);
    expect(await runPerfReport(['--since', '30d'], io)).toBe(0);
    expect(modes).toEqual(['read only']);
    expect(out[0]).toMatch(
      /^Объём журнала за 30 дн\. \(источник: (chat_messages|action_journal); день — UTC\)$/,
    );
    // Раздел журнала кончается итогом, за ним — замеры; последней строкой — чистка pg_cron.
    const perfAt = out.indexOf('Замеры за 30 дн.');
    expect(out[perfAt - 1]).toStartWith('Итого: ');
    expect(out.at(-1)).toStartWith(`задача pg_cron ${PERF_CLEANUP_JOB}: `);
    expect(await runPerfReport(['--metric', 'wat'], io)).toBe(2);
    expect(err.at(-1)).toStartWith('ops perf: ');
  });
});

describe('ops.ts perf: печать перцентилей', () => {
  const ROW: PerfStatRow = {
    metric: 'request',
    appVersion: '0.6.0',
    cached: null,
    screen: null,
    kind: null,
    procedure: 'entity.get,entity.query',
    n: 3,
    p50: 120,
    p75: 150.25,
    p95: 300,
    serverP75: 40,
    dbP75: 25,
  };

  test('шапка с окном и метрикой, строка на группу, пусто — «замеров нет»', () => {
    const lines = formatPerfPercentiles(
      [
        ROW,
        {
          ...ROW,
          metric: 'transition',
          screen: 'record',
          procedure: null,
          cached: true,
          serverP75: null,
          dbP75: null,
        },
      ],
      7,
      null,
    );
    expect(lines[0]).toBe('Замеры за 7 дн.');
    expect(
      lines.some((l) =>
        /request\s+0\.6\.0\s+—\s+—\s+entity\.get,entity\.query\s+—\s+3\s+120\/150\.3\/300 мс\s+\[сервер p75 40, база p75 25\]$/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(
      lines.some((l) =>
        /transition\s+0\.6\.0\s+record\s+—\s+—\s+кеш\s+3\s+120\/150\.3\/300 мс$/.test(l),
      ),
    ).toBe(true);
    expect(formatPerfPercentiles([], 30, 'inp')).toEqual([
      'Замеры за 30 дн. (метрика inp)',
      'замеров нет',
    ]);
  });
});

/**
 * До задачи 5 (миграция 0025) таблиц журнала нет: ветку отчёта держит их копия по DDL плана — колонки, которые
 * читает отчёт, и те, что NOT NULL без умолчания, — в транзакции, которая откатывается. С 0025 тест идёт по
 * настоящим таблицам (та же вставка им подходит), а эта копия не создаётся.
 */
const SYNTHETIC_JOURNAL_DDL = `
  CREATE TABLE public.action_journal (
    graph_id uuid NOT NULL, id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(),
    type text NOT NULL, actor_user_id uuid NOT NULL, actor_kind text NOT NULL, source text NOT NULL,
    mechanism text NOT NULL, title text NOT NULL, card_tool text NOT NULL, operations jsonb NOT NULL,
    inverse jsonb NOT NULL, text_session boolean NOT NULL DEFAULT false, PRIMARY KEY (graph_id, id));
  CREATE TABLE public.action_journal_entities (
    graph_id uuid NOT NULL, action_id uuid NOT NULL, entity_id uuid NOT NULL,
    created_at timestamptz(3) NOT NULL, PRIMARY KEY (graph_id, action_id, entity_id));`;
