// apps/server/src/db/migrate-1v.test.ts
// Прод-операция среза 1в `migrate-1v` (спека §6.5, §6.6, §3.4, §3.7, §10, §18; РП-14, В-4, В-6, С1в-12) на
// фикстуре графа формы прода после 1б (`test/world-1b.ts`): `--report` считается без загрузки реестра ДО
// миграции `0023` (со встроенной строкой `orbis/agenda` прежней формы) и ничего не пишет; `--apply` — одна
// пачка исполнителя с источником `system` (Повестка, навигация хоста, «Год» по статусу, Upcoming в архив,
// если не правлена); `--drop-agenda-rows`; `--rehearsal` — только локальная база.
//
// Строки подписок прежней формы — ТОЛЬКО в откатываемой транзакции админ-соединения, DELETE-первым: строка
// с движком `agenda`, пережившая тест, уронила бы загрузку реестра всем следующим сьютам общей базы.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  APP_NAV,
  type GraphId,
  newId,
  SUPPLY_ASPECT,
  SUPPLY_DECLINED,
  SUPPLY_HASH,
  SUPPLY_KEY,
  SUPPLY_TEXT,
} from '@orbis/shared';
import type { TokenBoundaryForm } from '@orbis/shared/query';
import {
  AGENDA_BODY,
  etalonOf,
  HORIZON_YEAR_BODY,
  LEGACY_ETALON_TEXTS,
  type SupplyEtalon,
} from '@orbis/shared/supply';
import { supplyStatusOf } from '@orbis/shared/supply/print';
import { and, eq, sql } from 'drizzle-orm';
import type { Sql, TransactionSql } from 'postgres';
import { adminDb, appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { actionsOf, wholeJournalOf } from '../../test/journal-helpers';
import {
  ETALON_HASHES_1B,
  ETALONS_1B,
  NAV_1B_KEYS,
  OWNER_LINE,
  seedWorld1b,
} from '../../test/world-1b';
import { excludeInfraSystemRows } from '../chat/messages';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { JournalEntry } from '../executor/journal-read';
import type { Identity } from '../identity';
import { effectiveRegistry } from '../registry/cache';
import { seedOwner } from '../seed/onboarding';
import { etalonHash } from '../supply/hash';
import { listUpdates } from '../supply/mechanism';
import { canonicalPageText, supplyRecordId, supplyTextOf } from '../supply/records';
import type { Db } from './client';
import {
  AGENDA_OWNER_ROWS,
  AGENDA_ROW_PRESENT,
  agendaRowPresent,
  applyMigrate1v,
  assertAgendaRowGone,
  bodyFindings,
  dropAgendaRows,
  formatMigrate1vReport,
  MIGRATE_1V_LABEL,
  type Migrate1vIo,
  migrate1vGate,
  migrate1vIo,
  rehearsalDsnRefusal,
  reportMigrate1v,
  runMigrate1v,
  textQueryFindings,
} from './migrate-1v';
import { DEFINITION_TABLES } from './reset-world';
import { chatMessages, chatThreads } from './schema';
import { withIdentity } from './with-identity';

requireEnv();

const { db, client } = appDb();
const journal = makeChatJournalSink();

beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

/** Прежняя встроенная декларация Повестки — литералом (как в тесте миграции 0023): строка базы ДО `0023`. */
const AGENDA_DEF_1B = {
  engine: 'agenda',
  params: ['window_from', 'window_to'],
  show: {
    contract: 'orbis/when',
    slot: 'moment',
    window: { from: { ctx: '$today' }, to: { param: 'window_to' } },
    prefer: [],
    sortBy: 'asc',
    limit: 200,
  },
  overdue: {
    contract: 'orbis/when',
    slots: ['deadline', 'moment'],
    before: { ctx: '$today' },
    where: { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: 'open' }] },
    prefer: [],
    limit: 200,
  },
  hide: { contract: 'orbis/recurrence', set: 'templates' },
};

/** Навигация хоста 1в по ключам (§6.2). */
const NAV_1V = ['records', 'daily-planning', 'agenda', 'all-tasks', 'horizon-year', 'routines'];

class Rollback extends Error {}

/** Админ-клиент на время одного вызова: сверка мимо RLS, независимая от проверяемого кода. */
async function admin<T>(fn: (a: { db: Db; sql: Sql }) => Promise<T>): Promise<T> {
  const { db: a, client: c } = adminDb();
  try {
    return await fn({ db: a, sql: c });
  } finally {
    await c.end();
  }
}

/** Откатываемая транзакция админ-соединения: всё, что внутри, в базе не остаётся. */
async function inRollback(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
  await admin(async ({ sql: s }) => {
    await s
      .begin(async (tx) => {
        await fn(tx);
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
  });
}

/** Встроенная строка прежней формы и (по желанию) строка владельца с движком `agenda` — DELETE-первым. */
async function oldAgendaRows(tx: TransactionSql, owner?: { graph: GraphId; id: string }) {
  await tx`DELETE FROM subscription_definitions WHERE id = 'orbis/agenda' AND graph_id IS NULL`;
  await tx`INSERT INTO subscription_definitions (id, graph_id, surface, definition, module, rank)
    VALUES ('orbis/agenda', NULL, 'core/agenda', ${JSON.stringify(AGENDA_DEF_1B)}::jsonb, NULL, 900)`;
  if (owner !== undefined) {
    await tx`INSERT INTO subscription_definitions (id, graph_id, surface, definition, module, rank)
      VALUES (${owner.id}, ${owner.graph}::uuid, 'core/agenda', ${JSON.stringify(AGENDA_DEF_1B)}::jsonb, NULL, 901)`;
  }
}

/**
 * ВСЁ, что операция могла бы записать в граф, одним снимком (образец — прежний `migrate-1b.test.ts`): по
 * каждой таблице графа — число строк и отпечаток содержимого.
 */
async function worldSnapshot(graph: GraphId): Promise<Record<string, unknown>> {
  return admin(async ({ db: a }) => {
    const digest = async (table: string, where: ReturnType<typeof sql>): Promise<unknown> =>
      (
        (await a.execute(sql`
        SELECT count(*)::int AS n,
               md5(coalesce(string_agg(to_jsonb(x)::text, ';' ORDER BY to_jsonb(x)::text), '')) AS digest
          FROM ${sql.raw(table)} x WHERE ${where}`)) as unknown as unknown[]
      )[0];
    const ofGraph = sql`x.graph_id = ${graph}::uuid`;
    const out: Record<string, unknown> = {
      entities: await digest('entities', ofGraph),
      relations: await digest(
        'relations',
        sql`x.source_id IN (SELECT id FROM entities WHERE graph_id = ${graph}::uuid)`,
      ),
      threads: await digest('chat_threads', ofGraph),
      messages: await digest(
        'chat_messages',
        sql`x.thread_id IN (SELECT id FROM chat_threads WHERE graph_id = ${graph}::uuid)`,
      ),
      versions: await digest('entity_versions', ofGraph),
      settings: await digest('user_settings', ofGraph),
      deltas: await digest('registry_deltas', ofGraph),
    };
    for (const table of DEFINITION_TABLES) out[table] = await digest(table, ofGraph);
    return out;
  });
}

interface Row {
  id: string;
  title: string;
  emoji: string | null;
  body: string;
  aspects: string[];
  props: Record<string, unknown>;
  archived: boolean;
  updatedAt: string;
}

async function rowOf(graph: GraphId, id: string): Promise<Row> {
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.execute(
      sql`SELECT id::text AS id, title, emoji, body, aspects, props, archived, updated_at FROM entities WHERE id = ${id}::uuid`,
    ),
  );
  const r = rows[0] as (Omit<Row, 'updatedAt'> & { updated_at: Date | string }) | undefined;
  if (r === undefined) throw new Error(`запись ${id} не найдена`);
  return { ...r, updatedAt: new Date(r.updated_at).toISOString() };
}

const rowByKey = (graph: GraphId, key: string) =>
  rowOf(graph, supplyRecordId(graph, key as Parameters<typeof supplyRecordId>[1]));

async function navKeysOf(graph: GraphId): Promise<string[]> {
  const shell = await rowByKey(graph, 'host-shell');
  const byId = new Map(
    [...NAV_1V, 'upcoming'].map((k) => [
      supplyRecordId(graph, k as Parameters<typeof supplyRecordId>[1]),
      k,
    ]),
  );
  return ((shell.props[APP_NAV] as string[] | undefined) ?? []).map((id) => byId.get(id) ?? id);
}

async function canonical(graph: GraphId, text: string): Promise<string> {
  const reg = await withIdentity(db, personal(graph), (tx) => effectiveRegistry(tx, graph));
  return canonicalPageText(text, reg);
}

/** Печать эталона в графе — резолвером живых записей (как «Обновления»). */
async function etalonTextIn(graph: GraphId, e: SupplyEtalon): Promise<string> {
  const reg = await withIdentity(db, personal(graph), (tx) => effectiveRegistry(tx, graph));
  const live = new Map<string, string>();
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.execute(sql`SELECT id::text AS id, props ->> ${SUPPLY_KEY} AS key FROM entities
      WHERE graph_id = ${graph}::uuid AND props ? ${SUPPLY_KEY} AND NOT archived`),
  );
  for (const r of rows) live.set(String(r.key), String(r.id));
  return supplyTextOf(e, reg, (k) => live.get(k) ?? null);
}

/**
 * Журнал графа (API журнала, помощник `wholeJournalOf`), все сообщения графа и видимые лентой (тот же фильтр, что
 * `chat.listMessages`): запись перевода обязана лечь в журнал, прибавить в разговорах графа ровно одну строку (её
 * носитель — прежнее хранилище) и НЕ появиться в ленте.
 */
async function journalOf(
  graph: GraphId,
): Promise<{ all: JournalEntry[]; messages: string[]; visible: string[] }> {
  const all = await wholeJournalOf(graph);
  const { messages, visible } = await withIdentity(db, personal(graph), async (tx) => {
    const threads = tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.graphId, graph));
    const everything = await tx
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(sql`${chatMessages.threadId} IN ${threads}`);
    const shown = await tx
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(and(sql`${chatMessages.threadId} IN ${threads}`, ...excludeInfraSystemRows()));
    return { messages: everything.map((r) => r.id).sort(), visible: shown.map((r) => r.id).sort() };
  });
  return { all, messages, visible };
}

async function updatedAtAll(graph: GraphId): Promise<Map<string, string>> {
  const rows = await admin(({ db: a }) =>
    a.execute(
      sql`SELECT id::text AS id, updated_at::text AS at FROM entities WHERE graph_id = ${graph}::uuid`,
    ),
  );
  return new Map(rows.map((r) => [String(r.id), String(r.at)]));
}

async function settingsOf(graph: GraphId): Promise<unknown> {
  const rows = await admin(({ db: a }) =>
    a.execute(sql`SELECT to_jsonb(s) AS s FROM user_settings s WHERE graph_id = ${graph}::uuid`),
  );
  return rows[0]?.s;
}

/** Правка владельца обычным путём (механизм `user`) — с журналом. */
async function ownerEdit(graph: GraphId, input: Record<string, unknown>): Promise<void> {
  const r = await execute(
    db,
    {
      identity: personal(graph),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input }],
    },
    { sink: journal },
  );
  if (!r.ok) throw new Error(`правка владельца: ${JSON.stringify(r.error)}`);
}

async function ownerCreate(graph: GraphId, input: Record<string, unknown>): Promise<string> {
  const id = newId();
  const r = await execute(
    db,
    {
      identity: personal(graph),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_create', input: { id, tags: [], ...input } }],
    },
    { sink: journal },
  );
  if (!r.ok) throw new Error(`создание: ${JSON.stringify(r.error)}`);
  return id;
}

async function reportOf(graph: GraphId) {
  return admin(({ sql: s }) => s.begin('read only', (tx) => reportMigrate1v(tx, graph)));
}

async function applied(graph: GraphId): Promise<{ actionId: string }> {
  const out = await applyMigrate1v(db, personal(graph));
  if (!('actionId' in out)) throw new Error(`ожидался перевод, а получено ${JSON.stringify(out)}`);
  return out;
}

async function execErrorOf(p: Promise<unknown>): Promise<ExecError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExecError) return e;
    throw e;
  }
  throw new Error('ожидался отказ ExecError, вызов успешен');
}

/**
 * IO операции для теста — по образцу боевого `migrate1vIo` (его зовёт `ops.ts`; сам он — под тестом «боевой
 * IO» ниже): пул и drizzle на ОДНОМ админском соединении (перевод идёт под идентичностью владельца через
 * `withIdentity`, удаление — админом); графы — заданные, а не все графы базы.
 */
function testIo(
  whos: Identity[],
  over: Partial<Migrate1vIo> = {},
): { io: Migrate1vIo; out: string[]; err: string[]; opened: string[]; dsnRead: number[] } {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const dsnRead: number[] = [];
  const io: Migrate1vIo = {
    readDsn: () => {
      dsnRead.push(1);
      return 'postgres://prod-из-ключницы';
    },
    rehearsalDsn: () => undefined,
    open: (dsn) => {
      opened.push(dsn);
      const { db: a, client: c } = adminDb();
      return { sql: c, db: a, close: () => c.end() };
    },
    identities: async () => whos,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    ...over,
  };
  return { io, out, err, opened, dsnRead };
}

// ─────────────────────────────── (а) отчёт до миграции ───────────────────────────────

describe('(а) --report до миграции 0023: реестр не грузится, ничего не пишется', () => {
  test('строка orbis/agenda прежней формы и подписка владельца: отчёт собран, план — полный перевод', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    const before = await worldSnapshot(graph);
    let report: Awaited<ReturnType<typeof reportMigrate1v>> | undefined;
    await inRollback(async (tx) => {
      await oldAgendaRows(tx, { graph, id: 'user/my-agenda' });
      const count = async () =>
        JSON.stringify(
          await tx`SELECT (SELECT count(*)::int FROM entities WHERE graph_id = ${graph}::uuid) AS e,
                          (SELECT count(*)::int FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
                            WHERE t.graph_id = ${graph}::uuid) AS m`,
        );
      const c0 = await count();
      // «Только чтение» стережёт сервер: любая запись отчёта упала бы, а не записала.
      await tx`SET LOCAL transaction_read_only = on`;
      report = await reportMigrate1v(tx, graph);
      expect(await count()).toEqual(c0);
    });
    expect(report?.agendaOwnerSubscriptions).toEqual(['user/my-agenda']);
    expect(report?.agendaDeltas).toEqual([]);
    expect(report?.plan).toEqual({
      agenda: 'create',
      shellNav: 'replace',
      year: 'body+etalon',
      upcoming: 'archive',
    });
    expect(report?.upcomingRefs).toEqual([]);
    const lines = formatMigrate1vReport(report as NonNullable<typeof report>);
    expect(lines.some((l) => l.includes('СТОП'))).toBe(true);
    expect(await worldSnapshot(graph)).toEqual(before);
  });

  test('runMigrate1v --report: код 0, печать плана, граф не тронут', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    const before = await worldSnapshot(graph);
    const t = testIo([personal(graph)]);
    expect(await runMigrate1v(['--report'], t.io)).toBe(0);
    expect(t.err).toEqual([]);
    expect(t.out).toContain('    Повестка: создать «Повестка»');
    expect(t.out).toContain('    навигация хоста: Повестка на месте Upcoming');
    expect(t.out.at(-1)).toBe('\nРежим --report: ничего не записано.');
    expect(t.dsnRead).toEqual([1]);
    expect(await worldSnapshot(graph)).toEqual(before);
  });
});

// ─────────────────────────────── (б) перепись ───────────────────────────────

describe('(б) перепись: формы с токеном-границей, «последнее» с sortBy, литералы', () => {
  test('тело, источник прогресса, over действия, закреплённая версия, журнал отката', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'etalon-1b');
    const page = await ownerCreate(graph, {
      title: 'Неделя',
      body: 'Сроки\n\n{{query:orbis/due_date<next_7d, display=list}}',
    });
    const literalPage = await ownerCreate(graph, {
      title: 'Литералы',
      body: '{{query:orbis/task_status=this_month|$abc, title="orbis/x=this_week", display=list}}',
    });
    // Контроль: тело Повестки — `$period` объявлен, `=overdue` — не граница: ни формы, ни литерала.
    const agendaLike = await ownerCreate(graph, { title: 'Как Повестка', body: AGENDA_BODY });
    // Журнал отката: прежнее тело правки несёт `<next_7d`.
    const edited = await ownerCreate(graph, {
      title: 'Правленая',
      body: '{{query:orbis/due_date<next_7d, display=list}}',
    });
    await ownerEdit(graph, {
      id: edited,
      body: 'Теперь без запроса.',
      expectedUpdatedAt: (await rowOf(graph, edited)).updatedAt,
    });
    const goal = await ownerCreate(graph, { title: 'Цель' });
    const textGoal = await ownerCreate(graph, { title: 'Цель текстом' });
    const actionId = 'user/postpone-mine';
    const versionId = newId();
    await admin(async ({ db: a }) => {
      await a.execute(
        sql`UPDATE entities SET props = props || ${JSON.stringify({
          'orbis/progress_source': {
            query: {
              filter: {
                prop: 'orbis/due_date',
                op: 'range',
                value: { from: { token: 'overdue' } },
              },
              sortBy: [{ field: 'orbis/due_date', dir: 'desc' }],
            },
            aggregate: 'latest',
            field: 'orbis/effort_min',
          },
        })}::jsonb WHERE id = ${goal}::uuid`,
      );
      await a.execute(
        sql`UPDATE entities SET props = props || ${JSON.stringify({
          'orbis/progress_source': {
            query: { text: 'orbis/task_status=last_month, sortBy=orbis/updated_at:desc' },
            aggregate: 'latest',
            field: 'orbis/effort_min',
          },
        })}::jsonb WHERE id = ${textGoal}::uuid`,
      );
      await a.execute(sql`INSERT INTO action_definitions
        (id, graph_id, key, label, description, offered_by, over, rank, status)
        VALUES (${actionId}, ${graph}::uuid, ${actionId}, '{"ru":"Перенести"}'::jsonb, '{"ru":"x"}'::jsonb,
          ${JSON.stringify([{ surface: 'core/agenda' }])}::jsonb,
          ${JSON.stringify({ filter: { prop: 'orbis/due_date', op: 'range', value: { from: { token: 'overdue' } } } })}::jsonb,
          0, 'deprecated')`);
      await a.execute(sql`INSERT INTO entity_versions (id, graph_id, entity_id, label, body, actor_user_id, actor_kind)
        VALUES (${versionId}::uuid, ${graph}::uuid, ${page}::uuid, 'старая', '{{query:orbis/due_date>after_7d}}',
          ${graph}::uuid, 'owner')`);
    });

    const r = await reportOf(graph);
    const lt7: TokenBoundaryForm[] = [{ token: 'next_7d', form: 'lt', verdict: 'changed' }];
    const fromOverdue: TokenBoundaryForm[] = [
      { token: 'overdue', form: 'gte', verdict: 'refused' },
    ];
    expect(r.tokenBoundaries).toContainEqual({ where: 'body_doc', id: page, forms: lt7 });
    expect(r.tokenBoundaries).toContainEqual({ where: 'body', id: page, forms: lt7 });
    expect(r.tokenBoundaries).toContainEqual({
      where: 'progress_source',
      id: goal,
      forms: fromOverdue,
    });
    expect(r.tokenBoundaries).toContainEqual({
      where: 'action_over',
      id: actionId,
      forms: fromOverdue,
    });
    expect(r.tokenBoundaries).toContainEqual({
      where: 'entity_versions',
      id: versionId,
      store: 'body',
      forms: [{ token: 'after_7d', form: 'gt', verdict: 'refused' }],
    });
    const prior = r.tokenBoundaries.filter((t) => t.where === 'journal_prior');
    expect(prior).toHaveLength(1);
    expect(prior[0]?.forms).toEqual(lt7);
    // Ничего сверх: эталоны 1б и тело «как Повестка» границ не несут.
    expect(new Set(r.tokenBoundaries.map((t) => t.id))).toEqual(
      new Set([page, goal, actionId, versionId, prior[0]?.id as string]),
    );
    expect(r.tokenBoundaries.some((t) => t.id === agendaLike)).toBe(false);
    expect(r.goalsLatestSorted.sort()).toEqual([goal, textGoal].sort());
    expect(r.reservedLiterals).toEqual(
      expect.arrayContaining([
        {
          where: 'body',
          id: literalPage,
          literals: ['orbis/task_status=this_month', 'orbis/task_status=$abc'],
        },
        { where: 'progress_source', id: textGoal, literals: ['orbis/task_status=last_month'] },
      ]),
    );
    expect(r.reservedLiterals).toHaveLength(2);
    expect(r.coreAgendaActions).toEqual([actionId]);
  });

  test('текст запроса: формы по маске кавычек, `a..b`, отрицание, подпись; литералы — только у адреса', () => {
    expect(textQueryFindings('orbis/due_date<next_7d').forms).toEqual([
      { token: 'next_7d', form: 'lt', verdict: 'changed' },
    ]);
    expect(textQueryFindings('!orbis/due_date>after_7d, "Срок">=overdue').forms).toEqual([
      { token: 'after_7d', form: 'gt', verdict: 'refused' },
      { token: 'overdue', form: 'gte', verdict: 'refused' },
    ]);
    expect(textQueryFindings('orbis/due_date=overdue..next_7d').forms).toEqual([
      { token: 'overdue', form: 'gte', verdict: 'refused' },
      { token: 'next_7d', form: 'lte', verdict: 'same' },
    ]);
    // В кавычках — значение, не форма; `=T` — не граница.
    expect(
      textQueryFindings('title="orbis/due_date<next_7d", orbis/due_date=next_7d').forms,
    ).toEqual([]);
    expect(textQueryFindings('orbis/x=this_month|"next_14d", orbis/y!=$a1&b').literals).toEqual([
      'orbis/x=this_month',
      'orbis/y!=$a1',
    ]);
    // М-2 ревью B2a: под отрицанием значения (`=!a`, `!a&!b`) — тот же литерал; печать — как написано.
    expect(
      textQueryFindings('orbis/x=!this_month, orbis/y=!this_month&!last_month, orbis/z=!$period')
        .literals,
    ).toEqual([
      'orbis/x=!this_month',
      'orbis/y=!this_month',
      'orbis/y=!last_month',
      'orbis/z=!$period',
    ]);
    expect(textQueryFindings('orbis/x=!"this_month"').literals).toEqual([]);
    expect(textQueryFindings('orbis/when=!$period', new Set(['period'])).literals).toEqual([]);
    // Слова грамматики значения-токена не несут; закавыченный `$` — литерал, законный всегда.
    expect(textQueryFindings('title=this_month, orbis/x="$abc"').literals).toEqual([]);
    expect(textQueryFindings('orbis/when=$period', new Set(['period'])).literals).toEqual([]);
    expect(bodyFindings(AGENDA_BODY)).toEqual({ forms: [], literals: [] });
    expect(
      bodyFindings(
        '{{columns}}\n{{column}}\n{{query:orbis/due_date<next_7d}}\n{{/column}}\n{{column}}\nx\n{{/column}}\n{{/columns}}',
      ).forms,
    ).toHaveLength(1);
  });
});

// ─────────────────────────────── (в)–(е) перевод ───────────────────────────────

describe('(в) --apply на графе формы прода: одна пачка system', () => {
  test('Повестка, навигация, «Год», Upcoming в архиве; журнал — одна скрытая запись; прочее не тронуто; Undo', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    const atBefore = await updatedAtAll(graph);
    const settingsBefore = await settingsOf(graph);
    const journalBefore = await journalOf(graph);
    const content = (r: Row) => ({
      title: r.title,
      emoji: r.emoji,
      body: r.body,
      aspects: r.aspects,
      props: r.props,
      archived: r.archived,
    });
    const keys1b = ['host-shell', 'horizon-year', 'upcoming'] as const;
    const rows1b = await Promise.all(keys1b.map(async (k) => content(await rowByKey(graph, k))));
    const updatesOf = async () =>
      (await listUpdates({ db, identity: personal(graph) }))
        .map(({ key, kind, edited, declined }) => ({ key, kind, edited, declined }))
        .sort((a, b) => a.key.localeCompare(b.key));
    const updates1b = await updatesOf();

    const { actionId } = await applied(graph);

    const agenda = await rowByKey(graph, 'agenda');
    expect(agenda.title).toBe('Повестка');
    expect(agenda.archived).toBe(false);
    expect(agenda.props[SUPPLY_KEY]).toBe('agenda');
    expect(agenda.body).toBe(await canonical(graph, AGENDA_BODY));
    expect(agenda.props[SUPPLY_HASH]).toBe(etalonHash(etalonOf('agenda')));
    expect(supplyStatusOf(agenda)).toBe('etalon');

    expect(await navKeysOf(graph)).toEqual(NAV_1V);
    const shell = await rowByKey(graph, 'host-shell');
    expect(shell.props[SUPPLY_HASH]).toBe(etalonHash(etalonOf('host-shell')));
    expect(shell.props[SUPPLY_TEXT]).toBe(await etalonTextIn(graph, etalonOf('host-shell')));
    expect(supplyStatusOf(shell)).toBe('etalon');

    const year = await rowByKey(graph, 'horizon-year');
    expect(year.body).toBe(await canonical(graph, HORIZON_YEAR_BODY));
    expect(year.props[SUPPLY_HASH]).toBe(etalonHash(etalonOf('horizon-year')));
    expect(supplyStatusOf(year)).toBe('etalon');

    expect((await rowByKey(graph, 'upcoming')).archived).toBe(true);

    // Журнал: ровно одна новая запись — наша пачка, источник system, подпись В-4; лента её не видит.
    const after = await journalOf(graph);
    const added = after.all.filter((e) => !journalBefore.all.some((b) => b.id === e.id));
    expect(added).toHaveLength(1);
    // Ровно одна новая строка во всём графе — прежняя проверка: ничего сверх записи журнала не написано
    expect(after.messages.filter((id) => !journalBefore.messages.includes(id))).toHaveLength(1);
    expect(after.visible).toEqual(journalBefore.visible);
    expect(added[0]?.id).toBe(actionId);
    expect(added[0]?.source).toBe('system');
    expect(added[0]?.title).toBe(MIGRATE_1V_LABEL);

    // Прочие записи и настройки не тронуты.
    const touched = new Set(
      ['host-shell', 'horizon-year', 'upcoming'].map((k) =>
        supplyRecordId(graph, k as Parameters<typeof supplyRecordId>[1]),
      ),
    );
    const atAfter = await updatedAtAll(graph);
    for (const [id, at] of atBefore)
      if (!touched.has(id)) expect([id, atAfter.get(id)]).toEqual([id, at]);
    expect(atAfter.size).toBe(atBefore.size + 1);
    expect(await settingsOf(graph)).toEqual(settingsBefore);

    // «Обновления» не предлагают ни оболочку, ни Повестку, ни «Год» (ре-ревью задачи 9: печать оболочки —
    // резолвером, видящим Повестку той же пачки).
    const updates = await listUpdates({ db, identity: personal(graph) });
    expect(updates.filter((u) => ['host-shell', 'agenda', 'horizon-year'].includes(u.key))).toEqual(
      [],
    );

    // Undo достижим владельцу — режимом операции (Fable I-1): оболочка, «Год», Upcoming — к форме 1б ЦЕЛИКОМ
    // (содержимое, отпечатки и печати эталонов, заголовок и эмодзи), Повестка — в архив, «Обновления» — как
    // до перевода (Fable Minor-3); повтор `--apply` — «уже переведён».
    const t = testIo([personal(graph)]);
    expect(await runMigrate1v(['--undo', actionId, '--i-understand'], t.io)).toBe(0);
    expect([t.out, t.err]).toEqual([[`граф ${graph}: пачка ${actionId} отменена`], []]);
    expect(await Promise.all(keys1b.map(async (k) => content(await rowByKey(graph, k))))).toEqual(
      rows1b,
    );
    expect(await navKeysOf(graph)).toEqual([...NAV_1B_KEYS]);
    expect((await rowByKey(graph, 'horizon-year')).body).toBe(
      await canonical(graph, LEGACY_ETALON_TEXTS['horizon-year'] as string),
    );
    expect((await rowByKey(graph, 'agenda')).archived).toBe(true);
    expect(await updatesOf()).toEqual(updates1b);
    expect(updates1b).toContainEqual({
      key: 'agenda',
      kind: 'new',
      edited: false,
      declined: false,
    });
    expect(await applyMigrate1v(db, personal(graph))).toEqual({ already: true });
    // Повторная отмена — отказ исполнителя «уже отменено», код 1.
    const again = testIo([personal(graph)]);
    expect(await runMigrate1v(['--undo', actionId, '--i-understand'], again.io)).toBe(1);
    expect(again.err[0]).toContain('уже отменено');
  });

  test('--undo отменяет только пачку операции: чужое действие — отказ, неизвестное — «нечего», без подтверждения — 2', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    const page = await ownerCreate(graph, { title: 'Своя' });
    const own = (await actionsOf(graph)).find((e) =>
      e.operations.some((op) => op.payload.id === page),
    );
    const ownId = String(own?.id);
    const before = await worldSnapshot(graph);
    const foreign = testIo([personal(graph)]);
    expect(await runMigrate1v(['--undo', ownId, '--i-understand'], foreign.io)).toBe(1);
    expect(foreign.err[0]).toContain('не пачка migrate-1v');
    const missing = testIo([personal(graph)]);
    expect(await runMigrate1v(['--undo', newId(), '--i-understand'], missing.io)).toBe(1);
    expect(missing.err[0]).toContain('нет в журнале ни одного графа');
    const bare = testIo([]);
    expect(await runMigrate1v(['--undo', ownId], bare.io)).toBe(2);
    expect(migrate1vGate(['--undo', '--i-understand']).proceed).toBe(false);
    expect(await worldSnapshot(graph)).toEqual(before);
  });

  test('«Год» на эталоне 1б (граф 1б без прежних эталонов) — тоже тело и эталон', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'etalon-1b');
    expect((await reportOf(graph)).plan.year).toBe('body+etalon');
    await applied(graph);
    const year = await rowByKey(graph, 'horizon-year');
    expect(year.body).toBe(await canonical(graph, HORIZON_YEAR_BODY));
    expect(supplyStatusOf(year)).toBe('etalon');
  });
});

describe('(г)–(д) правленые и отклонённые', () => {
  test('(г) Upcoming правлена — не в архиве, из навигации ушла; «Год» правлен — тело прежнее, эталон новый (В-6)', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'edited');
    expect((await reportOf(graph)).plan).toEqual({
      agenda: 'create',
      shellNav: 'replace',
      year: 'etalon-only',
      upcoming: 'keep',
    });
    const yearBefore = await rowByKey(graph, 'horizon-year');
    await applied(graph);
    const upcoming = await rowByKey(graph, 'upcoming');
    expect(upcoming.archived).toBe(false);
    expect(upcoming.body).toContain(OWNER_LINE);
    expect(await navKeysOf(graph)).toEqual(NAV_1V);
    const year = await rowByKey(graph, 'horizon-year');
    expect(year.body).toBe(yearBefore.body);
    expect(year.body).toContain(OWNER_LINE);
    expect(year.props[SUPPLY_HASH]).toBe(etalonHash(etalonOf('horizon-year')));
    expect(year.props[SUPPLY_TEXT]).toBe(await etalonTextIn(graph, etalonOf('horizon-year')));
    expect(supplyStatusOf(year)).toBe('edited');
  });

  test('(д) «Год» с отказом эпохи 1б — только эталон, тело не трогается', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'declined');
    const yearBefore = await rowByKey(graph, 'horizon-year');
    // Тело «Года» — прежний эталон, не правлено: без правила отказа оно получило бы тело 1в.
    expect(supplyStatusOf(yearBefore)).toBe('etalon');
    expect((await reportOf(graph)).plan.year).toBe('etalon-only');
    await applied(graph);
    const year = await rowByKey(graph, 'horizon-year');
    expect(year.body).toBe(yearBefore.body);
    expect(year.props[SUPPLY_HASH]).toBe(etalonHash(etalonOf('horizon-year')));
    expect(year.props[SUPPLY_DECLINED]).toBe(yearBefore.props[SUPPLY_DECLINED]);
  });
});

describe('(е) навигация без Upcoming', () => {
  test('с Daily Planning — Повестка после неё; без обеих — в конец', async () => {
    for (const [drop, want, shellNav] of [
      [
        ['upcoming'],
        ['records', 'daily-planning', 'agenda', 'all-tasks', 'horizon-year', 'routines'],
        'insert-after-daily',
      ],
      [
        ['upcoming', 'daily-planning'],
        ['records', 'all-tasks', 'horizon-year', 'routines', 'agenda'],
        'append',
      ],
    ] as const) {
      const graph = await freshGraph();
      await seedWorld1b(db, graph, 'prod');
      const shell = await rowByKey(graph, 'host-shell');
      await ownerEdit(graph, {
        id: shell.id,
        props: {
          [APP_NAV]: NAV_1B_KEYS.filter((k) => !(drop as readonly string[]).includes(k)).map((k) =>
            supplyRecordId(graph, k),
          ),
        },
      });
      expect((await reportOf(graph)).plan.shellNav).toBe(shellNav);
      await applied(graph);
      expect(await navKeysOf(graph)).toEqual([...want]);
    }
    // Два графа формы прода подряд: ≈1,4 с в покое, но под нагрузкой параллельного прогона упирались в
    // умолчание 5 с (прогон мутации rm-2 фикс-круга 2).
  }, 20_000);
});

describe('(ж) приложения со ссылкой на Upcoming', () => {
  test('домашняя и раздел своих приложений — в upcomingRefs, Upcoming не архивируется; раздел хоста — не в счёт', async () => {
    const graph = await freshGraph();
    const { ownAppIds } = await seedWorld1b(db, graph, 'own-app');
    const r = await reportOf(graph);
    expect(r.upcomingRefs).toEqual([...ownAppIds].sort());
    expect(r.plan).toEqual({
      agenda: 'create',
      shellNav: 'replace',
      year: 'body+etalon',
      upcoming: 'keep-referenced',
    });
    expect(formatMigrate1vReport(r)).toContain(
      '    владельцу: Upcoming из-за них не архивируется — уберите ссылки сами, если она не нужна',
    );
    await applied(graph);
    expect((await rowByKey(graph, 'upcoming')).archived).toBe(false);
    expect(await navKeysOf(graph)).toEqual(NAV_1V);
    // Upcoming, оставшаяся ради ссылок, — снятый ключ: «Обновления» её не предлагают, и ни оболочку, ни
    // Повестку, ни «Год» после пачки тоже (ре-ревью rm-3).
    const updates = await listUpdates({ db, identity: personal(graph) });
    expect(
      updates.filter((u) => ['host-shell', 'agenda', 'horizon-year', 'upcoming'].includes(u.key)),
    ).toEqual([]);
  });

  test('оболочка хоста вне поставки держит Upcoming разделом — навигация не трогается, Upcoming не в архиве', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    const shell = await rowByKey(graph, 'host-shell');
    await ownerEdit(graph, { id: shell.id, aspects: { detach: [SUPPLY_ASPECT] } });
    const r = await reportOf(graph);
    expect(r.upcomingRefs).toEqual([shell.id]);
    expect([r.plan.shellNav, r.plan.upcoming]).toEqual(['keep', 'keep-referenced']);
    await applied(graph);
    expect((await rowByKey(graph, 'upcoming')).archived).toBe(false);
    expect(await navKeysOf(graph)).toEqual([...NAV_1B_KEYS]);
  });
});

// ─────────────────────────────── (з)–(м) ───────────────────────────────

describe('(з) повтор и (м) вход владельца после перевода', () => {
  test('повторный --apply — { already: true }, ноль записей; вход владельца — ноль записей', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    await applied(graph);
    const before = await worldSnapshot(graph);
    expect(await applyMigrate1v(db, personal(graph))).toEqual({ already: true });
    expect(await worldSnapshot(graph)).toEqual(before);
    expect(await seedOwner(db, personal(graph))).toEqual({ seeded: false });
    expect(await worldSnapshot(graph)).toEqual(before);
  });
});

describe('(и) подтверждение и предусловия --apply', () => {
  test('--apply без --i-understand — код 2, ни DSN, ни базы', async () => {
    const t = testIo([], {
      open: () => {
        throw new Error('база открыта до подтверждения');
      },
    });
    expect(await runMigrate1v(['--apply'], t.io)).toBe(2);
    expect(t.err[0]).toBe('migrate-1v: --apply пишет в базу — нужно подтверждение --i-understand.');
    expect(t.dsnRead).toEqual([]);
  });

  test('гейт: один режим, незнакомый флаг — отказ, --report без --i-understand, --rehearsal к любому', () => {
    expect(migrate1vGate(['--report'])).toEqual({
      proceed: true,
      mode: 'report',
      rehearsal: false,
    });
    expect(migrate1vGate(['--drop-agenda-rows', '--i-understand', '--rehearsal'])).toEqual({
      proceed: true,
      mode: 'drop',
      rehearsal: true,
    });
    for (const args of [
      [],
      ['--report', '--apply', '--i-understand'],
      ['--report', '--i-understand'],
      ['--drop-agenda-rows'],
      ['--apply', '--i-understand', '--yes'],
    ]) {
      expect(migrate1vGate(args).proceed).toBe(false);
    }
  });

  test('встроенная строка orbis/agenda — отказ «сначала migrate (0023)»; без неё — проходит', async () => {
    await admin(({ sql: s }) => assertAgendaRowGone(s));
    await inRollback(async (tx) => {
      await oldAgendaRows(tx);
      const e = await execErrorOf(assertAgendaRowGone(tx));
      expect(e.message).toBe(AGENDA_ROW_PRESENT);
      expect(AGENDA_ROW_PRESENT).toContain('сначала migrate (0023)');
    });
  });

  test('подписка владельца с движком agenda — отказ «сначала --drop-agenda-rows», граф не тронут', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    const before = await worldSnapshot(graph);
    await admin(async ({ db: a }) => {
      await a.execute(sql`INSERT INTO subscription_definitions (id, graph_id, surface, definition, module, rank)
        VALUES ('user/my-agenda', ${graph}::uuid, 'core/agenda', ${JSON.stringify(AGENDA_DEF_1B)}::jsonb, NULL, 901)`);
    });
    try {
      const e = await execErrorOf(applyMigrate1v(db, personal(graph)));
      expect(e.message).toBe(AGENDA_OWNER_ROWS);
      expect(AGENDA_OWNER_ROWS).toContain('сначала --drop-agenda-rows по слову владельца');
      const t = testIo([personal(graph)]);
      expect(await runMigrate1v(['--apply', '--i-understand'], t.io)).toBe(1);
      expect(t.err).toEqual([`граф ${graph}: ${AGENDA_OWNER_ROWS}`]);
    } finally {
      await admin(({ db: a }) =>
        a.execute(sql`DELETE FROM subscription_definitions WHERE graph_id = ${graph}::uuid`),
      );
    }
    expect(await worldSnapshot(graph)).toEqual(before);
  });
});

describe('(к) --drop-agenda-rows', () => {
  test('удаляет подписки с движком agenda и дельты на orbis/agenda одной транзакцией, прочее на месте', async () => {
    const graph = await freshGraph();
    const other = await freshGraph();
    const deltaAgenda = newId();
    const deltaOther = newId();
    await admin(async ({ db: a }) => {
      for (const [g, id] of [
        [graph, 'user/my-agenda'],
        [other, 'user/their-agenda'],
      ] as const) {
        await a.execute(sql`INSERT INTO subscription_definitions (id, graph_id, surface, definition, module, rank)
          VALUES (${id}, ${g}::uuid, 'core/agenda', ${JSON.stringify(AGENDA_DEF_1B)}::jsonb, NULL, 901)`);
      }
      await a.execute(sql`INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
        VALUES (${deltaAgenda}::uuid, ${graph}::uuid, 'subscription', 'orbis/agenda', 1, '{}'::jsonb),
               (${deltaOther}::uuid, ${graph}::uuid, 'property', 'orbis/priority', 1, '{}'::jsonb)`);
    });
    try {
      const version = async (g: GraphId) =>
        (
          await admin(({ db: a }) =>
            a.execute(
              sql`SELECT registry_version AS v FROM user_settings WHERE graph_id = ${g}::uuid`,
            ),
          )
        )[0]?.v;
      const v0 = await version(graph);
      const t = testIo([personal(graph)]);
      expect(await runMigrate1v(['--drop-agenda-rows', '--i-understand'], t.io)).toBe(0);
      expect(t.out).toEqual([
        `граф ${graph}: удалено подписок 1, дельт 1 (user/my-agenda, ${deltaAgenda})`,
      ]);
      const left = await admin(({ db: a }) =>
        a.execute(sql`SELECT id::text AS id FROM subscription_definitions WHERE graph_id IN (${graph}::uuid, ${other}::uuid)
          UNION ALL SELECT id::text FROM registry_deltas WHERE graph_id = ${graph}::uuid`),
      );
      expect(left.map((r) => r.id).sort()).toEqual([deltaOther, 'user/their-agenda'].sort());
      // Версия реестра владельца поднята тем же коммитом (кеш эффективных определений).
      expect(await version(graph)).toBe(Number(v0 ?? 0) + 1);
      // Повтор — ноль и без подъёма версии.
      expect(await admin(({ db: a }) => dropAgendaRows(a, graph))).toEqual({
        subscriptions: 0,
        deltas: 0,
        ids: [],
      });
    } finally {
      await admin(async ({ db: a }) => {
        await a.execute(
          sql`DELETE FROM subscription_definitions WHERE graph_id IN (${graph}::uuid, ${other}::uuid)`,
        );
        await a.execute(sql`DELETE FROM registry_deltas WHERE graph_id = ${graph}::uuid`);
      });
    }
  });
});

describe('(л) --rehearsal — только локальная база', () => {
  test('чужой хост — отказ кодом 2, ни Ключницы, ни базы; 127.0.0.1 — DSN принят', async () => {
    const remote = testIo([], {
      rehearsalDsn: () => 'postgres://x@db.example.com/postgres',
      open: () => {
        throw new Error('база открыта при отказе репетиции');
      },
    });
    expect(await runMigrate1v(['--report', '--rehearsal'], remote.io)).toBe(2);
    expect(remote.err[0]).toContain('репетиция — только локальная база');
    expect(remote.dsnRead).toEqual([]);

    const opened: string[] = [];
    // IO подменён целиком: пул-заглушка отвечает пусто и в базу не ходит.
    const fake = (() => Promise.resolve([])) as unknown as Sql;
    const local = testIo([], {
      rehearsalDsn: () => 'postgres://postgres:p@ss@127.0.0.1:54322/orbis_rehearsal',
      open: (dsn) => {
        opened.push(dsn);
        // drizzle-заглушка отвечает только на пробу роли (роль с BYPASSRLS), в базу не ходит.
        const fakeDb = {
          execute: async () => [{ role: 'postgres', bypass_rls: true }],
        } as unknown as Db;
        return { sql: fake, db: fakeDb, close: async () => {} };
      },
    });
    expect(await runMigrate1v(['--report', '--rehearsal'], local.io)).toBe(0);
    expect(opened).toEqual(['postgres://postgres:p@ss@127.0.0.1:54322/orbis_rehearsal']);
    expect(local.dsnRead).toEqual([]);
  });

  test('разбор хоста: пароль с @, host= в параметрах, несколько хостов, похожий домен', () => {
    expect(rehearsalDsnRefusal('postgres://u@localhost/db')).toBeNull();
    expect(rehearsalDsnRefusal('postgresql://u:p@127.0.0.1:5432/db')).toBeNull();
    // Пароль с `@` — хост после ПОСЛЕДНЕГО `@` authority; `@` в параметрах после локального хоста не мешает.
    expect(
      rehearsalDsnRefusal('postgres://postgres:p@ss@127.0.0.1:54322/orbis_rehearsal'),
    ).toBeNull();
    expect(rehearsalDsnRefusal('postgres://u@localhost/db?application_name=a@b')).toBeNull();
    for (const dsn of [
      undefined,
      '',
      'mysql://u@localhost/db',
      'postgres://u@db.example.com:5432/db',
      'postgres://u@localhost/db?host=db.example.com',
      'postgres://u@localhost,db.example.com/db',
      'postgres://u@127.0.0.1.example.com/db',
      'postgres://localhost@db.example.com/db',
      // М-1 ревью B2a: `@` в пути или параметрах — не хост; драйвер идёт на prod.example.com.
      'postgres://u:p@prod.example.com/db?x=@localhost',
      'postgres://u:p@prod.example.com:5432/db@localhost',
      'postgres://u:p@prod.example.com?x=@127.0.0.1',
      'postgres://u:p@prod.example.com#@localhost',
    ]) {
      expect([dsn, rehearsalDsnRefusal(dsn) === null]).toEqual([dsn, false]);
    }
  });
});

// ─────────────────────────────── фикс-круг 1 ───────────────────────────────

describe('фикс-круг 1: дельты, роль, переменная репетиции, план переведённого и незаведённого', () => {
  test('гейт I-1: дельта владельца на orbis/agenda — в agendaDeltas, СТОП; --apply — отказ «сначала --drop-agenda-rows»', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    const delta = newId();
    const other = newId();
    await admin(({ db: a }) =>
      a.execute(sql`INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
        VALUES (${delta}::uuid, ${graph}::uuid, 'subscription', 'orbis/agenda', 1, '{}'::jsonb),
               (${other}::uuid, ${graph}::uuid, 'subscription', 'orbis/budget-overview', 1, '{}'::jsonb)`),
    );
    try {
      const r = await reportOf(graph);
      expect(r.agendaDeltas).toEqual([delta]);
      expect(r.agendaOwnerSubscriptions).toEqual([]);
      expect(formatMigrate1vReport(r).some((l) => l.includes('СТОП'))).toBe(true);
      const before = await worldSnapshot(graph);
      const e = await execErrorOf(applyMigrate1v(db, personal(graph)));
      expect(e.message).toBe(AGENDA_OWNER_ROWS);
      expect(e.details).toEqual({ graph, ids: [delta] });
      expect(await worldSnapshot(graph)).toEqual(before);
    } finally {
      await admin(({ db: a }) =>
        a.execute(sql`DELETE FROM registry_deltas WHERE graph_id = ${graph}::uuid`),
      );
    }
  });

  test('Fable Minor-1 (+ М-3 ревью B2a): --report, --drop-agenda-rows и --apply ролью без BYPASSRLS — код 1, ни одного счёта', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    const before = await worldSnapshot(graph);
    for (const mode of [
      ['--report'],
      ['--drop-agenda-rows', '--i-understand'],
      ['--apply', '--i-understand'],
    ]) {
      const t = testIo([personal(graph)], {
        // Роль приложения: FORCE RLS без идентичности — ноль строк.
        open: () => {
          const { db: d, client: c } = appDb();
          return { sql: c, db: d, close: () => c.end() };
        },
      });
      expect([mode[0], await runMigrate1v(mode, t.io)]).toEqual([mode[0], 1]);
      expect(t.err[0]).toContain('НЕ несёт BYPASSRLS');
      expect(t.out).toEqual([]);
    }
    expect(await worldSnapshot(graph)).toEqual(before);
  });

  test('Fable Minor-2: ORBIS_REHEARSAL_DSN без --rehearsal — код 2 до Ключницы и базы', async () => {
    const t = testIo([], {
      rehearsalDsn: () => 'postgres://u@127.0.0.1/orbis_rehearsal',
      open: () => {
        throw new Error('база открыта');
      },
    });
    expect(await runMigrate1v(['--report'], t.io)).toBe(2);
    expect(t.err[0]).toContain('задана без --rehearsal');
    expect(t.dsnRead).toEqual([]);
  });

  test('гейт m-2: план переведённого графа — «уже», прочее keep', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    await applied(graph);
    expect((await reportOf(graph)).plan).toEqual({
      agenda: 'exists',
      shellNav: 'keep',
      year: 'keep',
      upcoming: 'keep',
    });
  });

  test('гейт m-3: незаведённый граф — план unseeded, --apply пропускает без записи', async () => {
    const graph = await freshGraph();
    expect((await reportOf(graph)).plan).toEqual({
      agenda: 'unseeded',
      shellNav: 'keep',
      year: 'keep',
      upcoming: 'keep',
    });
    const before = await worldSnapshot(graph);
    expect(await applyMigrate1v(db, personal(graph))).toEqual({ unseeded: true });
    const t = testIo([personal(graph)]);
    expect(await runMigrate1v(['--apply', '--i-understand'], t.io)).toBe(0);
    expect(t.out).toContain(
      `граф ${graph}: не заведён (оболочки хоста нет) — пропущен, ничего не записано`,
    );
    expect(await worldSnapshot(graph)).toEqual(before);
  });

  test('гейт m-4: обвязка --report на базе со строкой orbis/agenda прежней формы — отчёт собран, СТОП — код 1', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    const before = await worldSnapshot(graph);
    // Строки прежней формы НИКОГДА не коммитятся (ре-ревью rm-1): обвязка получает пул-адаптер над откатываемой
    // транзакцией — запрос идёт в неё, а свою транзакцию READ ONLY обвязка открывает точкой сохранения внутри.
    // Прерывание теста или соседняя сессия на общей базе строку не увидят и не унаследуют.
    let code: number | undefined;
    let t: ReturnType<typeof testIo> | undefined;
    await inRollback(async (tx) => {
      await oldAgendaRows(tx, { graph, id: 'user/my-agenda' });
      await tx`SET LOCAL transaction_read_only = on`;
      const call = tx as unknown as (...a: unknown[]) => unknown;
      const pool = Object.assign((...a: unknown[]) => call(...a), {
        begin: (_mode: string, cb: (inner: TransactionSql) => unknown) => tx.savepoint(cb),
      }) as unknown as Sql;
      // drizzle-заглушка отвечает только на пробу роли (роль с BYPASSRLS), как в тесте (л).
      const roleDb = {
        execute: async () => [{ role: 'postgres', bypass_rls: true }],
      } as unknown as Db;
      t = testIo([personal(graph)], {
        open: () => ({ sql: pool, db: roleDb, close: async () => {} }),
      });
      code = await runMigrate1v(['--report'], t.io);
    });
    expect(code).toBe(1);
    expect(t?.err).toEqual([]);
    expect(t?.out[0]).toContain('встроенная подписка orbis/agenda в базе');
    expect(t?.out).toContain('  подписки графа с движком agenda: 1: user/my-agenda');
    expect(t?.out).toContain(
      '  СТОП (§6.5): до миграции 0023 — --drop-agenda-rows --i-understand по слову владельца',
    );
    expect(await worldSnapshot(graph)).toEqual(before);
    // После отката встроенной строки прежней формы в базе нет.
    expect(await admin(({ sql: s }) => agendaRowPresent(s))).toBe(false);
  });

  test('гейт m-5: документ и текст одной закреплённой версии — две строки, без задвоения форм', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'etalon-1b');
    const page = await ownerCreate(graph, { title: 'Страница' });
    const version = newId();
    const ast = { filter: { prop: 'orbis/due_date', op: 'lt', value: { token: 'next_7d' } } };
    const bodyDoc = {
      v: 3,
      doc: {
        type: 'doc',
        content: [{ type: 'queryBlock', attrs: { text: 'orbis/due_date<next_7d', ast } }],
      },
    };
    await admin(({ db: a }) =>
      a.execute(sql`INSERT INTO entity_versions (id, graph_id, entity_id, label, body, body_doc, actor_user_id, actor_kind)
        VALUES (${version}::uuid, ${graph}::uuid, ${page}::uuid, 'старая', '{{query:orbis/due_date<next_7d}}',
          ${JSON.stringify(bodyDoc)}::jsonb, ${graph}::uuid, 'owner')`),
    );
    const lt7: TokenBoundaryForm[] = [{ token: 'next_7d', form: 'lt', verdict: 'changed' }];
    expect((await reportOf(graph)).tokenBoundaries.filter((t) => t.id === version)).toEqual([
      { where: 'entity_versions', id: version, store: 'body_doc', forms: lt7 },
      { where: 'entity_versions', id: version, store: 'body', forms: lt7 },
    ]);
  });
});

// M-3 финального ревью B2b: эталоны 1б фикстуры берутся частью из живого кода — их отпечатки обязаны
// совпасть с отпечатками КОДА РЕЛИЗА 1б (`ae3b710d`, литералы `ETALON_HASHES_1B`). Код, ушедший дальше,
// краснеет здесь, а не сдвигает «прод-состояние» тестов перевода молча.
test('фикстура 1б — отпечатки релиза ae3b710d у каждого эталона ETALONS_1B', () => {
  expect(Object.fromEntries(ETALONS_1B.map((e) => [e.key as string, etalonHash(e)]))).toEqual(
    ETALON_HASHES_1B,
  );
});

// M-5 финального ревью B2b: боевой IO (`migrate1vIo`, его зовёт `scripts/ops.ts`) — тот самый, а не копия
// теста: переменная репетиции из окружения, пул и drizzle на одном соединении, графы — планировщика.
describe('боевой IO операции (migrate1vIo — его зовёт ops.ts)', () => {
  test('окружение, одно соединение пула и drizzle, графы планировщика; readDsn/печать — насквозь', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    const { client } = adminDb();
    const opened: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    let dsnRead = 0;
    const deps = {
      readDsn: () => {
        dsnRead += 1;
        return 'postgres://prod-из-ключницы';
      },
      openSql: (dsn: string) => {
        opened.push(dsn);
        return client;
      },
      log: (l: string) => out.push(l),
      error: (l: string) => err.push(l),
    };
    const io = migrate1vIo({ ...deps, env: {} });
    expect(io.rehearsalDsn()).toBeUndefined();
    expect(
      migrate1vIo({
        ...deps,
        env: { ORBIS_REHEARSAL_DSN: 'postgres://u@127.0.0.1/r' },
      }).rehearsalDsn(),
    ).toBe('postgres://u@127.0.0.1/r');
    // Переменная репетиции без флага — отказ кодом 2 ДО Ключницы и базы, печать — через `error` зависимостей.
    const stray = migrate1vIo({
      ...deps,
      env: { ORBIS_REHEARSAL_DSN: 'postgres://u@127.0.0.1/r' },
    });
    expect(await runMigrate1v(['--report'], stray)).toBe(2);
    expect(err[0]).toContain('задана без --rehearsal');
    expect([dsnRead, opened]).toEqual([0, []]);
    expect(io.readDsn()).toBe('postgres://prod-из-ключницы');

    const o = io.open('postgres://из-ключницы');
    try {
      expect(opened).toEqual(['postgres://из-ключницы']);
      // Пул отчёта и drizzle перевода — одно соединение.
      expect(o.sql).toBe(client);
      expect((o.db as unknown as { $client: unknown }).$client).toBe(client);
      // Графы — планировщика: граф со строкой настроек и его владелец.
      expect(await io.identities(o.db)).toContainEqual(personal(graph));
    } finally {
      await o.close();
    }
  });
});

describe('фикс-круг 2', () => {
  test('ре-ревью rm-2: --undo судит о действии с названным id, а не о первом действии записи', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    const first = newId();
    const named = newId();
    // Запись журнала, где ПЕРВОЕ действие похоже на пачку операции (system, подпись В-4), а названное —
    // обычная правка: проверка по `actions[0]` пропустила бы её к откату.
    await admin(({ db: a }) =>
      a.execute(sql`INSERT INTO chat_messages (id, thread_id, role, content, metadata)
        SELECT ${newId()}::uuid, t.id, 'system', 'пачка', ${JSON.stringify({
          actions: [
            { id: first, source: 'system' },
            { id: named, source: 'ui' },
          ],
          cards: [{ title: MIGRATE_1V_LABEL }, { title: 'Правка' }],
        })}::jsonb
          FROM chat_threads t WHERE t.graph_id = ${graph}::uuid LIMIT 1`),
    );
    const before = await worldSnapshot(graph);
    const t = testIo([personal(graph)]);
    expect(await runMigrate1v(['--undo', named, '--i-understand'], t.io)).toBe(1);
    expect(t.err[0]).toContain('не пачка migrate-1v');
    expect(await worldSnapshot(graph)).toEqual(before);
  });

  // Мутации I-3 финального ревью: отказ держат ДВА условия — источник `system` И подпись В-4, — и каждое
  // по отдельности. Прежние тесты брали чужое действие `ui` с подписью «Правка» — его отсекали оба разом.
  test('I-3: --undo — системная пачка ДРУГОЙ операции и подпись В-4 не от system — обе отказ', async () => {
    const graph = await freshGraph();
    await seedWorld1b(db, graph, 'prod');
    const otherSystem = newId();
    const labelNotSystem = newId();
    const journal = (actionId: string, source: string, title: string) =>
      admin(({ db: a }) =>
        a.execute(sql`INSERT INTO chat_messages (id, thread_id, role, content, metadata)
          SELECT ${newId()}::uuid, t.id, 'system', 'пачка', ${JSON.stringify({
            actions: [{ id: actionId, source }],
            cards: [{ title }],
          })}::jsonb
            FROM chat_threads t WHERE t.graph_id = ${graph}::uuid LIMIT 1`),
      );
    // Системная пачка другой операции: источник тот же, подпись чужая.
    await journal(otherSystem, 'system', 'Материализация повторов');
    // Подпись В-4, но источник — не `system`.
    await journal(labelNotSystem, 'ui', MIGRATE_1V_LABEL);
    const before = await worldSnapshot(graph);
    for (const actionId of [otherSystem, labelNotSystem]) {
      const t = testIo([personal(graph)]);
      expect([actionId, await runMigrate1v(['--undo', actionId, '--i-understand'], t.io)]).toEqual([
        actionId,
        1,
      ]);
      expect(t.err[0]).toContain('не пачка migrate-1v');
    }
    expect(await worldSnapshot(graph)).toEqual(before);
  });
});
