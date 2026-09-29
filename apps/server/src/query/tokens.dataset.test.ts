// apps/server/src/query/tokens.dataset.test.ts
// ТОКЕНЫ ДАТ И ДВА КРАЯ НА НАСТОЯЩЕЙ БАЗЕ (спека 1в §3.4, С1в-3, С1в-11 «два края»).
//
// (в) Правило двух краёв — одно для всех восьми токенов: `=T` — в [начало; конец], `<T` — раньше
// начала, `>=T` — не раньше начала, `>T` — позже конца, `<=T` — не позже конца. Здесь оно сверяется
// ВЫДАЧЕЙ: задачи со сроками на днях вокруг «сегодня» (`2026-07-15`, среда, пояс `Asia/Novosibirsk`)
// и каждая форма каждого токена — ровно множество дней, которое называет таблица краёв. Таблица
// записана ЗДЕСЬ ЛИТЕРАЛАМИ (по спеке), а не взята из `tokenEdges`: иначе сверка подтвердила бы
// функцию самой собой. Те же формы — над значением «когда» (мир `seedWhenWorld`).
//
// (г) Деревья мимо разбора: компилятор повторяет отказ несуществующего края (`TOKEN_EDGE`) — вход
// `ast` роутера и тула, `over` действия (отказ записи), источник прогресса цели (`invalid_query`,
// не падение), атрибут `ast` блока тела (сервер его печатает — отказ даёт разбор блока пачки).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bindQueryBlockAttrs } from '@orbis/shared/doc';
import {
  parseQueryAst,
  type QueryAst,
  type QueryDateToken,
  type QueryFilterNode,
  toParseRegistry,
} from '@orbis/shared/query';
import { OWN_ACTION_DECL } from '../../test/fixtures/action-seed';
import { appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { seedWhenWorld, type WhenName, type WhenWorld } from '../../test/when-world';
import { withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import { computeGoalProgress } from '../goals/progress';
import { effectiveRegistry } from '../registry/cache';
import { appRouter } from '../router';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';
import { type CompileCtx, compileQueryAst } from './compile-ast';
import { queryContext } from './context';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});

const TODAY = '2026-07-15';
const TIME_ZONE = 'Asia/Novosibirsk';

/** Дни сроков — края всех восьми токенов и по дню по обе стороны от каждого края. */
const DAYS = [
  '2026-06-30',
  '2026-07-01',
  '2026-07-12',
  '2026-07-13',
  '2026-07-14',
  '2026-07-15',
  '2026-07-19',
  '2026-07-20',
  '2026-07-22',
  '2026-07-23',
  '2026-07-29',
  '2026-07-30',
  '2026-07-31',
  '2026-08-01',
] as const;

/** Таблица краёв спеки §3.4 для «сегодня» 2026-07-15 (неделя с понедельника); null — края нет. */
const EDGES: Readonly<Record<QueryDateToken, readonly [string | null, string | null]>> = {
  today: ['2026-07-15', '2026-07-15'],
  overdue: [null, '2026-07-14'],
  next_7d: ['2026-07-15', '2026-07-22'],
  next_14d: ['2026-07-15', '2026-07-29'],
  after_7d: ['2026-07-23', null],
  this_week: ['2026-07-13', '2026-07-19'],
  this_month: ['2026-07-01', '2026-07-31'],
  last_month: ['2026-06-01', '2026-06-30'],
};

type Form = '=' | '<' | '<=' | '>' | '>=';
const FORMS: readonly Form[] = ['=', '<', '<=', '>', '>='];

/** Какой край читает форма; `null` у нужного края — форма отказная. */
function expectedDays(token: QueryDateToken, form: Form): string[] | null {
  const [start, end] = EDGES[token];
  const pick = (pred: (d: string) => boolean) => DAYS.filter(pred);
  switch (form) {
    case '=':
      return pick((d) => (start === null || d >= start) && (end === null || d <= end));
    case '<':
      return start === null ? null : pick((d) => d < start);
    case '>=':
      return start === null ? null : pick((d) => d >= start);
    case '>':
      return end === null ? null : pick((d) => d > end);
    case '<=':
      return end === null ? null : pick((d) => d <= end);
  }
}

let daysGraph: Awaited<ReturnType<typeof freshGraph>>;
const dayOf = new Map<string, string>();
let whenGraph: Awaited<ReturnType<typeof freshGraph>>;
let world: WhenWorld;

beforeAll(async () => {
  daysGraph = await freshGraph();
  for (const day of DAYS) {
    const r = await execute(db, {
      identity: personal(daysGraph),
      actorKind: 'owner',
      source: 'ui',
      mechanism: 'user',
      operations: [
        {
          tool: 'entity_create',
          input: {
            title: `срок ${day}`,
            tags: [],
            aspects: ['orbis/task'],
            props: { 'orbis/task_status': 'planned', 'orbis/due_date': day },
          },
        },
      ],
    });
    if (!r.ok) throw new Error(`задача со сроком ${day}: ${r.error.code} — ${r.error.message}`);
    dayOf.set((r.results[0] as { id: string }).id, day);
  }
  whenGraph = await freshGraph();
  world = await seedWhenWorld(whenGraph, { today: TODAY, timeZone: TIME_ZONE });
});

/** Контекст с зафиксированными «сегодня», поясом и началом недели (В-1: понедельник). */
async function ctxOf(graph: typeof daysGraph): Promise<CompileCtx> {
  const reg = await withIdentity(db, personal(graph), (tx) => effectiveRegistry(tx, graph));
  return {
    graphId: graph,
    today: TODAY,
    timeZone: TIME_ZONE,
    weekStart: 'monday',
    ownerCurrency: 'RUB',
    reg,
    thisEntityId: null,
  };
}

function parse(text: string, c: CompileCtx): QueryAst {
  const parsed = parseQueryAst(text, toParseRegistry(c.reg, 'ru'));
  if (!parsed.ok) throw new Error(`«${text}»: ${parsed.error.code} — ${parsed.error.message}`);
  return parsed.ast;
}

async function idsOf(graph: typeof daysGraph, ast: QueryAst, c: CompileCtx): Promise<string[]> {
  const rows = await withIdentity(db, personal(graph), (tx) => tx.execute(compileQueryAst(ast, c)));
  return [...rows].map((r) => (r as { id: string }).id);
}

/** Дни выдачи по сроку; запись вне набора дней — отказ теста, а не тихий пропуск. */
async function daysFor(text: string): Promise<string[]> {
  const c = await ctxOf(daysGraph);
  const ids = await idsOf(daysGraph, parse(text, c), c);
  return ids
    .map((id) => {
      const day = dayOf.get(id);
      if (day === undefined) throw new Error(`в выдаче запись вне набора дней: ${id}`);
      return day;
    })
    .sort();
}

/** Имена мира «когда»; служебная категория вычитается. */
async function whenNames(text: string): Promise<WhenName[]> {
  const c = await ctxOf(whenGraph);
  const ids = await idsOf(whenGraph, parse(text, c), c);
  return ids
    .flatMap((id) => {
      if (world.helperIds.includes(id)) return [];
      const name = world.nameOf.get(id);
      if (name === undefined) throw new Error(`в выдаче запись вне мира: ${id}`);
      return [name];
    })
    .sort();
}

/** Структурный отказ компиляции: код и причина. */
function refusalOf(fn: () => unknown): { code: string; reason: unknown; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExecError) {
      return {
        code: e.code,
        reason: (e.details as { reason?: unknown } | undefined)?.reason,
        message: e.message,
      };
    }
    throw e;
  }
  throw new Error('ожидался отказ компиляции');
}

const TOKENS = Object.keys(EDGES) as QueryDateToken[];
const CASES = TOKENS.flatMap((token) =>
  FORMS.map((form) => [`orbis/due_date${form}${token}`, token, form] as const),
);

describe('(в) два края на выдаче: срок задачи, восемь токенов, пять форм', () => {
  test.each(CASES)('%s', async (text, token, form) => {
    const expected = expectedDays(token, form);
    if (expected === null) {
      // Отказная форма: у токена нет нужного края — и разбор, и компиляция дерева отказывают.
      const c = await ctxOf(daysGraph);
      const parsed = parseQueryAst(text, toParseRegistry(c.reg, 'ru'));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe('TOKEN_EDGE');
      return;
    }
    expect(await daysFor(text)).toEqual([...expected].sort());
  });

  test('отказных форм ровно четыре: <overdue, >=overdue, >after_7d, <=after_7d', () => {
    const refused: string[] = CASES.filter(
      ([, token, form]) => expectedDays(token, form) === null,
    ).map(([text]) => text);
    expect(refused.sort()).toEqual(
      [
        'orbis/due_date<overdue',
        'orbis/due_date>=overdue',
        'orbis/due_date>after_7d',
        'orbis/due_date<=after_7d',
      ].sort(),
    );
  });

  test('диапазон с краями-токенами: from — начало, to — конец', async () => {
    expect(await daysFor('orbis/due_date=this_week..next_14d')).toEqual(
      DAYS.filter((d) => d >= '2026-07-13' && d <= '2026-07-29'),
    );
    expect(await daysFor('orbis/due_date=last_month..overdue')).toEqual(
      DAYS.filter((d) => d >= '2026-06-01' && d <= '2026-07-14'),
    );
  });

  test('неделя «this_week» — с понедельника 07-13 по воскресенье 07-19 (В-1)', async () => {
    expect(await daysFor('orbis/due_date=this_week')).toEqual([
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
      '2026-07-19',
    ]);
  });
});

describe('(в) те же края над значением «когда» (мир С1в-1)', () => {
  const VALUE_CASES: ReadonlyArray<[string, WhenName[]]> = [
    [
      'orbis/when=this_week',
      ['E1', 'E2', 'T1', 'T2', 'T3', 'T4', 'T7', 'T8', 'T9', 'T10', 'T11a', 'T12'],
    ],
    // Дата позже воскресенья 07-19 — только срок T8 (08-14).
    ['orbis/when>this_week', ['T8']],
    // Раньше сегодня: вчерашние сроки T2, T8 и факт T4.
    ['orbis/when<next_7d', ['T2', 'T4', 'T8']],
    ['orbis/when<=overdue', ['T2', 'T4', 'T8']],
    // Не раньше сегодня.
    ['orbis/when>overdue', ['E1', 'E2', 'T1', 'T3', 'T7', 'T8', 'T9', 'T10', 'T11a', 'T12']],
    ['orbis/when>=next_14d', ['E1', 'E2', 'T1', 'T3', 'T7', 'T8', 'T9', 'T10', 'T11a', 'T12']],
    [
      'orbis/when=this_month',
      ['E1', 'E2', 'T1', 'T2', 'T3', 'T4', 'T7', 'T8', 'T9', 'T10', 'T11a', 'T12'],
    ],
    ['orbis/when=last_month', []],
    // Адрес слота — сырые значения: `moment` у расписаний и аспекта владельца.
    ['orbis/when.moment=this_week', ['E1', 'E2', 'T8', 'T9', 'T10']],
    ['orbis/when.deadline>=after_7d', ['T8']],
  ];
  test.each(VALUE_CASES)('%s', async (text, expected) => {
    expect(await whenNames(text)).toEqual([...expected].sort());
  });
});

describe('(г) деревья мимо разбора — тот же отказ TOKEN_EDGE', () => {
  const LT_OVERDUE: QueryFilterNode = {
    prop: 'orbis/due_date',
    op: 'lt',
    value: { token: 'overdue' },
  };

  test('compileQueryAst: `<overdue`, `to=after_7d`, `orbis/when<overdue` — VALIDATION/TOKEN_EDGE', async () => {
    const c = await ctxOf(daysGraph);
    for (const filter of [
      LT_OVERDUE,
      {
        prop: 'orbis/due_date',
        op: 'range',
        value: { from: { token: 'today' }, to: { token: 'after_7d' } },
      },
      { prop: { contract: 'orbis/when' }, op: 'lt', value: { token: 'overdue' } },
      {
        prop: { contract: 'orbis/when', slot: 'deadline' },
        op: 'gt',
        value: { token: 'after_7d' },
      },
    ] as QueryFilterNode[]) {
      const r = refusalOf(() => compileQueryAst({ filter }, c));
      expect(r.code, JSON.stringify(filter)).toBe('VALIDATION');
      expect(r.reason, JSON.stringify(filter)).toBe('TOKEN_EDGE');
    }
    // Разбор тех же форм — тот же код.
    for (const text of ['orbis/due_date=today..after_7d', 'orbis/when<overdue']) {
      const parsed = parseQueryAst(text, toParseRegistry(c.reg, 'ru'));
      expect(parsed.ok ? null : parsed.error.code, text).toBe('TOKEN_EDGE');
    }
  });

  test('entity.query({ast}) — VALIDATION, reason TOKEN_EDGE', async () => {
    const caller = createCallerFactory(appRouter)({
      identity: personal(daysGraph),
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    let cause: unknown = null;
    try {
      await caller.entity.query({ ast: { filter: LT_OVERDUE } });
    } catch (e) {
      cause = (e as { cause?: unknown }).cause;
    }
    expect(cause).toMatchObject({ reason: 'TOKEN_EDGE' });
  });

  test('тул entity_query с `ast` — VALIDATION, reason TOKEN_EDGE', async () => {
    const r = await dispatchTool(
      {
        db,
        identity: personal(daysGraph),
        actorKind: 'ai',
        source: 'chat',
        explicitCommand: false,
      },
      'entity_query',
      { ast: { filter: LT_OVERDUE } },
    );
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.error.code).toBe('VALIDATION');
      expect((r.error.details as { reason?: string }).reason).toBe('TOKEN_EDGE');
    }
  });

  test('`over` действия — отказ записи action_set', async () => {
    const owner = await freshGraph();
    const r = await execute(db, {
      identity: personal(owner),
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'action_set',
          input: { ...OWN_ACTION_DECL, over: { filter: LT_OVERDUE }, batch_cap: 10 },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION');
      expect((r.error.details as { reason?: string }).reason).toBe('TOKEN_EDGE');
    }
    // Та же декларация с законной формой (`<=overdue`) записывается.
    const good = await execute(db, {
      identity: personal(owner),
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'action_set',
          input: {
            ...OWN_ACTION_DECL,
            over: {
              filter: { prop: 'orbis/due_date', op: 'range', value: { to: { token: 'overdue' } } },
            },
            batch_cap: 10,
          },
        },
      ],
    });
    expect(good.ok).toBe(true);
  });

  test('значение `orbis/progress_source` цели — invalid_query, расчёт не падает', async () => {
    const got = await withIdentity(db, personal(daysGraph), async (tx) =>
      computeGoalProgress(tx, await queryContext(tx, daysGraph, null), {
        progressSource: {
          query: { filter: LT_OVERDUE },
          aggregate: 'count',
        } as never,
        targetValue: '10',
      }),
    );
    expect(got.unsupported).toBe('invalid_query');
  });

  test('атрибут `ast` блока тела печатается в текст — блок пачки entity.blocks отказывает TOKEN_EDGE', async () => {
    const c = await ctxOf(daysGraph);
    const bound = bindQueryBlockAttrs(
      { ast: { filter: LT_OVERDUE }, text: '' },
      toParseRegistry(c.reg, 'ru'),
    );
    expect(bound.text).toBe('orbis/due_date<overdue');
    const caller = createCallerFactory(appRouter)({
      identity: personal(daysGraph),
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    const { results } = await caller.entity.blocks({ blocks: [{ key: 'b', text: bound.text }] });
    const b = results.b;
    expect(b?.ok).toBe(false);
    if (b !== undefined && !b.ok) expect(b.error.code).toBe('TOKEN_EDGE');
  });
});
