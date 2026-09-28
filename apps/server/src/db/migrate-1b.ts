// apps/server/src/db/migrate-1b.ts
// Разовый перевод данных среза 1б (спека §12, С1б-14, РП-16, Д-11) — прод-операция `migrate-1b` белого
// списка `scripts/ops.ts`; здесь вся логика и гейт подтверждения, в `ops.ts` — только обвязка (секрет из
// Ключницы, пул, печать), как у `reset-world`: файл `ops.ts` исполняется при импорте, и проверить тестом
// можно только то, что лежит здесь.
//
// ЧТО ДЕЛАЕТ. Граф старой формы (до 1б: шесть списков с тегом `smart-list` без аспектов, закреплённые в
// `pinnedEntities`, Финансы включены) переводится ОДНОЙ пачкой исполнителя — действием владельца по его
// слову (§0.2 п. 2: тихих записей нет, пишет только исполнитель с журналом):
//  - шесть списков → страницы поставки: аспекты «страница» и «поставка», свойства эталона, тег
//    `smart-list` снят; ТЕЛО НЕ МЕНЯЕТСЯ — правка владельца остаётся его правкой («изменено вами»);
//  - записи поставки: шаблон хоста, «Домой», «Записи», оболочка хоста с навигацией «Записи» + закреплённые
//    в их порядке без дублей;
//  - Финансы выключаются в маске (`module_set` в той же пачке — одна запись журнала).
// Прочие записи не трогаются. `pinnedEntities` и `installedViews` — тоже: колонки уходят позже (§8.6), и
// до того перевод остаётся проверяемым по ним.
//
// «ГОД» И «ЖИЗНЬ» (РП-35, В-9). Их тела в 1б переписаны словарём. Тело прод-списка, совпавшее с ПРЕЖНИМ
// эталоном (`LEGACY_ETALON_TEXTS`), — это «как в поставке» прежней версии: в запись ложатся печать и
// отпечаток прежнего эталона, и новый приходит обычным предложением «Обновлений». Положи мы нынешний
// эталон, неправленое тело стало бы «изменено вами», и «Принять все» обошло бы его стороной.
//
// РЕЖИМЫ. `--report` — только план по каждому графу (ничего не пишет; счётчики до/после — тест);
// `--apply --i-understand` — одна пачка на граф. Повтор на переведённом графе — «уже переведён», ноль
// записей: признак тот же, что у заведения графа (задача 12), — оболочка хоста есть (с архивной).
//
// UNDO ПЕРЕВОДА — НЕ ОТКАТ (R-21). Отмена пачки возвращает списки к старой форме, а записи поставки, в
// том числе оболочку хоста, лишь АРХИВИРУЕТ (обратное к `entity_create`). Архивная оболочка — признак
// «переведён/заведён» (Р-29), поэтому после Undo ни повторный `--apply`, ни вход владельца граф не чинят.
// Откат перевода — восстановление дампа, снятого перед `--apply` (`ops.ts dump`, ранбук §4.3); печать
// `--apply` об этом предупреждает.
//
// ПРЕДУСЛОВИЕ — ПЕРЕСЕВ РЕЕСТРОВ СРЕЗА 1Б. Код перевода — 1б, а реестр читается прод-графа: без аспекта
// «поставка» и свойств эталона канон тел и статусы в отчёте недостоверны, а пачка упала бы на неизвестном
// аспекте. Поэтому план проверяет снимок реестра и отказывает с понятным текстом (`assertSlice1bRegistry`).
//
// `--report` ИДЁТ В ТРАНЗАКЦИИ READ ONLY — «только чтение» стережёт сервер, а не докблок (как `check` в
// `ops.ts`): будущая запись, попавшая в план или в чтение реестра, упадёт, а не запишет в прод.
//
// СЧЁТЧИКИ R-7. Задача 5 перенесла поверхности и тулы Повестки в ядро (`planner/agenda` → `core/agenda`,
// `action_planner_postpone_overdue` → `action_core_postpone_overdue`), а словарь стережёт ЗАПИСЬ, не
// чтение: строки владельца на прежних именах реестр не роняют, но и не работают (подписку никто не
// обслуживает, действие не предлагается, а его правка и откат получат `VALIDATION`; рутина со старым тулом
// получит «неизвестный тул»). Перевод их не трогает — он не знает, чего хотел владелец, — а считает и
// печатает: ожидается ноль, не ноль — предупреждение владельцу до `--apply`.
import {
  APP_ASPECT,
  APP_HOME,
  APP_NAV,
  BUILTIN_PROPERTY_META,
  type GraphId,
  newId,
  PAGE_ASPECT,
  SUPPLY_ASPECT,
  SUPPLY_HASH,
  SUPPLY_KEY,
  SUPPLY_TEXT,
} from '@orbis/shared';
import {
  etalonOf,
  LEGACY_ETALON_TEXTS,
  SEED_SMART_LISTS,
  type SupplyEtalon,
  type SupplyKey,
} from '@orbis/shared/supply';
import { printAppProps, printPageRecord, supplyStatusOf } from '@orbis/shared/supply/print';
import { sql } from 'drizzle-orm';
import { ExecError, type ExecErrorCode } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { Identity } from '../identity';
import { effectiveRegistry } from '../registry/cache';
import { disabledExtensionsOf } from '../registry/extensions';
import type { RegistrySnapshot } from '../registry/load';
import type { ExecOperation } from '../routines/propose';
import { GARDENER_SLUG, seedRoutineId } from '../seed/gardener';
import { ROLLOVER_ROUTINE_SLUG } from '../seed/rollover-routine';
import { etalonHash } from '../supply/hash';
import {
  appEtalonProps,
  canonicalPageText,
  supplyCreateOps,
  supplyRecordId,
  supplyTextOf,
} from '../supply/records';
import type { Db } from './client';
import { type Tx, withIdentity } from './with-identity';

/** Подпись действия в журнале (В-4, решение вместе с владельцем — спека §12). */
export const MIGRATE_1B_LABEL =
  'Перевод данных среза 1б: записи поставки, навигация из закреплённых, списки → страницы, Финансы выключены';

/** Расширение, которое перевод выключает (спека §12: «Финансы → выключены в маске»). */
const DISABLED_BY_MIGRATION = 'finance';

/** Записи поставки, которых в графе старой формы нет: перевод их создаёт (порядок — порядок печати). */
const CREATED_KEYS = ['host-template', 'home', 'records', 'host-shell'] as const;

/** Тег, которым прежний онбординг помечал списки; в 1б его никто не читает (§9.4). */
const SMART_LIST_TAG = 'smart-list';

/** Рутины хоста, которые сеет только заведение НОВОГО графа (досевов нет, §8.6): отчёт их называет. */
const HOST_ROUTINE_SLUGS = { gardener: GARDENER_SLUG, rollover: ROLLOVER_ROUTINE_SLUG } as const;

/** Прежнее имя тула Повестки (до задачи 5) и снятые головы поверхностей (R-7). */
const OLD_POSTPONE_TOOL = 'action_planner_postpone_overdue';
const OLD_AGENDA_SURFACE = 'planner/agenda';
const RETIRED_SURFACE_HEADS = ['planner', 'ade', 'memory'] as const;

const sink = makeChatJournalSink();

/**
 * Состояние графа: `legacy` — есть список старой формы (на прежнем id без аспекта «поставка») и нет
 * оболочки хоста — переводить; `migrated` — оболочка хоста есть (граф переведён или заведён 1б);
 * `unseeded` — ни того, ни другого: мира нет, граф заведёт ближайший вход владельца (задача 12).
 */
export type Migrate1bState = 'legacy' | 'migrated' | 'unseeded';

export interface Migrate1bList {
  key: SupplyKey;
  id: string;
  title: string;
  archived: boolean;
  /** Чей эталон ляжет в запись: нынешний или прежний (тело совпало с прежним, РП-35). */
  etalon: 'current' | 'legacy';
  /** Статус записи после перевода — `supplyStatusOf` по тем же свойствам, что запишет пачка. */
  status: 'etalon' | 'edited';
}

/**
 * Предел «Навигации» оболочки — `max` типа свойства в реестре поставки (`orbis/app_nav`): навигация из
 * закреплённых длиннее него отвергла бы пачку перевода целиком (финал 1б, B1 m-1).
 */
export const NAV_MAX: number = (() => {
  const t = BUILTIN_PROPERTY_META.find((p) => p.id === APP_NAV)?.type as
    | { max?: number }
    | undefined;
  return typeof t?.max === 'number' ? t.max : Number.POSITIVE_INFINITY;
})();

export interface Migrate1bNavSkip {
  /** `null` — битый элемент закреплённых без строкового id. */
  id: string | null;
  title: string | null;
  /**
   * `duplicate` — уже в навигации; `archived` — запись в архиве; `missing` — записи в графе нет;
   * `overflow` — сверх предела «Навигации» (`NAV_MAX`): навигация длиннее отвергла бы всю пачку.
   */
  reason: 'duplicate' | 'archived' | 'missing' | 'overflow';
}

/** Рутина хоста в графе: есть, есть в архиве, нет. */
export type HostRoutineState = 'present' | 'archived' | 'absent';

export interface Migrate1bCounters {
  /** Собственные подписки графа на `planner/agenda`. */
  agendaSubscriptions: number;
  /** Собственные действия графа (всех статусов) с `offered_by.surface` на снятых головах. */
  retiredSurfaceActions: number;
  /** Записи графа (рутины) с `action_planner_postpone_overdue` в `orbis/allowed_tools`. */
  oldToolRoutines: number;
  /** Отложенные операции графа (pending любой судьбы), где стоит этот тул. */
  oldToolPending: number;
}

export interface Migrate1bPlan {
  graph: GraphId;
  state: Migrate1bState;
  /** Почему перевод невозможен (id записи поставки занят чужой записью); `null` — возможен. */
  blocked: string | null;
  create: Array<{ key: SupplyKey; title: string }>;
  lists: Migrate1bList[];
  /** Списки, которых в графе нет: перевод их не создаёт — поставка предложит «добавить» (§9.1 п. 3). */
  missingLists: SupplyKey[];
  /** Навигация оболочки хоста в её порядке. */
  nav: Array<{ id: string; title: string }>;
  navSkipped: Migrate1bNavSkip[];
  shellStatus: 'etalon' | 'edited' | null;
  maskBefore: string[];
  maskAfter: string[];
  counters: Migrate1bCounters;
  /**
   * Садовник словаря и «Перенос остатков». Их сеет только заведение нового графа, досевов нет (§8.6):
   * рутина, которой в графе нет к переводу, после него не появится никогда — решать до `--apply`.
   */
  hostRoutines: { gardener: HostRoutineState; rollover: HostRoutineState };
  /** Операции одной пачки `--apply`; пусто, если переводить нечего. */
  operations: ExecOperation[];
}

interface EntityRow {
  id: string;
  title: string;
  emoji: string | null;
  body: string | null;
  tags: string[];
  aspects: string[];
  props: Record<string, unknown>;
  archived: boolean;
}

async function count(tx: Tx, q: ReturnType<typeof sql>): Promise<number> {
  const rows = (await tx.execute(q)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

async function countersOf(tx: Tx, graph: GraphId): Promise<Migrate1bCounters> {
  const heads = `^(${RETIRED_SURFACE_HEADS.join('|')})/`;
  return {
    agendaSubscriptions: await count(
      tx,
      sql`SELECT count(*)::int AS n FROM subscription_definitions
           WHERE graph_id = ${graph}::uuid AND surface = ${OLD_AGENDA_SURFACE}`,
    ),
    // Все статусы, включая `deprecated`: откат такой строки тоже идёт через схему записи.
    retiredSurfaceActions: await count(
      tx,
      sql`SELECT count(*)::int AS n FROM action_definitions a
           WHERE a.graph_id = ${graph}::uuid
             AND jsonb_typeof(a.offered_by) = 'array'
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.offered_by) o
                          WHERE o ->> 'surface' ~ ${heads})`,
    ),
    oldToolRoutines: await count(
      tx,
      sql`SELECT count(*)::int AS n FROM entities
           WHERE graph_id = ${graph}::uuid AND props -> 'orbis/allowed_tools' ? ${OLD_POSTPONE_TOOL}`,
    ),
    // Тул лежит в сохранённом payload'е (`pending.tool` или внутри пачки) — ищется по тексту записи.
    oldToolPending: await count(
      tx,
      sql`SELECT count(*)::int AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
           WHERE t.graph_id = ${graph}::uuid AND m.metadata ? 'pending'
             AND strpos((m.metadata -> 'pending')::text, ${JSON.stringify(OLD_POSTPONE_TOOL)}) > 0`,
    ),
  };
}

async function rowsByIds(tx: Tx, graph: GraphId, ids: readonly string[]): Promise<EntityRow[]> {
  if (ids.length === 0) return [];
  // Сравнение по тексту id: в `pinnedEntities` может лежать что угодно, и приведение к uuid уронило бы
  // весь план на одной битой строке.
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, title, emoji, body, tags, aspects, props, archived FROM entities
     WHERE graph_id = ${graph}::uuid
       AND id::text IN (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})`)) as unknown as Array<EntityRow & { props: Record<string, unknown> | null }>;
  return rows.map((r) => ({ ...r, props: r.props ?? {} }));
}

/** Закреплённые в порядке `order` (при равенстве — в порядке хранения); битый элемент — `null`. */
function pinnedOrder(raw: unknown): Array<string | null> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p, i) => {
      const o = typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {};
      return {
        id: typeof o.id === 'string' ? o.id.toLowerCase() : null,
        order: typeof o.order === 'number' ? o.order : Number.MAX_SAFE_INTEGER,
        i,
      };
    })
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map((p) => p.id);
}

async function hostRoutinesOf(tx: Tx, graph: GraphId): Promise<Migrate1bPlan['hostRoutines']> {
  const state = async (slug: string): Promise<HostRoutineState> => {
    const rows = (await tx.execute(sql`
      SELECT archived FROM entities
       WHERE graph_id = ${graph}::uuid AND id = ${seedRoutineId(graph, slug)}::uuid`)) as unknown as Array<{
      archived: boolean;
    }>;
    const r = rows[0];
    return r === undefined ? 'absent' : r.archived ? 'archived' : 'present';
  };
  return {
    gardener: await state(HOST_ROUTINE_SLUGS.gardener),
    rollover: await state(HOST_ROUTINE_SLUGS.rollover),
  };
}

/** Аспекты и свойства реестра среза 1б, без которых перевод не на что опереть (предусловие — пересев). */
const SLICE_1B_ASPECTS = [PAGE_ASPECT, SUPPLY_ASPECT, APP_ASPECT] as const;
const SLICE_1B_PROPERTIES = [SUPPLY_KEY, SUPPLY_HASH, SUPPLY_TEXT, APP_HOME, APP_NAV] as const;

/**
 * Реестр графа — среза 1б (пересев сделан)? Иначе отказ с понятным текстом: оператор, запустивший
 * `migrate-1b` до `seed-registries` 1б, должен узнать порядок, а не получить статусы по старому реестру
 * или отказ пачки «неизвестный аспект».
 */
export function assertSlice1bRegistry(reg: RegistrySnapshot): void {
  const missing = [
    ...SLICE_1B_ASPECTS.filter((a) => !reg.aspects.has(a)),
    ...SLICE_1B_PROPERTIES.filter((p) => !reg.properties.has(p)),
  ];
  if (missing.length > 0) {
    throw new ExecError(
      'VALIDATION',
      `реестр графа — не среза 1б (нет ${missing.join(', ')}): сначала пересев реестров среза 1б ` +
        '(bun scripts/ops.ts seed-registries), затем migrate-1b',
      { missing },
    );
  }
}

function emptyPlan(
  graph: GraphId,
  state: Migrate1bState,
  mask: readonly string[],
  counters: Migrate1bCounters,
  hostRoutines: Migrate1bPlan['hostRoutines'],
): Migrate1bPlan {
  return {
    graph,
    state,
    blocked: null,
    create: [],
    lists: [],
    missingLists: [],
    nav: [],
    navSkipped: [],
    shellStatus: null,
    maskBefore: [...mask],
    maskAfter: [...mask],
    counters,
    hostRoutines,
    operations: [],
  };
}

/**
 * План перевода графа — ЧИСТЫЙ: только чтение (`tx` под идентичностью владельца), операции пачки
 * собираются из прочитанного и не исполняются. Его печатает `--report` и исполняет `applyMigrate1b`.
 */
export async function planMigrate1b(tx: Tx, graph: GraphId): Promise<Migrate1bPlan> {
  const counters = await countersOf(tx, graph);
  const mask = [...(await disabledExtensionsOf(tx, graph))];
  const hostRoutines = await hostRoutinesOf(tx, graph);

  const shell = await tx.execute(sql`
    SELECT 1 FROM entities WHERE graph_id = ${graph}::uuid
       AND props @> ${JSON.stringify({ [SUPPLY_KEY]: 'host-shell' })}::jsonb LIMIT 1`);
  if (shell.length > 0) return emptyPlan(graph, 'migrated', mask, counters, hostRoutines);

  const listKeys = SEED_SMART_LISTS.map((l) => l.slug);
  const listRows = await rowsByIds(
    tx,
    graph,
    listKeys.map((k) => supplyRecordId(graph, k)),
  );
  const listRow = (k: SupplyKey) => listRows.find((r) => r.id === supplyRecordId(graph, k));
  // Признак старой формы — тот же, что у заведения графа (`graphState`, задача 12).
  if (!listRows.some((r) => !r.aspects.includes(SUPPLY_ASPECT))) {
    return emptyPlan(graph, 'unseeded', mask, counters, hostRoutines);
  }

  const reg = await effectiveRegistry(tx, graph);
  assertSlice1bRegistry(reg);

  // Записи поставки, которые создаёт перевод, в графе старой формы не существуют; id, занятый чужой
  // записью, — состояние недостижимое, и молча пропустить его значило бы навигацию на чужую запись.
  const occupied = await rowsByIds(
    tx,
    graph,
    CREATED_KEYS.map((k) => supplyRecordId(graph, k)),
  );
  const blockedKeys = CREATED_KEYS.filter((k) =>
    occupied.some((r) => r.id === supplyRecordId(graph, k)),
  );
  const blocked =
    blockedKeys.length === 0
      ? null
      : `id записей поставки заняты чужими записями: ${blockedKeys.map((k) => `«${k}» (${supplyRecordId(graph, k)})`).join(', ')}`;

  // Ключ → id живой записи после перевода: создаваемые — их id; списки — если живы.
  const resolve = (k: SupplyKey): string | null => {
    if ((CREATED_KEYS as readonly string[]).includes(k)) return supplyRecordId(graph, k);
    const r = listRow(k);
    return r !== undefined && !r.archived ? r.id : null;
  };

  // ---- шесть списков → страницы поставки ----
  const lists: Migrate1bList[] = [];
  const listOps: ExecOperation[] = [];
  const missingLists: SupplyKey[] = [];
  for (const k of listKeys) {
    const row = listRow(k);
    if (row === undefined) {
      missingLists.push(k);
      continue;
    }
    // Список уже несёт аспект «поставка» — он переведён; второй раз свойства эталона не пишутся.
    if (row.aspects.includes(SUPPLY_ASPECT)) continue;
    const e = etalonOf(k) as Extract<SupplyEtalon, { kind: 'page' | 'template' }>;
    const legacyText = LEGACY_ETALON_TEXTS[k];
    const body = row.body ?? '';
    const legacy = legacyText !== undefined && body === canonicalPageText(legacyText, reg);
    const etalon = legacy ? { ...e, text: legacyText } : e;
    const supplyProps = {
      [SUPPLY_KEY]: k,
      [SUPPLY_HASH]: etalonHash(etalon),
      [SUPPLY_TEXT]: printPageRecord({
        title: e.title,
        emoji: e.emoji,
        body: canonicalPageText(etalon.text, reg),
      }),
    };
    const after = {
      aspects: [...row.aspects, PAGE_ASPECT, SUPPLY_ASPECT],
      body,
      title: row.title,
      emoji: row.emoji,
      props: { ...row.props, ...supplyProps },
    };
    lists.push({
      key: k,
      id: row.id,
      title: row.title,
      archived: row.archived,
      etalon: legacy ? 'legacy' : 'current',
      status: supplyStatusOf(after) === 'etalon' ? 'etalon' : 'edited',
    });
    const attach = [PAGE_ASPECT, SUPPLY_ASPECT].filter((a) => !row.aspects.includes(a));
    // Тело в правку не входит вовсе: перевод не меняет текст владельца ни на байт.
    listOps.push({
      tool: 'entity_update',
      input: {
        id: row.id,
        aspects: { attach },
        props: supplyProps,
        ...(row.tags.includes(SMART_LIST_TAG) && {
          tags: row.tags.filter((t) => t !== SMART_LIST_TAG),
        }),
      },
    });
  }

  // ---- навигация оболочки: «Записи» + закреплённые по `order`, без дублей и архивных, в пределе ----
  const settings = (await tx.execute(sql`
    SELECT "pinnedEntities" AS pinned FROM user_settings WHERE graph_id = ${graph}::uuid`)) as unknown as Array<{
    pinned: unknown;
  }>;
  const pinned = pinnedOrder(settings[0]?.pinned);
  const pinnedRows = await rowsByIds(
    tx,
    graph,
    pinned.filter((id): id is string => id !== null),
  );
  const recordsId = supplyRecordId(graph, 'records');
  const nav: Array<{ id: string; title: string }> = [{ id: recordsId, title: 'Записи' }];
  const navSkipped: Migrate1bNavSkip[] = [];
  for (const id of pinned) {
    const row = id === null ? undefined : pinnedRows.find((r) => r.id === id);
    if (row === undefined) navSkipped.push({ id, title: null, reason: 'missing' });
    else if (nav.some((n) => n.id === row.id))
      navSkipped.push({ id: row.id, title: row.title, reason: 'duplicate' });
    // Архивная цель в навигации — отказ `цель архивна` всей пачки; закреплённая архивная запись
    // в сайдбаре не показывалась, так что из навигации владелец ничего не теряет.
    else if (row.archived) navSkipped.push({ id: row.id, title: row.title, reason: 'archived' });
    // Предел «Навигации» (финал 1б, B1 m-1): длиннее — отказ `VALIDATION` всей пачки на `--apply`, и
    // перевод графа невозможен без ручной правки. Лишнее отчёт называет до `--apply`.
    else if (nav.length >= NAV_MAX)
      navSkipped.push({ id: row.id, title: row.title, reason: 'overflow' });
    else nav.push({ id: row.id, title: row.title });
  }

  // ---- записи поставки: эталон кода, у оболочки навигация — из закреплённых ----
  const shellEtalon = etalonOf('host-shell') as Extract<SupplyEtalon, { kind: 'app' }>;
  const navIds = nav.map((n) => n.id);
  const createOps = supplyCreateOps(graph, [...CREATED_KEYS], resolve, reg).map((op) => {
    const input = op.input as { id: string; props: Record<string, unknown> };
    if (input.id !== supplyRecordId(graph, 'host-shell')) return op;
    return { ...op, input: { ...op.input, props: { ...input.props, [APP_NAV]: navIds } } };
  });
  // «Как в поставке», если навигация совпала с эталоном (закреплённые = эталон), иначе «изменено вами».
  const shellStatus =
    printAppProps({
      title: shellEtalon.title,
      emoji: shellEtalon.emoji,
      props: { ...appEtalonProps(shellEtalon, resolve), [APP_NAV]: navIds },
    }) === supplyTextOf(shellEtalon, reg, resolve)
      ? 'etalon'
      : 'edited';

  const maskOff = mask.includes(DISABLED_BY_MIGRATION);
  const maskOps: ExecOperation[] = maskOff
    ? []
    : [{ tool: 'module_set', input: { module: DISABLED_BY_MIGRATION, enabled: false } }];

  return {
    graph,
    state: 'legacy',
    blocked,
    create: CREATED_KEYS.map((k) => ({ key: k, title: etalonOf(k).title })),
    lists,
    missingLists,
    nav,
    navSkipped,
    shellStatus,
    maskBefore: mask,
    maskAfter: maskOff ? mask : [...mask, DISABLED_BY_MIGRATION],
    counters,
    hostRoutines,
    // Порядок пачки: списки, затем страницы поставки, затем оболочка (ссылается на них), затем маска.
    operations: [...listOps, ...createOps, ...maskOps],
  };
}

export type Migrate1bOutcome =
  | { status: 'migrated'; plan: Migrate1bPlan; actionId: string }
  | { status: 'already' | 'unseeded'; plan: Migrate1bPlan };

/**
 * Перевести граф владельца: план → одна пачка исполнителя (механизм `supply` — единственный писатель
 * свойств эталона, флаг `writer` задачи 9; `actorKind: 'owner'` — `module_set` операция владельца;
 * `source: 'system'` — перевод запускает оператор прод-процедурой, а не экран) с подписью В-4.
 * Переведённый граф — «уже переведён», граф без мира — «не заведён»: оба без единой записи.
 */
export async function applyMigrate1b(
  db: Db,
  who: Identity,
  opts: { clock?: () => Date } = {},
): Promise<Migrate1bOutcome> {
  const plan = await withIdentity(db, who, (tx) => planMigrate1b(tx, who.graph));
  if (plan.state !== 'legacy')
    return { status: plan.state === 'migrated' ? 'already' : 'unseeded', plan };
  if (plan.blocked !== null) {
    throw new ExecError('INVARIANT', `граф ${who.graph} не переведён: ${plan.blocked}`, {
      graph: who.graph,
    });
  }
  const r = await execute(
    db,
    {
      identity: who,
      actorKind: 'owner',
      source: 'system',
      mechanism: 'supply',
      batchId: newId(),
      batchLabel: MIGRATE_1B_LABEL,
      operations: plan.operations,
      ...(opts.clock !== undefined && { clock: opts.clock }),
    },
    { sink },
  );
  if (!r.ok) throw new ExecError(r.error.code as ExecErrorCode, r.error.message, r.error.details);
  return { status: 'migrated', plan, actionId: r.actionId };
}

const STATUS_WORD = { etalon: 'как в поставке', edited: 'изменено вами' } as const;
const ROUTINE_WORD = { present: 'есть', archived: 'в архиве', absent: 'нет' } as const;
const SKIP_WORD = {
  duplicate: 'дубль',
  archived: 'в архиве',
  missing: 'записи нет',
  overflow: `сверх предела навигации (${NAV_MAX} разделов)`,
} as const;

/** План графа — строками, как их прочтёт владелец. */
export function formatMigrate1bPlan(p: Migrate1bPlan): string[] {
  const out = [`граф ${p.graph}:`];
  if (p.state === 'migrated') out.push('  уже переведён (оболочка хоста есть) — переводить нечего');
  if (p.state === 'unseeded') {
    out.push('  не заведён (мира нет) — его заведёт ближайший вход владельца; переводить нечего');
  }
  if (p.state === 'legacy') {
    if (p.blocked !== null) out.push(`  ПЕРЕВОД НЕВОЗМОЖЕН: ${p.blocked}`);
    out.push(
      `  создаются записи поставки: ${p.create.map((c) => `«${c.title}» (${c.key})`).join(', ')}`,
    );
    out.push('  списки → страницы поставки (тег smart-list снимается, тело не меняется):');
    for (const l of p.lists) {
      const word =
        l.etalon === 'legacy' && l.status === 'etalon'
          ? 'как в поставке прежней версии (новый эталон придёт предложением в «Обновлениях»)'
          : STATUS_WORD[l.status];
      out.push(`    «${l.title}» — ${word}${l.archived ? '; в архиве' : ''}`);
    }
    for (const k of p.missingLists) {
      out.push(`    ${k} — списка в графе нет: не создаётся, поставка предложит его добавить`);
    }
    out.push(`  навигация оболочки хоста: ${p.nav.map((n) => n.title).join(', ')}`);
    for (const s of p.navSkipped) {
      const what =
        s.title !== null ? `«${s.title}»` : (s.id ?? 'битый элемент закреплённых (без id)');
      out.push(`    пропущено из закреплённых: ${what} — ${SKIP_WORD[s.reason]}`);
    }
    if (p.shellStatus !== null) out.push(`  оболочка хоста: ${STATUS_WORD[p.shellStatus]}`);
    out.push(
      `  маска выключенных расширений: [${p.maskBefore.join(', ')}] → [${p.maskAfter.join(', ')}]`,
    );
    out.push('  закреплённые и installedViews не трогаются; прочие записи графа не трогаются');
  }
  const h = p.hostRoutines;
  out.push(
    `  рутины хоста: садовник — ${ROUTINE_WORD[h.gardener]}, «Перенос остатков» — ${ROUTINE_WORD[h.rollover]}` +
      (h.gardener === 'present' && h.rollover === 'present'
        ? ''
        : ' (после перевода недостающую никто не посеет: досевов нет, §8.6)'),
  );
  const c = p.counters;
  out.push(
    `  подписок на planner/agenda: ${c.agendaSubscriptions}; действий на снятых поверхностях ` +
      `(${RETIRED_SURFACE_HEADS.map((h) => `${h}/`).join(', ')}): ${c.retiredSurfaceActions}; ` +
      `рутин с ${OLD_POSTPONE_TOOL}: ${c.oldToolRoutines}; отложенных операций с ним: ${c.oldToolPending}`,
  );
  if (c.agendaSubscriptions > 0) {
    out.push(
      `  ВНИМАНИЕ: подписок графа на поверхности ${OLD_AGENDA_SURFACE} — ${c.agendaSubscriptions}: ` +
        'поверхность переименована в core/agenda, такие подписки никто не обслуживает',
    );
  }
  if (c.retiredSurfaceActions > 0) {
    out.push(
      `  ВНИМАНИЕ: действий графа на снятых поверхностях — ${c.retiredSurfaceActions}: ` +
        'они не предлагаются, их правка и откат получат VALIDATION',
    );
  }
  if (c.oldToolRoutines > 0) {
    out.push(
      `  ВНИМАНИЕ: рутин со старым тулом ${OLD_POSTPONE_TOOL} — ${c.oldToolRoutines}: ` +
        'тул переименован в action_core_postpone_overdue, для рутины он «неизвестный»',
    );
  }
  if (c.oldToolPending > 0) {
    out.push(
      `  ВНИМАНИЕ: отложенных операций со старым тулом ${OLD_POSTPONE_TOOL} — ${c.oldToolPending}: ` +
        'их «Принять» получит «неизвестный тул»',
    );
  }
  return out;
}

// ---------------------------------------------------------------- обвязка ops.ts

export type Migrate1bMode = 'report' | 'apply';

export type Migrate1bGate =
  | { proceed: true; mode: Migrate1bMode }
  | { proceed: false; code: number; lines: string[] };

const USAGE = [
  '  bun scripts/ops.ts migrate-1b --report                  # только план, ничего не пишет',
  '  bun scripts/ops.ts migrate-1b --apply --i-understand    # перевод: одна пачка на граф',
];

/**
 * Подтверждение: `--report` — отдельно; `--apply` — только вместе с `--i-understand`. Всё прочее —
 * отказ кодом 2 ДО открытия базы. Незнакомый флаг — отказ, а не «пропустим» (как у `resetWorldGate`):
 * опечатка иначе означала бы согласие, которого не давали. Слова-значения у `--i-understand` нет:
 * перевод не сносит данных (тела списков не трогаются, записи создаются, маска — одна строка), а
 * `--report` рядом — способ увидеть всё до записи. Страховка перевода — НЕ Undo (R-21, шапка файла), а
 * дамп, снятый перед `--apply` по ранбуку.
 */
export function migrate1bGate(args: readonly string[]): Migrate1bGate {
  const known = new Set(['--report', '--apply', '--i-understand']);
  const unknown = args.find((a) => !known.has(a));
  const refuse = (line: string): Migrate1bGate => ({
    proceed: false,
    code: 2,
    lines: [line, ...USAGE],
  });
  if (unknown !== undefined) return refuse(`migrate-1b: неизвестный аргумент «${unknown}».`);
  const report = args.includes('--report');
  const apply = args.includes('--apply');
  const understand = args.includes('--i-understand');
  if (report && (apply || understand)) {
    return refuse('migrate-1b: --report не сочетается с --apply/--i-understand — выберите режим.');
  }
  if (report) return { proceed: true, mode: 'report' };
  if (apply && understand) return { proceed: true, mode: 'apply' };
  if (apply) {
    return refuse('migrate-1b: --apply пишет в граф — нужно подтверждение --i-understand.');
  }
  return refuse('migrate-1b: укажите режим.');
}

/** Ввод-вывод операции — инъекция, как у `reset-world` (тест без Ключницы и без прода). */
export interface Migrate1bIo {
  /** DSN. В `ops.ts` — чтение Ключницы; значение не логируется ни при каком исходе. */
  readDsn(): string;
  /** Пул. Зовётся ТОЛЬКО после подтверждения — гарантия «отказ до любого касания базы». */
  openDb(dsn: string): { db: Db; close(): Promise<void> };
  /** Пары «граф, владелец» (в `ops.ts` — `identitiesForScheduler`: графы со строкой настроек). */
  identities(db: Db): Promise<Identity[]>;
  log(line: string): void;
  error(line: string): void;
}

/** Одна строка печати `--apply` (R-21): Undo пачки не возвращает граф в исходное состояние. */
export const UNDO_WARNING =
  'ВНИМАНИЕ: Undo этого перевода — НЕ откат (списки вернутся к старой форме, записи поставки уйдут в архив, ' +
  'а граф останется «переведённым»); откат — восстановление дампа, снятого перед --apply (ранбук §4.3).';

/**
 * План для `--report` — в транзакции READ ONLY (M-1 гейта): «только чтение» стережёт сервер, как у `check`
 * в `ops.ts`. Переключение в read-only законно и после `set_config`/`SET LOCAL ROLE` в `withIdentity`
 * (запрещён только обратный переход после первого снимка). `planner` — инъекция теста: пишущий план
 * обязан упасть, а не записать.
 */
export async function reportMigrate1b(
  db: Db,
  who: Identity,
  planner: (tx: Tx, graph: GraphId) => Promise<Migrate1bPlan> = planMigrate1b,
): Promise<Migrate1bPlan> {
  return withIdentity(db, who, async (tx) => {
    await tx.execute(sql`SET LOCAL transaction_read_only = on`);
    return planner(tx, who.graph);
  });
}

/**
 * Операция целиком: подтверждение → по каждому графу план (и в `--apply` — пачка) → печать. Код 0 —
 * всё прошло; 1 — хоть один граф не переведён или остался без отчёта (прочие графы идут дальше: пачки
 * независимы); 2 — отказ подтверждения.
 */
export async function runMigrate1b(args: readonly string[], io: Migrate1bIo): Promise<number> {
  const gate = migrate1bGate(args);
  if (!gate.proceed) {
    for (const line of gate.lines) io.error(line);
    return gate.code;
  }
  const { db, close } = io.openDb(io.readDsn());
  let failed = 0;
  try {
    const whos = await io.identities(db);
    if (whos.length === 0) io.log('графов со строкой настроек нет — переводить нечего');
    if (gate.mode === 'apply') io.log(UNDO_WARNING);
    for (const who of whos) {
      // Сбой одного графа печатается и считается в код 1; прочие графы отчитываются/переводятся.
      if (gate.mode === 'report') {
        try {
          const plan = await reportMigrate1b(db, who);
          for (const line of formatMigrate1bPlan(plan)) io.log(line);
        } catch (e) {
          failed += 1;
          io.error(
            `граф ${who.graph}: отчёт не собран — ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        continue;
      }
      try {
        const out = await applyMigrate1b(db, who);
        for (const line of formatMigrate1bPlan(out.plan)) io.log(line);
        if (out.status === 'migrated') {
          io.log(`  переведён одной пачкой: действие ${out.actionId} («${MIGRATE_1B_LABEL}»)`);
        } else {
          io.log(
            `  ${out.status === 'already' ? 'уже переведён' : 'не заведён'} — ничего не записано`,
          );
        }
      } catch (e) {
        failed += 1;
        io.error(`граф ${who.graph}: не переведён — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (gate.mode === 'report') io.log('\nРежим --report: ничего не записано.');
  } finally {
    await close();
  }
  return failed === 0 ? 0 : 1;
}
