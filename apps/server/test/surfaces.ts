// apps/server/test/surfaces.ts — снимок ВЫДАЧИ четырёх поверхностей (§С8-20).
//
// «Сегодня» ПРИБИТО, мир — в абсолютных датах: все читатели берут `today` параметром
// (`computeOverview(tx,…,today)`, `CompileCtx.today`), поэтому эталон не зависит от дня
// прогона; мир относительно реального «сегодня» давал бы каждый день другой `dailyPace` и
// другой `period_balance` на границе месяца.
//
// Снимок идёт МИМО tRPC-ручек: `budgetOverview` (`aggregates.ts:648`) гоняет `preparePeriod`
// (`:634` — postDue + материализация), `entity.query` (`routers/entity.ts:317`) —
// `queryWithMaterialization`; оба ПИШУТ в граф, а материализованные инстансы приезжали бы со
// случайными uuid. Здесь четыре поверхности считаются на ОДНОЙ `withIdentity`-tx тем же
// компилятором и тем же `computeOverview`, что и ручки, — с прибитым `today` и без записи.
import {
  addDays,
  type BudgetOverview,
  canonicalJson,
  ORBIS_NAMESPACE,
  type RowProjection,
  rowProjectionOf,
  SURFACES,
} from '@orbis/shared';
import { v5 as uuidv5 } from 'uuid';
import { computeOverview } from '../src/budget/aggregates';
import type { Db } from '../src/db/client';
import { type Tx, withIdentity } from '../src/db/with-identity';
import { execute } from '../src/executor/executor';
import type { WireEntity } from '../src/executor/types';
import { type CompileCtx, compileQueryAst } from '../src/query/compile-ast';
import { queryContext } from '../src/query/context';
import { parseQueryText } from '../src/query/parse-text';
import { toWireEntityFromSql } from '../src/wire';
import { appDb } from './helpers';

export const SURFACE_STATES = ['baseline', 'module-off', 'custom-aspect', 'relabeled'] as const;
export type SurfaceState = (typeof SURFACE_STATES)[number];

/**
 * Имена снимков (Р-К-10). Первые два ПРИЕЗЖАЮТ ИЗ `SURFACES` (`registry/modules.ts`), а не повторены
 * литералом: по `SURFACES` отказывает `SURFACE_UNKNOWN`, и разъезд двух списков означал бы снимок
 * поверхности, которую валидатор уже не признаёт, — молча и до первого пересева. `core/*` подписками
 * не описаны (правило строки — константа `M14_ROW_ELEMENTS`, Р-К-1), поэтому дописаны здесь.
 */
export const SNAPSHOT_SURFACES = [...SURFACES, 'core/row', 'core/exclude-blocked'] as const;
export type SnapshotSurface = (typeof SNAPSHOT_SURFACES)[number];

export const SURFACE_OWNER_ID = uuidv5('surface-snapshot-fixture:owner', ORBIS_NAMESPACE);
/** Прибитое «сегодня» снимка — внутри периода конвертов (прецедент `compile.golden.test.ts:66`). */
export const SURFACE_TODAY = '2026-07-03';
export const SURFACE_MONTH = '2026-07';

/** id сущности мира — uuidv5 от владельца и слага: воспроизводим без обращения к БД. */
export function surfaceEntityId(ownerId: string, slug: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:surface-world:${slug}`, ORBIS_NAMESPACE);
}

/** Слаги мира в порядке сева; они же — читаемые имена в эталоне вместо uuid. */
export const SURFACE_SLUGS = [
  'cat-food',
  'cat-transport',
  'cat-coffee',
  'env-food',
  'env-transport',
  'mv-food-1',
  'mv-food-2',
  'mv-transport-1',
  'mv-salary',
  'mv-planned',
  'mv-coffee',
  'task-open',
  'task-blocked',
  'task-done',
  'note-blocker',
  'event-today',
  'tpl-weekly',
  'mem-rule',
] as const;

// Ниже — операции сева. Порядок значим: категории → конверты → движения (бюджет-хук
// привязывает движение к УЖЕ существующему конверту тем же `selectEnvelope`, `binding.ts:121`),
// связь `dependency` — последней.
function ops(ownerId: string): { tool: string; input: Record<string, unknown> }[] {
  const id = (slug: string) => surfaceEntityId(ownerId, slug);
  const cat = (slug: string, title: string, icon: string) => ({
    tool: 'entity_create',
    input: {
      id: id(slug),
      title,
      tags: [],
      aspects: ['orbis/category'],
      props: { 'orbis/icon': icon },
    },
  });
  // Произвольный период §2.9, а не календарный месяц: daysInclusive('2026-07-03','2026-07-12')=10,
  // то есть dailyPace = remaining/10 — число, которое считается руками.
  const env = (slug: string, title: string, catSlug: string, limit: string) => ({
    tool: 'entity_create',
    input: {
      id: id(slug),
      title,
      tags: [],
      aspects: ['orbis/budget'],
      props: {
        'orbis/finance_category': id(catSlug),
        'orbis/limit': limit,
        'orbis/currency': 'RUB',
        'orbis/period_start': '2026-07-01',
        'orbis/period_end': '2026-07-12',
      },
    },
  });
  const mv = (
    slug: string,
    title: string,
    catSlug: string,
    amount: string,
    on: string,
    over: Record<string, unknown> = {},
  ) => ({
    tool: 'entity_create',
    input: {
      id: id(slug),
      title,
      tags: [],
      aspects: ['orbis/financial'],
      props: {
        'orbis/amount': amount,
        'orbis/direction': 'expense',
        'orbis/finance_category': id(catSlug),
        'orbis/occurred_on': on,
        'orbis/currency': 'RUB',
        ...over,
      },
    },
  });
  const plain = (
    slug: string,
    title: string,
    aspects: string[],
    props: Record<string, unknown>,
  ) => ({
    tool: 'entity_create',
    input: { id: id(slug), title, tags: [], aspects, props },
  });
  return [
    cat('cat-food', 'Еда', '🍎'),
    cat('cat-transport', 'Транспорт', '🚕'),
    cat('cat-coffee', 'Кофе', '☕'),
    env('env-food', 'Конверт: Еда', 'cat-food', '10000.00'),
    env('env-transport', 'Конверт: Транспорт', 'cat-transport', '5000.00'),
    mv('mv-food-1', 'Продукты 1', 'cat-food', '3000.00', '2026-07-01'),
    mv('mv-food-2', 'Продукты 2', 'cat-food', '6000.00', '2026-07-02'),
    mv('mv-transport-1', 'Такси', 'cat-transport', '1000.00', '2026-07-02'),
    mv('mv-salary', 'Зарплата', 'cat-food', '50000.00', '2026-07-01', {
      'orbis/direction': 'income',
    }),
    mv('mv-planned', 'Покупка запланированная', 'cat-transport', '2000.00', '2026-07-10', {
      'orbis/planned': true,
    }),
    // Категория без конверта — единственная строка Unbudgeted (§2.3 шаг 5).
    mv('mv-coffee', 'Кофе с собой', 'cat-coffee', '700.00', '2026-07-02'),
    // Два аспекта разом — единственный вход во ВТОРУЮ выборку «Просроченного» (`useAgenda.ts:58`).
    plain('task-open', 'Задача просроченная', ['orbis/task', 'orbis/schedule'], {
      'orbis/task_status': 'inbox',
      'orbis/due_date': '2026-07-02',
      'orbis/start_at': '2026-07-01T09:00:00+03:00',
    }),
    // `orbis/priority: 'high'` — единственный бейдж мира: без него все 18 строк дали бы
    // `badges: []`, и элемент M14 «бейджи» эталон бы не пинил вовсе (задача 7 переписывает
    // его правило и осталась бы непроверенной). Свойство несёт сам `orbis/task` (Р9).
    plain('task-blocked', 'Задача заблокированная', ['orbis/task'], {
      'orbis/task_status': 'planned',
      'orbis/due_date': '2026-07-10',
      'orbis/priority': 'high',
    }),
    plain('task-done', 'Задача закрытая', ['orbis/task'], {
      'orbis/task_status': 'done',
      'orbis/due_date': '2026-07-01',
    }),
    // Заметка БЕЗ статуса — «незакрытый блокер» сегодняшнего сахара (`parse-ast.ts:1016-1045`:
    // COALESCE(status,'') NOT IN ('done','cancelled')): ровно она прячет цель под excludeBlocked.
    plain('note-blocker', 'Заметка-блокер', ['orbis/note'], {}),
    plain('event-today', 'Событие сегодня', ['orbis/schedule'], {
      'orbis/start_at': '2026-07-03T10:00:00+03:00',
    }),
    // Шаблон recurring: в выборку окна попадает, снимается КЛИЕНТСКИМ фильтром
    // (`useAgenda.ts:93-95`) — задача 6 переводит его в декларацию `hide`.
    plain('tpl-weekly', 'Еженедельная встреча', ['orbis/schedule'], {
      'orbis/start_at': '2026-07-03T08:00:00+03:00',
      'orbis/recurrence': { freq: 'weekly', interval: 1 },
    }),
    // Единственная сущность ветки `orbis/memory` правила строки. Образец ОБЯЗАТЕЛЕН:
    // `memory/rules.ts` fail-closed отвергает правило без `orbis/rule_pattern`.
    plain('mem-rule', 'Правило: такси', ['orbis/memory'], {
      'orbis/memory_kind': 'rule',
      'orbis/rule_pattern': 'такси',
      'orbis/rule_target': id('cat-transport'),
    }),
    {
      tool: 'relation_create',
      input: { source_id: id('note-blocker'), target_id: id('task-blocked'), role: 'dependency' },
    },
  ];
}

export async function seedSurfaceWorld(ownerId: string): Promise<void> {
  const { db, client } = appDb();
  try {
    for (const op of ops(ownerId)) {
      const r = await execute(db, {
        actorUserId: ownerId,
        actorKind: 'owner',
        source: 'ui',
        operations: [op],
      });
      if (!r.ok) throw new Error(`мир снимков ${op.tool}: ${r.error.code} — ${r.error.message}`);
    }
  } finally {
    await client.end();
  }
}

export interface AgendaSurfaceRow {
  section: 'window' | 'overdue';
  id: string;
  title: string;
  at: string;
}
export interface SurfacePayloads {
  'planner/agenda': AgendaSurfaceRow[];
  'finance/budget-overview': BudgetOverview;
  /** §1.9: `Record<entity id, RowProjection>` — тип общий (`@orbis/shared`), двойника больше нет. */
  'core/row': Record<string, RowProjection>;
  'core/exclude-blocked': string[];
}
export interface SurfaceSnapshot {
  state: SurfaceState;
  surfaces: SurfacePayloads;
}

/** Одна выборка тем же путём, что `entity.query`, но на готовой tx и с прибитым `today`. */
async function queryEntities(tx: Tx, cctx: CompileCtx, text: string): Promise<WireEntity[]> {
  const rows = await tx.execute(compileQueryAst(parseQueryText(text, cctx), cctx));
  return [...rows].map((r) => toWireEntityFromSql(r as Record<string, unknown>));
}

/** Три текста — ДОСЛОВНО `useAgenda.ts:44/:51/:58` (их близнец — `AGENDA_QUERY_TEXTS`). */
const AGENDA_DAYS_QUERY =
  'aspect=orbis/schedule, orbis/start_at=today|next_7d, sortBy=orbis/start_at:asc, limit=200';
const AGENDA_OVERDUE_DUE_QUERY =
  'aspect=orbis/task, orbis/due_date=overdue, orbis/task_status=!done&!cancelled, sortBy=orbis/due_date:asc, limit=200';
const AGENDA_OVERDUE_START_QUERY =
  'aspect=orbis/task, aspect=orbis/schedule, orbis/start_at=overdue, orbis/task_status=!done&!cancelled, sortBy=orbis/start_at:asc, limit=200';
const AGENDA_DAYS = 8;

/** Локальный день момента — копия `useAgenda.localDay` (`:104-112`). */
function localDay(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
const strProp = (e: WireEntity, id: string): string | null =>
  typeof e.props[id] === 'string' ? (e.props[id] as string) : null;
const isTemplate = (e: WireEntity): boolean => e.props['orbis/recurrence'] !== undefined;

/**
 * ВРЕМЕННАЯ СЕРВЕРНАЯ КОПИЯ клиентских правил Agenda (`useAgenda.ts:93-95`, `:142-166`,
 * `:207-235`): раскладка по локальному дню, `all_day` первым, слияние двух выборок
 * «Просроченного» по минимальной дате. Замену кладёт задача 6 (`agenda.list`), а копию сносит
 * задача 10 (шаг 7, Р-К-27): снимок переключается на `agendaListOf`.
 *
 * Снимок хранит для окна ДЕНЬ (`localDay`), а не момент: сравнимость с эталоном 0b (Р-К-26);
 * у «Просроченного» дата уже дневная в обеих выборках и кладётся как есть.
 */
async function agendaSurface(tx: Tx, cctx: CompileCtx): Promise<AgendaSurfaceRow[]> {
  const tz = cctx.timeZone;
  const out: AgendaSurfaceRow[] = [];
  const win = await queryEntities(tx, cctx, AGENDA_DAYS_QUERY);
  for (let i = 0; i < AGENDA_DAYS; i++) {
    const day = addDays(cctx.today, i);
    const inDay = win.filter((e) => {
      const s = strProp(e, 'orbis/start_at');
      return !isTemplate(e) && s !== null && localDay(s, tz) === day;
    });
    // Array#sort стабилен — порядок сервера (start_at asc) внутри дня сохраняется.
    inDay.sort(
      (a, b) =>
        Number(b.props['orbis/all_day'] === true) - Number(a.props['orbis/all_day'] === true),
    );
    for (const e of inDay) out.push({ section: 'window', id: e.id, title: e.title, at: day });
  }
  const merged = new Map<string, AgendaSurfaceRow>();
  const add = (e: WireEntity, at: string) => {
    const prev = merged.get(e.id);
    if (prev === undefined || at < prev.at)
      merged.set(e.id, { section: 'overdue', id: e.id, title: e.title, at });
  };
  for (const e of await queryEntities(tx, cctx, AGENDA_OVERDUE_DUE_QUERY)) {
    const due = strProp(e, 'orbis/due_date');
    if (!isTemplate(e) && due !== null) add(e, due);
  }
  for (const e of await queryEntities(tx, cctx, AGENDA_OVERDUE_START_QUERY)) {
    const s = strProp(e, 'orbis/start_at');
    const day = s === null ? null : localDay(s, tz);
    if (!isTemplate(e) && day !== null) add(e, day);
  }
  out.push(...[...merged.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)));
  return out;
}

/** Карта статуса в класс — та же, что задача 2 положит в `value_map` привязки `orbis/task`. */
/**
 * ЧТО МАСКИРУЕТСЯ И ПОЧЕМУ: эталон обязан быть сравним между прогонами И между четырьмя
 * состояниями (задача 18), у каждого из которых свой владелец, значит и свои id. Поэтому id
 * мира → читаемый слаг (`@task-open`), `ownerId` и оба таймстампа → метка рода. Всё прочее —
 * байт-в-байт: маска, съевшая лишнее, и есть способ, которым эталон перестаёт что-то значить.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MASKED_KEYS = new Set(['ownerId', 'createdAt', 'updatedAt']);

function namesOf(ownerId: string): ReadonlyMap<string, string> {
  return new Map(SURFACE_SLUGS.map((s) => [surfaceEntityId(ownerId, s).toLowerCase(), `@${s}`]));
}

function stabilize(value: unknown, names: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => stabilize(v, names));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = UUID_RE.test(k) ? (names.get(k.toLowerCase()) ?? '<uuid>') : k;
      out[key] = MASKED_KEYS.has(k) ? `<${k}>` : stabilize(v, names);
    }
    return out;
  }
  if (typeof value === 'string' && UUID_RE.test(value))
    return names.get(value.toLowerCase()) ?? '<uuid>';
  return value;
}

export function compareSnapshots(
  a: SurfaceSnapshot,
  b: SurfaceSnapshot,
): { surface: SnapshotSurface; diff: string }[] {
  const out: { surface: SnapshotSurface; diff: string }[] = [];
  for (const surface of SNAPSHOT_SURFACES) {
    const left = canonicalJson(a.surfaces[surface]);
    const right = canonicalJson(b.surfaces[surface]);
    if (left !== right) out.push({ surface, diff: `${a.state}: ${left}\n${b.state}: ${right}` });
  }
  return out;
}

export async function snapshotSurfaces(
  db: Db,
  ownerId: string,
  state: SurfaceState,
  today: string,
): Promise<SurfaceSnapshot> {
  const raw = await withIdentity(db, ownerId, async (tx) => {
    // `today` — ПАРАМЕТР снимка, а не системные часы: иначе эталон устаревал бы за сутки.
    const cctx: CompileCtx = { ...(await queryContext(tx, ownerId, null)), today };
    const all = await queryEntities(tx, cctx, 'sortBy=orbis/title:asc, limit=200');
    // Правило строки — ОБЩЕЕ (`@orbis/shared`, `M14_ROW_ELEMENTS` + `rowProjectionOf`): своей
    // копии у снимка больше нет (задача 7 сняла временную). Именно поэтому эталон `core/row`
    // не пересдавался: на встроенных аспектах декларация даёт ровно то, что давало правило
    // кодом, — и это и есть доказательство §С8-18 по строке списка.
    const rowsById: Record<string, RowProjection> = {};
    for (const e of all) rowsById[e.id] = rowProjectionOf(e, cctx.reg);
    const visible = await queryEntities(
      tx,
      cctx,
      'excludeBlocked=true, sortBy=orbis/title:asc, limit=200',
    );
    return {
      'planner/agenda': await agendaSurface(tx, cctx),
      'finance/budget-overview': await computeOverview(tx, ownerId, today.slice(0, 7), today),
      'core/row': rowsById,
      'core/exclude-blocked': visible.map((e) => e.id),
    } satisfies SurfacePayloads;
  });
  // Каст законен: `stabilize` меняет ЗНАЧЕНИЯ (uuid → слаг, таймстамп → метка), но не форму.
  const surfaces = stabilize(raw, namesOf(ownerId)) as SurfacePayloads;
  // Порядок списка — по СЛАГУ, и потому сортировка идёт ПОСЛЕ стабилизации, а не по сырым id:
  // id мира — uuidv5 от имени ВЛАДЕЛЬЦА, и тот же состав у состояния с другим владельцем
  // (задача 18) лёг бы в другом порядке — с baseline байт-в-байт не сошлось бы никогда.
  // Коллация БД тут тоже ни при чём: `sortBy=orbis/title` на кириллице зависит от локали
  // кластера. Состав — предмет §С8-20; порядок, значимый владельцу, живёт в Agenda и держится
  // датами.
  surfaces['core/exclude-blocked'].sort();
  return { state, surfaces };
}
