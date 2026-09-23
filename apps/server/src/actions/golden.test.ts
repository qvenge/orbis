// apps/server/src/actions/golden.test.ts
// ПРИЁМКА §С8-27: действие-декларация даёт БАЙТ-В-БАЙТ тот же результат, что код, который оно
// заменяет. Снимок — {состояние мира, строка журнала} с нормализованными id (Р-12).
//
// ЭТАЛОН СНИМАЕТСЯ ОДИН РАЗ и дальше ЗАЩИЩАЕТ (тот же жанр и тот же запрет, что у
// `tools/registry-golden.test.ts:11-20`): «записать что вышло» запрещено, расхождение
// разбирается, намеренная правка пересдаётся ОТДЕЛЬНЫМ движением с объяснением в коммите.
// Автообновления нет намеренно.
//
// ПРОЦЕДУРА СНЯТИЯ (новый случай, не правка старого): временная тест-снималка печатает объект
// случая `JSON.stringify({name, action, params, before, after, journal}, null, 2)` → объект
// вставляется в `cases` файла `apps/server/test/golden/actions.json` → `bunx biome check --write
// apps/server/test/golden/actions.json` (форматтер репозитория раскладывает JSON по-своему;
// сверка идёт по `canonicalJson` РАЗОБРАННОГО JSON, поэтому форматирование смысла не меняет).
// Снималка после вставки СНИМАЕТСЯ из файла — эталон, который умеет переписывать сам себя,
// ничего не защищает.
//
// ПОЧЕМУ ДВА ВЛАДЕЛЬЦА, А НЕ ОДИН. Сравниваются ДВА ПРОГОНА одной фикстуры, и оба пишут в граф;
// на одном владельце второй прогон видел бы последствия первого. Мир поэтому сеется дважды, у
// двух владельцев, id — `uuidv5` от владельца и слага (образец `test/surfaces.ts:76`), а снимок
// стабилизируется: id мира → слаг, graphId и оба таймстампа → метка рода. Только после этого две
// половины вообще сравнимы.
//
// ПОЧЕМУ ВЛАДЕЛЬЦЫ — КОНСТАНТЫ, А НЕ `freshGraph()`. Порядок в снимке местами решает uuid:
// входящие рёбра сортируются по `source_id`, цели map-действия — по `e.id` (`queryTargets`,
// `actions/resolve.ts`), и с ними — порядок операций в строке журнала. Со случайным владельцем
// эти порядки менялись бы от прогона к прогону, и эталон мигал бы. Модульная `mintGraph()` с
// `uuidv5` законна как константа (Ф-Б2-9): строку графа доводит до базы `truncateAll()` в
// `beforeAll`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  BUILTIN_ACTION_DEFS,
  batchAuditMessageId,
  canonicalJson,
  type GraphId,
  newId,
  ORBIS_NAMESPACE,
  recurringInstanceId,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import GOLDEN from '../../test/golden/actions.json';
import {
  appDb,
  executeWithFixtureCategories as execute,
  freshGraph,
  mintGraph,
  personal,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { confirmPurchase } from '../budget/plan-to-fact';
import { withIdentity } from '../db/with-identity';
import { makeChatJournalSink } from '../executor/journal';
import { stateDelta } from '../executor/props';
import type { ActionCard, ActionRecord, WireEntity } from '../executor/types';
import { undoAction } from '../executor/undo';
import { classifyToolCall } from '../policy/confirmation';
import { materializeInstances } from '../recurring/materialize';
import { effectiveRegistry } from '../registry/cache';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import { resolveAction } from './resolve';
import { actionCallFacts } from './run';

requireEnv();
const { db, client } = appDb();
const sink = makeChatJournalSink();

/**
 * Владельцы половин: `legacy` — сегодняшний код, `action` — декларация конвейером (`resolveAction`
 * + `execute`), `dispatch` — та же декларация вызовом `run_action` из чата; `tasks` — мир
 * map-действия `postpone_overdue` (свой владелец: откат пакета не должен видеть переводов покупки).
 */
const OWNER = {
  legacy: mintGraph(uuidv5('actions-golden:legacy', ORBIS_NAMESPACE)),
  action: mintGraph(uuidv5('actions-golden:action', ORBIS_NAMESPACE)),
  dispatch: mintGraph(uuidv5('actions-golden:dispatch', ORBIS_NAMESPACE)),
  tasks: mintGraph(uuidv5('actions-golden:tasks', ORBIS_NAMESPACE)),
} as const;
/** id мира — от владельца и слага: воспроизводим без обращения к БД (`surfaces.ts:76`). */
const worldId = (owner: GraphId, slug: string): string =>
  uuidv5(`${owner.toLowerCase()}:actions-golden:${slug}`, ORBIS_NAMESPACE);
/** batch одного прогона — тоже от владельца: `action.id === batchId` (executor.ts:701). */
const batchOf = (owner: GraphId, slug: string): string => worldId(owner, `batch:${slug}`);

interface GoldenState {
  id: string;
  title: string;
  archived: boolean;
  aspects: string[];
  props: Record<string, unknown>;
  /** Входящие рёбра: переселект конверта бюджет-хуком A4 виден ТОЛЬКО здесь. */
  incoming: Array<{ role: string; source: string }>;
}

const SLUGS = ['envelope-july', 'envelope-aug', 'purchase', 'task-1', 'task-2', 'task-3'] as const;
/**
 * Слаг категории — ссылочная цель `orbis/finance_category` у конвертов и покупки. В снимок
 * сама категория не входит (её никто не правит), но её id едет в `props` снимаемых строк, и без
 * имени он лёг бы в эталон безымянным `<uuid>`.
 */
const CATEGORY = 'category';
/**
 * Слаги пачек, у которых нет «своей» строки мира: `postpone` — вызов map-действия по трём задачам.
 * Пачки одиночных вызовов названы слагом цели (`@batch:purchase`).
 */
const BATCH_SLUGS = ['postpone'] as const;
// `UUID_RE`, `MASKED_KEYS`, `namesOf`, `stabilize` — КОПИЯ `apps/server/test/surfaces.ts:345-376`
// (тот же довод «маска, съевшая лишнее, и есть способ, которым эталон перестаёт что-то значить»),
// с двумя правками: `MASKED_KEYS` += `graph_id`/`actor_user_id` (строка журнала несёт их snake_case),
// а словарь имён строится из `SLUGS` этой фикстуры и `batchOf` плюс `owner → '<owner>'`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MASKED_KEYS = new Set(['graphId', 'graph_id', 'actor_user_id', 'createdAt', 'updatedAt']);
function namesOf(owner: GraphId): ReadonlyMap<string, string> {
  const m = new Map<string, string>([[owner.toLowerCase(), '<owner>']]);
  m.set(worldId(owner, CATEGORY).toLowerCase(), `@${CATEGORY}`);
  for (const s of SLUGS) {
    m.set(worldId(owner, s).toLowerCase(), `@${s}`);
    m.set(batchOf(owner, s).toLowerCase(), `@batch:${s}`);
  }
  for (const s of BATCH_SLUGS) m.set(batchOf(owner, s).toLowerCase(), `@batch:${s}`);
  return m;
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

async function snapshotWorld(owner: GraphId, slugs: readonly string[]): Promise<GoldenState[]> {
  return await withIdentity(db, personal(owner), async (tx) => {
    const out: GoldenState[] = [];
    for (const slug of slugs) {
      const id = worldId(owner, slug);
      const rows = (await tx.execute(sql`
        SELECT e.id, e.title, e.archived, e.aspects, e.props,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('role', r.role, 'source', r.source_id)
                                     ORDER BY r.role, r.source_id)
                    FROM relations r WHERE r.target_id = e.id), '[]'::jsonb) AS incoming
        FROM entities e WHERE e.id = ${id}
      `)) as unknown as GoldenState[];
      const row = rows[0];
      if (row === undefined) throw new Error(`мир не сеян: ${slug}`);
      out.push(row);
    }
    return out;
  });
}

/** Строка журнала по детерминированному PK audit-сообщения (§7.8). */
async function journalOf(
  owner: GraphId,
  batchId: string,
): Promise<{ action: ActionRecord; card: ActionCard }> {
  const found = await withIdentity(db, personal(owner), (tx) =>
    sink.findByAuditId(tx, batchAuditMessageId(owner, batchId)),
  );
  if (found === undefined) throw new Error(`audit-сообщение ${batchId} не найдено`);
  return { action: found.action, card: found.card as ActionCard };
}

const caseOf = (name: string) => {
  const found = (GOLDEN as { cases: Array<{ name: string }> }).cases.find((c) => c.name === name);
  if (found === undefined) throw new Error(`в эталоне нет случая «${name}»`);
  return found as {
    name: string;
    before: unknown;
    after: unknown;
    journal: unknown;
    action: string;
    params: Record<string, unknown>;
  };
};

/**
 * Мир фикстуры: два конверта одной категории (июль и август), ручная planned-покупка на июль и
 * три просроченные задачи. Каждая строка — `entity_create` исполнителем с явным id (клиентский
 * uuid §7.8 принимает), `source:'ui'`, БЕЗ синка: audit-шум сева в снимок не нужен. Конверты
 * сеются ДО покупки — бюджет-хук A4 привязывает её к июльскому конверту уже на создании.
 */
async function seedWorld(owner: GraphId): Promise<void> {
  const create = async (slug: string, input: Record<string, unknown>): Promise<void> => {
    const r = await execute(db, {
      identity: personal(owner),
      actorKind: 'owner',
      source: 'ui',
      operations: [
        { tool: 'entity_create', input: { id: worldId(owner, slug), tags: [], ...input } },
      ],
    });
    if (!r.ok) throw new Error(`сев ${slug}: ${r.error.code} — ${r.error.message}`);
  };
  const category = worldId(owner, CATEGORY);
  const envelope = (start: string, end: string) => ({
    title: `Конверт ${start}`,
    props: {
      'orbis/finance_category': category,
      'orbis/limit': '30000.00',
      'orbis/currency': 'RUB',
      'orbis/period_start': start,
      'orbis/period_end': end,
    },
    aspects: ['orbis/budget'],
  });
  await create('envelope-july', envelope('2026-07-01', '2026-07-31'));
  await create('envelope-aug', envelope('2026-08-01', '2026-08-31'));
  await create('purchase', {
    title: 'Купить кроссовки',
    props: {
      'orbis/amount': '8000.00',
      'orbis/currency': 'RUB',
      'orbis/direction': 'expense',
      'orbis/finance_category': category,
      'orbis/occurred_on': '2026-07-15',
      'orbis/planned': true,
    },
    aspects: ['orbis/financial'],
  });
  for (const n of [1, 2, 3]) {
    await create(`task-${n}`, {
      title: `Задача ${n}`,
      props: { 'orbis/task_status': 'inbox', 'orbis/due_date': `2026-06-0${n}` },
      aspects: ['orbis/task'],
    });
  }
}

type Journal = { action: ActionRecord; card: ActionCard };
type Half = keyof typeof OWNER;

/**
 * Снимки, собранные `beforeAll` ПОСЛЕ сева и прогона всех половин: тела тестов читают собранное,
 * походов в БД в телах нет (образец `test/gate-c8-18.test.ts`). Заполняются ровно одним
 * `beforeAll` файла.
 */
const BEFORE: Record<Half, GoldenState[]> = { legacy: [], action: [], dispatch: [], tasks: [] };
const AFTER: Record<Half, GoldenState[]> = { legacy: [], action: [], dispatch: [], tasks: [] };
/** Уровень §7.10 вызова `postpone_overdue` — пиннится отдельным `expect` (шаг 8). */
let tasksLevel: string | undefined;
const JOURNALS = new Map<Half, Journal>();
const journal = (half: Half): Journal => {
  const found = JOURNALS.get(half);
  if (found === undefined) throw new Error(`строка журнала половины ${half} не собрана`);
  return found;
};

/** Снимаемые строки случая `plan-to-fact`: покупка и оба конверта (переселект виден по рёбрам). */
const PURCHASE_WORLD = ['envelope-july', 'envelope-aug', 'purchase'] as const;
const OCCURRED_ON = '2026-08-10';
/** Полдень по Москве (зона владельца по умолчанию): «сегодня» вызова из чата — ровно OCCURRED_ON. */
const NOW = new Date(`${OCCURRED_ON}T09:00:00.000Z`);
/** Задачи map-действия: просрочены к OCCURRED_ON (сроки 2026-06-01…03), перенос — на эту дату. */
const TASKS_WORLD = ['task-1', 'task-2', 'task-3'] as const;
const POSTPONE_TO = '2026-09-01';

/** Контекст вызова из чата от владельца — поверхность модели (`run_action`). */
const chatCtx = (owner: GraphId): ToolCallCtx => ({
  db,
  identity: personal(owner),
  actorKind: 'owner',
  source: 'chat',
  explicitCommand: false,
  clock: () => NOW,
});

/**
 * Законные расхождения строки журнала (§Б6-4 ревизии 4). Список ЗАКРЫТ: расширять его можно
 * только доказанным фактом спеки, а не наблюдением «тест покраснел». Состояние графа расхождений
 * не имеет ВОВСЕ — в этом и весь смысл приёмки.
 */
const EXPECTED_DIFFS: Record<string, string> = {
  'action.type': '§Б6-4: строка действия — `action`, а не `batch`',
  'action.action_id': '§Б6-4: новый условный ключ — какое действие исполнено',
  'action.module': '§Б6-4: автор-приложение (концепция страниц §7)',
  'card.title': '§Б6-4: «Действие «…»» вместо «batch: операций — N»',
};
/**
 * Значения четырёх расхождений — пин литералом. `applyDiff` отвечает только «разошлось ли», а
 * расхождение «не в ту сторону» (`module: 'planner'`, чужая подпись) тоже разошлось бы.
 */
const DIFF_VALUES = {
  'action.type': 'action',
  'action.action_id': 'finance/plan-to-fact',
  'action.module': 'finance',
  'card.title': 'Действие «План → факт»',
} as const;

/**
 * Переносит ЭТО и только это поле из нового снимка в эталонный; `true` — если значение
 * действительно разошлось (расхождение, которого нет, — тоже дефект: список перестал что-то
 * значить). Отсутствие ключа — такое же значение, как любое другое: у голой пачки `action_id`
 * нет вовсе, и появление ключа и есть расхождение.
 */
function applyDiff(
  golden: Record<string, unknown>,
  path: string,
  mine: Record<string, unknown>,
): boolean {
  const keys = path.split('.');
  const last = keys.pop();
  if (last === undefined) throw new Error(`пустой путь расхождения: ${path}`);
  let g = golden;
  let m = mine;
  for (const k of keys) {
    g = g[k] as Record<string, unknown>;
    m = m[k] as Record<string, unknown>;
  }
  const differs =
    Object.hasOwn(g, last) !== Object.hasOwn(m, last) ||
    canonicalJson(g[last] ?? null) !== canonicalJson(m[last] ?? null);
  if (Object.hasOwn(m, last)) g[last] = m[last];
  else delete g[last];
  return differs;
}

/** Значение по пути `a.b` — для пина `DIFF_VALUES`. */
function at(value: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], value);
}

/**
 * ЖУРНАЛ ДЕКЛАРАЦИИ ПРОТИВ ЭТАЛОНА КОДА: каждое из четырёх расхождений обязано быть (и иметь
 * своё значение), после их переноса строки равны побайтно. Пятое расхождение (`operations`,
 * `inverse`, `mechanism`, `entity_id`, `source`) валит последний `expect` и разбирается, а не
 * дописывается в список.
 */
function expectJournalWithinDiffs(mineRaw: Journal, names: ReadonlyMap<string, string>): void {
  const mine = stabilize(mineRaw, names) as Record<string, unknown>;
  const golden = structuredClone(caseOf('plan-to-fact/legacy').journal) as Record<string, unknown>;
  for (const [path, why] of Object.entries(EXPECTED_DIFFS)) {
    expect([path, why, applyDiff(golden, path, mine)]).toEqual([path, why, true]);
  }
  for (const [path, value] of Object.entries(DIFF_VALUES)) {
    expect([path, at(mine, path)]).toEqual([path, value]);
  }
  expect(canonicalJson(mine)).toBe(canonicalJson(golden));
}

/**
 * ПЯТЬ ТЕКСТОВ СХЛОПЫВАЮТСЯ В ОДИН — это законное расхождение, а не потеря. У кода пять отказов
 * `INVARIANT {invariant:'not_planned_purchase'}` с разными текстами (`plan-to-fact.ts:78-97`); у
 * действия предусловие ОДНО (§Б6-1 даёт декларации ровно одно `precondition`), и его ложность —
 * один `CONFLICT precondition_failed`. Конъюнкты при этом сохранены все пять и проверяются
 * поимённо — ниже, каждый своей порчей.
 *
 * ДВА ПЕРЕВОДА АДРЕСАЦИИ названы отдельно: «есть аспект `orbis/financial`» выражается КОНТРАКТОМ
 * (`class(orbis/money-movement) ∈ {outflow, inflow}`) — формы «принадлежность аспекту» в языке E
 * нет вовсе (`verify-b2-actions.md` «(г)»); «аспект `orbis/schedule` ∧ есть `orbis/recurrence`» —
 * классом `template` контракта `orbis/recurrence` (та же эквивалентность, что уже принята
 * Р-И-20 для задачи 4).
 */
const PRECONDITION_CONJUNCTS = [
  ['не-financial', 'class(orbis/money-movement) ∈ {outflow, inflow}'],
  ['архивная', 'not(orbis/archived = true)'],
  ['шаблон recurring', 'not(class(orbis/recurrence) ∈ {template})'],
  ['recurring-инстанс', 'not(has_relation(instance-of))'],
  ['уже факт', 'orbis/planned = true'],
] as const;

/** Создание в порченом мире — тем же исполнителем, что сев, id выбирает сервер. */
async function createIn(owner: GraphId, input: Record<string, unknown>): Promise<string> {
  const r = await execute(db, {
    identity: personal(owner),
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool: 'entity_create', input: { tags: [], ...input } }],
  });
  if (!r.ok) throw new Error(`порча: ${r.error.code} — ${r.error.message}`);
  return (r.results[0] as WireEntity).id;
}
const plannedInput = (planned: boolean) => ({
  title: 'Купить кроссовки',
  props: {
    'orbis/amount': '8000.00',
    'orbis/currency': 'RUB',
    'orbis/direction': 'expense',
    'orbis/finance_category': newId(),
    'orbis/occurred_on': '2026-07-15',
    'orbis/planned': planned,
  },
  aspects: ['orbis/financial'],
});
const templateInput = (planned: boolean) => ({
  title: 'Подписка',
  props: {
    ...(planned && { 'orbis/planned': true }),
    'orbis/start_at': '2026-07-15T09:00:00+03:00',
    'orbis/timezone': 'Europe/Moscow',
    'orbis/recurrence': { freq: 'daily', interval: 1 },
    'orbis/amount': '500.00',
    'orbis/currency': 'RUB',
    'orbis/direction': 'expense',
    'orbis/finance_category': newId(),
    'orbis/recurring': true,
  },
  aspects: ['orbis/schedule', 'orbis/financial'],
});

/**
 * Порча на каждый конъюнкт. Четыре мира ложны РОВНО по своему конъюнкту (остальные четыре
 * истинны — проверено вычислением конъюнктов по одному при сборке таблицы): поэтому выпавший из
 * сида пречек красит (а) своей строкой. Исключение одно и оно по построению: `orbis/planned`
 * живёт только в `orbis/financial`, и у не-financial записи ложен ещё и конъюнкт «уже факт».
 * Выпадение `class(orbis/money-movement)` строка «не-financial» поэтому не ловит — его ловит пин
 * счёта конъюнктов сида (в). Шаблон повторения сеется с `orbis/planned: true` ровно ради
 * изоляции: без него у шаблона ложен и «уже факт».
 */
const SPOILED_WORLD: Record<
  (typeof PRECONDITION_CONJUNCTS)[number][0],
  (owner: GraphId) => Promise<string>
> = {
  'не-financial': (owner) => createIn(owner, { title: 'Заметка' }),
  архивная: async (owner) => {
    const id = await createIn(owner, plannedInput(true));
    const r = await execute(db, {
      identity: personal(owner),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id, archived: true } }],
    });
    if (!r.ok) throw new Error(`архивация: ${r.error.code} — ${r.error.message}`);
    return id;
  },
  'шаблон recurring': (owner) => createIn(owner, templateInput(true)),
  'recurring-инстанс': async (owner) => {
    const template = await createIn(owner, templateInput(false));
    await materializeInstances({
      db,
      identity: personal(owner),
      from: '2026-07-15',
      to: '2026-07-15',
      today: '2026-07-15',
    });
    return recurringInstanceId(template, '2026-07-15');
  },
  'уже факт': (owner) => createIn(owner, plannedInput(false)),
};

/** Состояние записи — мерка `stateDelta` (канон значений, а не ссылочное равенство). */
async function stateOf(
  owner: GraphId,
  id: string,
): Promise<{ props: Record<string, unknown>; aspects: string[] }> {
  const rows = await withIdentity(db, personal(owner), (tx) =>
    tx.execute(sql`SELECT props, aspects FROM entities WHERE id = ${id}`),
  );
  const row = rows[0] as { props: Record<string, unknown>; aspects: string[] } | undefined;
  if (row === undefined) throw new Error(`записи ${id} нет`);
  return { props: row.props, aspects: row.aspects };
}

/**
 * Запись отката в журнале — undo-сообщение `{type:'undo', undoes}` (§7.8): нового action откат не
 * порождает (undo неотменяем), поэтому «строка журнала» случая отката — именно оно.
 */
async function undoRecordOf(owner: GraphId, actionId: string): Promise<unknown> {
  const probe = JSON.stringify({ type: 'undo', undoes: actionId });
  const rows = await withIdentity(db, personal(owner), (tx) =>
    tx.execute(sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb`),
  );
  if (rows.length !== 1) throw new Error(`undo-сообщений ${actionId}: ${rows.length}, ждали одно`);
  return rows[0]?.metadata;
}

beforeAll(async () => {
  await truncateAll();
  for (const owner of Object.values(OWNER)) await seedWorld(owner);

  // Половина `legacy`: `confirmPurchase` — тот путь, которым ручка `budget.confirmPurchase`
  // переводит покупку сегодня.
  BEFORE.legacy = await snapshotWorld(OWNER.legacy, PURCHASE_WORLD);
  const legacy = await confirmPurchase(db, personal(OWNER.legacy), {
    entityId: worldId(OWNER.legacy, 'purchase'),
    occurredOn: OCCURRED_ON,
    batchId: batchOf(OWNER.legacy, 'purchase'),
  });
  if (legacy.idempotentReplay) throw new Error('половина legacy: неожиданный replay');
  AFTER.legacy = await snapshotWorld(OWNER.legacy, PURCHASE_WORLD);
  JOURNALS.set('legacy', await journalOf(OWNER.legacy, batchOf(OWNER.legacy, 'purchase')));

  // Половина `action`: тот же вызов конвейером действий — резолв декларации и один `execute`
  // с атрибуцией ручки (`source:'ui'`, владелец).
  BEFORE.action = await snapshotWorld(OWNER.action, PURCHASE_WORLD);
  const resolved = await withIdentity(db, personal(OWNER.action), async (tx) =>
    resolveAction(
      tx,
      await effectiveRegistry(tx, OWNER.action),
      OWNER.action,
      {
        action: 'finance/plan-to-fact',
        self: worldId(OWNER.action, 'purchase'),
        params: { occurred_on: OCCURRED_ON },
        batch_id: batchOf(OWNER.action, 'purchase'),
      },
      { today: OCCURRED_ON, timeZone: 'Europe/Moscow' },
    ),
  );
  const r = await execute(
    db,
    {
      identity: personal(OWNER.action),
      actorKind: 'owner',
      source: 'ui',
      batchId: batchOf(OWNER.action, 'purchase'),
      operations: resolved.operations,
      action: { id: resolved.decl.id, module: resolved.decl.module },
      actionLabel: resolved.decl.label.ru,
    },
    { sink },
  );
  if (!r.ok) throw new Error(`половина action: ${r.error.code} — ${r.error.message}`);
  AFTER.action = await snapshotWorld(OWNER.action, PURCHASE_WORLD);
  JOURNALS.set('action', await journalOf(OWNER.action, batchOf(OWNER.action, 'purchase')));

  // Половина `dispatch`: `run_action` из чата от владельца — поверхность модели.
  BEFORE.dispatch = await snapshotWorld(OWNER.dispatch, PURCHASE_WORLD);
  const out = await dispatchTool(chatCtx(OWNER.dispatch), 'run_action', {
    action: 'finance/plan-to-fact',
    self: worldId(OWNER.dispatch, 'purchase'),
    params: { occurred_on: OCCURRED_ON },
    batch_id: batchOf(OWNER.dispatch, 'purchase'),
  });
  if (out.status !== 'ok') throw new Error(`половина dispatch: ${JSON.stringify(out)}`);
  AFTER.dispatch = await snapshotWorld(OWNER.dispatch, PURCHASE_WORLD);
  JOURNALS.set('dispatch', await journalOf(OWNER.dispatch, batchOf(OWNER.dispatch, 'purchase')));

  // Мир `tasks`: map-действие по Q из чата. Уровень считается той же чистой функцией, что у
  // диспатча (`actionCallFacts`), по резолву на те же «сегодня» — до исполнения.
  BEFORE.tasks = await snapshotWorld(OWNER.tasks, TASKS_WORLD);
  const call = { action: 'planner/postpone_overdue', params: { to: POSTPONE_TO } };
  tasksLevel = await withIdentity(db, personal(OWNER.tasks), async (tx) => {
    const reg = await effectiveRegistry(tx, OWNER.tasks);
    const r = await resolveAction(tx, reg, OWNER.tasks, call, {
      today: OCCURRED_ON,
      timeZone: 'Europe/Moscow',
    });
    return classifyToolCall(
      actionCallFacts(reg, r.decl, r.operations, r.targets, chatCtx(OWNER.tasks)),
    );
  });
  const postponed = await dispatchTool(chatCtx(OWNER.tasks), 'run_action', {
    ...call,
    batch_id: batchOf(OWNER.tasks, 'postpone'),
  });
  if (postponed.status !== 'ok') throw new Error(`мир tasks: ${JSON.stringify(postponed)}`);
  AFTER.tasks = await snapshotWorld(OWNER.tasks, TASKS_WORLD);
  JOURNALS.set('tasks', await journalOf(OWNER.tasks, batchOf(OWNER.tasks, 'postpone')));
});

afterAll(async () => {
  await client.end();
});

describe('§С8-27 plan-to-fact: код и декларация дают один результат', () => {
  test('сегодняшний confirmPurchase равен эталону (регрессия)', () => {
    const g = caseOf('plan-to-fact/legacy');
    const names = namesOf(OWNER.legacy);
    expect(canonicalJson(stabilize(BEFORE.legacy, names))).toBe(canonicalJson(g.before));
    expect(canonicalJson(stabilize(AFTER.legacy, names))).toBe(canonicalJson(g.after));
    expect(canonicalJson(stabilize(journal('legacy'), names))).toBe(canonicalJson(g.journal));
  });

  test('run_action на той же фикстуре: состояние байт-в-байт, журнал — с точностью до четырёх расхождений §Б6-4', () => {
    const g = caseOf('plan-to-fact/legacy');
    const names = namesOf(OWNER.action);
    // СОСТОЯНИЕ — БЕЗ ВСЯКИХ ПОБЛАЖЕК: и props, и переселект конверта бюджет-хуком A4 (`incoming`)
    expect(canonicalJson(stabilize(BEFORE.action, names))).toBe(canonicalJson(g.before));
    expect(canonicalJson(stabilize(AFTER.action, names))).toBe(canonicalJson(g.after));
    // ЖУРНАЛ — с закрытым списком: §Б6-4 ревизии 4 меняет строку НАМЕРЕННО и ровно в четырёх местах
    expectJournalWithinDiffs(journal('action'), names);
  });

  test('вызов через dispatchTool: состояние то же; атрибуция журнала — вызывающего, а не декларации', () => {
    // Состояние графа от поверхности вызова не зависит; зависит только атрибуция §7.8, и она
    // обязана отличаться — иначе журнал врал бы, кто это сделал.
    const names = namesOf(OWNER.dispatch);
    expect(canonicalJson(stabilize(BEFORE.dispatch, names))).toBe(
      canonicalJson(caseOf('plan-to-fact/legacy').before),
    );
    expect(canonicalJson(stabilize(AFTER.dispatch, names))).toBe(
      canonicalJson(caseOf('plan-to-fact/legacy').after),
    );
    // Атрибуция — ЕДИНСТВЕННОЕ, что отличает путь диспатча от ручки: `source` ставит вызывающий
    expect(journal('dispatch').action.source).toBe('chat');
    expect(journal('dispatch').action.type).toBe('action');
    // Операции сравниваются стабилизированными: у половин разные владельцы, значит и разные id.
    expect(stabilize(journal('dispatch').action.operations, names)).toEqual(
      stabilize(journal('action').action.operations, namesOf(OWNER.action)),
    );
  });

  test('пять пречеков кода → один CONFLICT precondition_failed; состояние порченого мира не тронуто', async () => {
    // (в) Конъюнктов в таблице пять — и столько же в сиде: выпавший при правке сида пречек
    // красит (а) своей порчей, а этот пин — счётом.
    expect(PRECONDITION_CONJUNCTS).toHaveLength(5);
    const seeded = BUILTIN_ACTION_DEFS.find((d) => d.id === 'finance/plan-to-fact');
    expect((seeded?.precondition as { op?: string; args?: unknown[] } | null)?.op).toBe('and');
    expect((seeded?.precondition as { args?: unknown[] } | null)?.args).toHaveLength(
      PRECONDITION_CONJUNCTS.length,
    );
    for (const [spoil, conjunct] of PRECONDITION_CONJUNCTS) {
      const owner = await freshGraph();
      const id = await SPOILED_WORLD[spoil](owner);
      const before = await stateOf(owner, id);
      // (а) Отказ — от РЕЗОЛВА, до исполнителя: ложное предусловие операций не собирает.
      const refused = await withIdentity(db, personal(owner), async (tx) =>
        resolveAction(
          tx,
          await effectiveRegistry(tx, owner),
          owner,
          { action: 'finance/plan-to-fact', self: id, params: { occurred_on: OCCURRED_ON } },
          { today: OCCURRED_ON, timeZone: 'Europe/Moscow' },
        ).then(
          () => ({ code: 'нет отказа', reason: undefined }),
          (e: unknown) => ({
            code: (e as { code?: unknown }).code,
            reason: (e as { details?: { reason?: unknown } }).details?.reason,
          }),
        ),
      );
      expect([spoil, conjunct, refused]).toEqual([
        spoil,
        conjunct,
        { code: 'CONFLICT', reason: 'precondition_failed' },
      ]);
      // (б) Состояние после отказа равно состоянию до — той же меркой, что журнал.
      expect([spoil, stateDelta(before, await stateOf(owner, id))]).toEqual([spoil, {}]);
    }
  });
});

describe('§С8-27 postpone_overdue: map-действие по Q', () => {
  test('снимок состояния и строки журнала равен эталону; уровень трёх целей — preview', () => {
    const g = caseOf('postpone_overdue/apply');
    const names = namesOf(OWNER.tasks);
    // Три цели < 10 → ряд «batch» таблицы §7.10 даёт `preview`: действие ИСПОЛНЯЕТСЯ, а не
    // ложится карточкой — иначе снимать было бы нечего.
    expect(tasksLevel).toBe('preview');
    expect(canonicalJson(stabilize(BEFORE.tasks, names))).toBe(canonicalJson(g.before));
    expect(canonicalJson(stabilize(AFTER.tasks, names))).toBe(canonicalJson(g.after));
    expect(canonicalJson(stabilize(journal('tasks'), names))).toBe(canonicalJson(g.journal));
    // Читаемо, а не только побайтно: ОДНА строка `action` на пачку, три операции и три обратные.
    const { action } = journal('tasks');
    expect([action.type, action.action_id, action.module]).toEqual([
      'action',
      'planner/postpone_overdue',
      'planner',
    ]);
    expect([action.operations.length, action.inverse.length]).toEqual([3, 3]);
  });

  test('apply → undoAction → состояние «до» байт-в-байт: обратимость §Б6-4 на map-действии', async () => {
    // `undoAction`, а не `undoLast`: цель названа по id (проверяется обратимость ДЕЙСТВИЯ, а не
    // поиск последнего), и путь тот же — внутренний режим, один tx, undo-сообщение вместо action.
    const undone = await undoAction(db, {
      identity: personal(OWNER.tasks),
      actionId: journal('tasks').action.id,
    });
    expect(undone.ok).toBe(true);
    const back = await snapshotWorld(OWNER.tasks, TASKS_WORLD);
    const names = namesOf(OWNER.tasks);
    // Два утверждения, а не одно: равенство эталону «до» (побайтово) и пустая дельта состояния
    // (`stateDelta` — та же мерка, которой считает журнал: канон значений, а не ссылочное равенство)
    expect(canonicalJson(stabilize(back, names))).toBe(
      canonicalJson(caseOf('postpone_overdue/apply').before),
    );
    for (let i = 0; i < 3; i += 1) {
      const from = { props: BEFORE.tasks[i]?.props ?? {}, aspects: BEFORE.tasks[i]?.aspects ?? [] };
      const to = { props: back[i]?.props ?? {}, aspects: back[i]?.aspects ?? [] };
      expect([i, stateDelta(from, to)]).toEqual([i, {}]);
    }
    // Случай отката в эталоне — зеркало случая исполнения (его «до» — это «после» apply, его
    // «после» — «до» apply), а запись отката — undo-сообщение, не новая строка action.
    const g = caseOf('postpone_overdue/undo');
    expect(canonicalJson(g.before)).toBe(canonicalJson(caseOf('postpone_overdue/apply').after));
    expect(canonicalJson(g.after)).toBe(canonicalJson(caseOf('postpone_overdue/apply').before));
    expect(canonicalJson(stabilize(back, names))).toBe(canonicalJson(g.after));
    const undo = await undoRecordOf(OWNER.tasks, journal('tasks').action.id);
    expect(canonicalJson({ undo: stabilize(undo, names) })).toBe(canonicalJson(g.journal));
  });
});
