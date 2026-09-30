// apps/server/src/registry/extension-off.test.ts
// Матрица С1б-4 (серверная половина, спека 1б §8.3; спека реформы §Б8-3 ревизия 7): выключенное
// расширение — для КАЖДОГО из четырёх. Тулы трёх каналов и слой 5 целиком, каталог свойств,
// создание, правка его полей всеми акторами (только чтение), снятие аспекта, правила его аспектов,
// видимость записей, Undo, пропуск рутин, включение обратно. Отдельно для Финансов — обходы маски:
// материализация повторов, проводка плановых, «план → факт», импорт, правило памяти про деньги.
//
// Граф у каждого расширения СВОЙ (`freshGraph`), и мир не сеется: предмет — маска одного графа, а
// общий граф превратил бы порядок блоков в скрытый вход (довод `extensions.test.ts`, `blockEntry`).
// Заводится граф ЛЕНИВО, первым тестом блока: describe-level `beforeAll` bun исполняет до первого
// теста файла, то есть раньше `truncateAll` верхнего уровня не гарантированно.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ExtensionId, GraphId } from '@orbis/shared';
import {
  actionToolName,
  addDays,
  attachToolName,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RULES_BY_CARRIER,
  BUILTIN_SUBSCRIPTION_DEFS,
  EXTENSION_IDS,
  EXTENSION_MANIFESTS,
  extensionName,
  newId,
  recurringInstanceId,
  routineRunId,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { extensionIdsIn, extensionMarksIn } from '../../test/extension-ids';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { chatToolSurface } from '../ai/send-message';
import { budgetOverview } from '../budget/aggregates';
import { ensureGlobalThread } from '../chat/threads';
import { userSettings } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import type { ExecuteResult } from '../executor/types';
import { undoAction } from '../executor/undo';
import { buildContext } from '../llm/context';
import { ScriptedProvider } from '../llm/scripted';
import type { LLMResponse } from '../llm/types';
import { materializeInstances } from '../recurring/materialize';
import { postDueInstances } from '../recurring/post-due';
import { appRouter } from '../router';
import { CONSECUTIVE_FAILURES_TO_PAUSE } from '../routines/constants';
import { buildRoutineContext } from '../routines/context';
import { routineTick } from '../routines/scheduler';
import { agentLoopHelpers } from '../test/agent-loop-helpers';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import { buildToolRegistry, type OrbisToolDef, routineToolDefs } from '../tools/registry';
import { createCallerFactory } from '../trpc';
import { effectiveRegistry } from './cache';

requireEnv();

const { db, client } = appDb();
const { seedRoutine, seedRoutineRun } = agentLoopHelpers(db);
// Боевой синк журнала: Undo (пункт 8) адресует действие журнала, без синка его бы не было.
const sink = makeJournalSink();
const createCaller = createCallerFactory(appRouter);

const TZ = 'Europe/Moscow';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
/** Часы тика рутин — прошлое с наступившим бакетом 07:00 (тот же приём, что `scheduler.test.ts`). */
const T0 = new Date('2026-08-18T04:30:00.000Z');

beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------------------
// Обвязка
// ---------------------------------------------------------------------------

function callerOf(g: GraphId) {
  return createCaller({ identity: personal(g), actorKind: 'owner', db, clientVersion: null });
}

async function run(
  g: GraphId,
  tool: string,
  input: unknown,
  over: { journal?: boolean; mechanism?: 'seed' } = {},
): Promise<ExecuteResult> {
  return execute(
    db,
    {
      identity: personal(g),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool, input }],
      ...(over.mechanism !== undefined && { mechanism: over.mechanism }),
    },
    over.journal === true ? { sink } : {},
  );
}

async function created(g: GraphId, input: Record<string, unknown>): Promise<string> {
  const r = await run(g, 'entity_create', { tags: [], ...input });
  if (!r.ok) throw new Error(`сид: ${r.error.code} — ${r.error.message}`);
  return (r.results[0] as { id: string }).id;
}

/**
 * Переключение — ОПЕРАЦИЕЙ ВЛАДЕЛЬЦА `module_set` (все четыре переключаемы с задачи 7), но без
 * синка журнала: выключение в журнале стало бы «последним действием», и Undo пункта 8 откатывал бы
 * его, а не правку поля, которая и есть предмет.
 */
async function setEnabled(g: GraphId, ext: ExtensionId, enabled: boolean): Promise<void> {
  const r = await run(g, 'module_set', { module: ext, enabled });
  if (!r.ok) throw new Error(`module_set ${ext}=${enabled}: ${r.error.code} — ${r.error.message}`);
}

/** Граф, видимый планировщику: строка настроек с таймзоной (0013, V1.13). */
async function newGraph(): Promise<GraphId> {
  const g = await freshGraph();
  await withIdentity(db, personal(g), (tx) =>
    tx.insert(userSettings).values({ graphId: g, timezone: TZ }),
  );
  return g;
}

async function category(g: GraphId, title = 'Еда'): Promise<string> {
  return created(g, { title, props: { 'orbis/icon': '🍏' }, aspects: ['orbis/category'] });
}

/** Отказ `MODULE_DISABLED` результата исполнителя или диспатча — код и детали в одной форме. */
function refusalOf(r: ExecuteResult | { status: string; error?: unknown }): {
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  const error =
    'ok' in r ? (r.ok ? undefined : r.error) : r.status === 'error' ? r.error : undefined;
  if (error === undefined) throw new Error(`ожидался отказ, получен успех: ${JSON.stringify(r)}`);
  const e = error as { code: string; message: string; details?: Record<string, unknown> };
  return { code: e.code, message: e.message, details: e.details ?? {} };
}

/** Отказ tRPC-ручки: код TRPC и структурированная причина исполнителя в `cause`. */
async function trpcRefusal(p: Promise<unknown>): Promise<{
  code: string;
  cause: { code?: string; message?: string; details?: Record<string, unknown> };
}> {
  try {
    await p;
  } catch (e) {
    const err = e as { code: string; cause?: unknown };
    return { code: err.code, cause: (err.cause ?? {}) as never };
  }
  throw new Error('ожидался отказ ручки, получен успех');
}

async function propsOf(g: GraphId, id: string): Promise<Record<string, unknown>> {
  const rows = (await withIdentity(db, personal(g), (tx) =>
    tx.execute(sql`SELECT props FROM entities WHERE id = ${id}::uuid`),
  )) as unknown as Array<{ props: Record<string, unknown> }>;
  return rows[0]?.props ?? {};
}

/** Счётчики графа: «ни одной новой строки» (пункты 11, 15) — сравнение до и после. */
async function counts(g: GraphId): Promise<{ entities: number; messages: number; stamp: string }> {
  const rows = (await withIdentity(db, personal(g), (tx) =>
    tx.execute(sql`
      SELECT (SELECT count(*)::int FROM entities) AS entities,
             (SELECT count(*)::int FROM chat_messages) AS messages,
             (SELECT coalesce(max(updated_at)::text, '') FROM entities) AS stamp`),
  )) as unknown as Array<{ entities: number; messages: number; stamp: string }>;
  const row = rows[0];
  if (row === undefined) throw new Error('счётчики графа не прочитаны');
  return row;
}

function ownerChat(g: GraphId): ToolCallCtx {
  return { db, identity: personal(g), actorKind: 'owner', source: 'chat', explicitCommand: false };
}

/** Внешний агент (MCP): та же форма контекста, что собирает `mcp/server.ts`, без гранта. */
function agentMcp(g: GraphId): ToolCallCtx {
  return { db, identity: personal(g), actorKind: 'agent', source: 'mcp', explicitCommand: false };
}

function endTurn(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'end_turn',
  };
}

/**
 * Каналы тулов (слой 5): чат — `chatToolSurface`, рутина — `routineToolDefs` рутины `act`, чей
 * белый список называет ВСЕ тулы (показ режется маской, а не списком), MCP — отсечение
 * `internalOnly`/`routineOnly` из `mcp/server.ts` (полный скоуп).
 */
async function channels(g: GraphId): Promise<Record<'chat' | 'routine' | 'mcp', OrbisToolDef[]>> {
  const defs = await withIdentity(db, personal(g), (tx) => buildToolRegistry(tx, g));
  const chatNames = new Set(chatToolSurface(defs).map((d) => d.name));
  return {
    chat: defs.filter((d) => chatNames.has(d.name)),
    routine: routineToolDefs(defs, {
      id: newId(),
      runId: newId(),
      mode: 'act',
      allowedTools: new Set(defs.map((d) => d.name)),
    }),
    mcp: defs.filter((d) => d.internalOnly !== true && d.routineOnly !== true),
  };
}

/**
 * Системный слой чата и рутины — канал, в котором живут фрагменты и индекс аспектов. Рутина канала
 * — настоящая запись (контекст прогона читает её тред), на ПАУЗЕ: активная попала бы в тик пункта 15.
 */
async function promptChannels(g: GraphId): Promise<{ chat: string; routine: string }> {
  const routineId = await seedRoutine(g, { routine: { 'orbis/routine_stage': 'paused' } });
  return withIdentity(db, personal(g), async (tx) => {
    const threadId = await ensureGlobalThread(tx, g);
    const chat = (await buildContext(tx, { graphId: g, threadId })).system;
    const routine = (
      await buildRoutineContext(tx, {
        graphId: g,
        routine: {
          id: routineId,
          title: 'Утренний обзор',
          body: 'Пройди по задачам дня.',
          props: {
            'orbis/routine_stage': 'paused',
            'orbis/routine_at': '07:00',
            'orbis/routine_mode': 'propose',
          },
        },
        run: { id: newId(), bucket: '2026-08-17T07:00' },
        history: [],
      })
    ).system;
    return { chat, routine };
  });
}

/**
 * ИМЕНОВАННЫЕ ИСКЛЮЧЕНИЯ сторожа слоя 5 (Э-17, В-10 — умолчание принято): след расширения в
 * определении тула ЯДРА, который законен. Каждое — с причиной; новое исключение без причины здесь
 * не заводится.
 */
const LAYER5_EXCEPTIONS: ReadonlyArray<{ tool: string; id: string; why: string }> = [
  {
    tool: 'attach_orbis_memory',
    id: 'orbis/category',
    why: 'язык: цель правила памяти `orbis/rule_target` — ссылка на запись-категорию; правила памяти про деньги работают при выключенных Финансах (Р-23 п. 4.4), и описание цели называет аспект, которым описано множество ссылки',
  },
];

/** След расширения `ext` в JSON видимых определений — без именованных исключений. */
function leaksOf(defs: readonly OrbisToolDef[], ext: ExtensionId): string[] {
  const own = new Set(
    [...BUILTIN_ASPECT_DEFS, ...BUILTIN_PROPERTY_META]
      .filter((x) => x.module === ext)
      .map((x) => x.id),
  );
  const out: string[] = [];
  for (const d of defs) {
    const text = JSON.stringify(d);
    const allowed = new Set(LAYER5_EXCEPTIONS.filter((x) => x.tool === d.name).map((x) => x.id));
    for (const id of extensionIdsIn(text)) {
      if (own.has(id) && !allowed.has(id)) out.push(`${d.name}: ${id}`);
    }
    for (const mark of extensionMarksIn(text, ext)) out.push(`${d.name}: ${mark}`);
  }
  return out.sort();
}

/**
 * Своё правило на носителе расширения (R-8): безобидное — условие «приоритет high» на записях
 * матрицы ложно, — но включённое правило на аспекте выключенного расширения — настройка его
 * определения, и её гейт отказывает.
 */
function carrierRule(aspect: string, id: string) {
  return {
    target: { aspect },
    rule: {
      id,
      template: 'requires_when',
      params: { property: 'orbis/due_date' },
      when: { op: '=', args: [{ prop: 'orbis/priority' }, { const: 'high' }] },
    },
  };
}

// ---------------------------------------------------------------------------
// Фикстуры расширений
// ---------------------------------------------------------------------------

interface ExtCase {
  ext: ExtensionId;
  /** Подпись расширения — в текстах отказов (манифест). */
  label: string;
  aspect: string;
  /** Свойства аспекта при создании (категория нужна только Финансам). */
  props(cat: string): Record<string, unknown>;
  /** Правка свойства РАСШИРЕНИЯ существующей записи. */
  extEdit(cat2: string): Record<string, unknown>;
  /** Свойство расширения БЕЗ его аспекта — четвёртый путь пункта 4. */
  lone(cat: string): Record<string, unknown>;
  /** Правка ядра на той же записи (стандартное свойство ядра — у Финансов). */
  coreEdit: Record<string, unknown>;
  /** Белый список рутины, целиком из тулов расширения (пункт 15). */
  routineTools: string[];
}

const GOAL_SOURCE = { query: { text: 'aspect=orbis/task' }, aggregate: 'count' };

const CASES: readonly ExtCase[] = [
  {
    ext: 'finance',
    label: 'Финансы',
    aspect: 'orbis/financial',
    props: (cat) => ({
      'orbis/amount': '600.00',
      'orbis/direction': 'expense',
      'orbis/finance_category': cat,
      'orbis/occurred_on': today,
    }),
    extEdit: (cat2) => ({ 'orbis/finance_category': cat2 }),
    lone: (cat) => ({ 'orbis/finance_category': cat }),
    coreEdit: { 'orbis/amount': '700.00' },
    routineTools: ['budget_status'],
  },
  {
    ext: 'goals',
    label: 'Цели',
    aspect: 'orbis/goal',
    props: () => ({ 'orbis/progress_source': GOAL_SOURCE, 'orbis/target_value': '100.00' }),
    extEdit: () => ({ 'orbis/target_value': '200.00' }),
    lone: () => ({ 'orbis/target_value': '5.00' }),
    coreEdit: {},
    routineTools: ['attach_orbis_goal'],
  },
  {
    ext: 'projects',
    label: 'Проекты',
    aspect: 'orbis/project',
    props: () => ({ 'orbis/project_stage': 'active' }),
    extEdit: () => ({ 'orbis/project_stage': 'paused' }),
    lone: () => ({ 'orbis/project_stage': 'done' }),
    coreEdit: {},
    routineTools: ['attach_orbis_project'],
  },
  {
    ext: 'dev',
    label: 'Разработка',
    aspect: 'orbis/repo',
    props: () => ({
      'orbis/repo_url': 'https://github.com/qvenge/orbis',
      'orbis/default_branch': 'main',
    }),
    extEdit: () => ({ 'orbis/default_branch': 'develop' }),
    lone: () => ({ 'orbis/repo_url': 'https://github.com/qvenge/other' }),
    coreEdit: {},
    routineTools: ['attach_orbis_repo'],
  },
];

test('матрица покрывает словарь расширений целиком', () => {
  expect(CASES.map((c) => c.ext)).toEqual([...EXTENSION_IDS]);
  for (const c of CASES) expect(c.label).toBe(extensionName(c.ext));
});

// ---------------------------------------------------------------------------
// Матрица С1б-4 по четырём расширениям
// ---------------------------------------------------------------------------

// Имя блока — через `%s` из пары [ext, случай]: bun 1.2.7 не подставляет `$ext` из объекта, и
// четыре блока звались бы одинаково — по падению не понять, какое расширение сломано (финал B2 M-1).
describe.each(
  CASES.map((c) => [c.ext, c] as const),
)('выключенное расширение %s (С1б-4)', (_ext, c) => {
  interface World {
    g: GraphId;
    cat: string;
    cat2: string;
    rec: string;
    undoRec: string;
    undoActionId: string;
    undoBefore: Record<string, unknown>;
  }
  let world: World | undefined;

  /**
   * Мир блока — при ВКЛЮЧЁННОМ расширении (законные записи владельца), затем выключение. Правка
   * для Undo (пункт 8) совершается до выключения и журналируется — её откат после выключения и
   * есть предмет пункта.
   */
  async function setup(): Promise<World> {
    if (world !== undefined) return world;
    const g = await newGraph();
    const cat = await category(g);
    const cat2 = await category(g, 'Транспорт');
    const rec = await created(g, {
      title: `Запись ${c.ext}`,
      props: { ...c.props(cat), 'orbis/task_status': 'inbox' },
      aspects: [c.aspect, 'orbis/task'],
    });
    const undoRec = await created(g, {
      title: `Для отката ${c.ext}`,
      props: c.props(cat),
      aspects: [c.aspect],
    });
    const undoBefore = await propsOf(g, undoRec);
    const edit = await run(
      g,
      'entity_update',
      { id: undoRec, props: c.extEdit(cat2) },
      { journal: true },
    );
    if (!edit.ok) throw new Error(`правка для отката: ${edit.error.code} — ${edit.error.message}`);
    // Правило, заведённое при включённом расширении, — его снятие после выключения (R-8: снятие
    // поле не пишет и разрешено).
    const pre = await run(g, 'rule_set', carrierRule(c.aspect, `user_${c.ext}_pre`));
    if (!pre.ok) throw new Error(`правило до выключения: ${pre.error.code} — ${pre.error.message}`);
    await setEnabled(g, c.ext, false);
    world = { g, cat, cat2, rec, undoRec, undoActionId: edit.actionId, undoBefore };
    return world;
  }

  test('1. тулы трёх каналов и слой 5 целиком: ни тулов, ни id, ни поверхностей расширения', async () => {
    const { g } = await setup();
    const reg = await withIdentity(db, personal(g), (tx) => effectiveRegistry(tx, g));
    const extTools = [
      ...EXTENSION_MANIFESTS[c.ext].tools,
      ...[...reg.aspects.values()]
        .filter((a) => a.module === c.ext)
        .map((a) => attachToolName(a.key)),
      ...[...reg.actions.values()]
        .filter((a) => a.module === c.ext)
        .map((a) => actionToolName(a.key)),
    ];
    expect(extTools.length).toBeGreaterThan(0);
    const ch = await channels(g);
    for (const [name, defs] of Object.entries(ch)) {
      const names = defs.map((d) => d.name);
      expect({ name, hidden: extTools.filter((t) => names.includes(t)) }).toEqual({
        name,
        hidden: [],
      });
      expect({ name, leaks: leaksOf(defs, c.ext) }).toEqual({ name, leaks: [] });
    }
    // Каналы промпта (задача 6): ни одного id расширения ни в чате, ни в рутине.
    const own = [...BUILTIN_ASPECT_DEFS, ...BUILTIN_PROPERTY_META]
      .filter((x) => x.module === c.ext)
      .map((x) => x.id);
    const prompt = await promptChannels(g);
    expect(extensionIdsIn(prompt.chat).filter((id) => own.includes(id))).toEqual([]);
    expect(extensionIdsIn(prompt.routine).filter((id) => own.includes(id))).toEqual([]);
    // И следы — имена тулов, поверхности, ключи действий расширения (финал B2 M-2): каналы промпта
    // стерегутся не слабее тулов (`leaksOf`).
    expect(extensionMarksIn(prompt.chat, c.ext)).toEqual([]);
    expect(extensionMarksIn(prompt.routine, c.ext)).toEqual([]);
  });

  test('4а. путь attach: свой аспект с полем расширения — значение ставится → read_only, без значения — законно', async () => {
    // Путь attach гейта полей на КАЖДОМ расширении (финал 1б, мутации: N-2 держал только Финансы).
    // Свой граф: тул своего аспекта с полем расширения в составе — отдельная тема видимости (N-2),
    // в мир блока он не входит.
    const g = await newGraph();
    const cat2 = await category(g, 'Транспорт');
    const [prop, value] =
      Object.entries(c.extEdit(cat2)).find(
        ([id]) => BUILTIN_PROPERTY_META.find((m) => m.id === id)?.module === c.ext,
      ) ?? [];
    if (prop === undefined) throw new Error(`у случая ${c.ext} нет поля расширения в extEdit`);
    const ownKey = `user/with_${c.ext}`;
    const own = await run(g, 'aspect_create', {
      key: ownKey,
      label: { ru: `Со своим полем ${c.ext}` },
      description: { ru: 'Свой аспект владельца с полем расширения' },
      properties: [{ propertyId: prop, required: false }],
    });
    if (!own.ok) throw new Error(`свой аспект: ${own.error.code} — ${own.error.message}`);
    const target = await created(g, { title: `Цель навешивания ${c.ext}`, props: {} });
    await setEnabled(g, c.ext, false);
    const ownAttach = { tool: attachToolName(ownKey), target, prop, value };
    expect(
      refusalOf(
        await run(g, ownAttach.tool, {
          entity_id: ownAttach.target,
          data: { [ownAttach.prop]: ownAttach.value },
        }),
      ),
    ).toMatchObject({
      code: 'MODULE_DISABLED',
      details: { extension: c.ext, reason: 'read_only', property: ownAttach.prop },
    });
    expect((await propsOf(g, ownAttach.target))[ownAttach.prop]).toBeUndefined();
    expect((await run(g, ownAttach.tool, { entity_id: ownAttach.target, data: {} })).ok).toBe(true);
  });

  test('2. property_catalog: ни одного свойства расширения, его аспектов нет среди носителей', async () => {
    const { g } = await setup();
    const out = await dispatchTool(ownerChat(g), 'property_catalog', {});
    if (out.status !== 'ok') throw new Error(`каталог: ${JSON.stringify(out)}`);
    const props = (
      out.result as {
        properties: Array<{ id: string; module: string | null; usage: { aspects: string[] } }>;
      }
    ).properties;
    expect(props.length).toBeGreaterThan(0);
    expect(props.filter((p) => p.module === c.ext).map((p) => p.id)).toEqual([]);
    const extAspects = BUILTIN_ASPECT_DEFS.filter((a) => a.module === c.ext).map((a) => a.key);
    expect(
      props.flatMap((p) =>
        p.usage.aspects.filter((a) => extAspects.includes(a)).map((a) => `${p.id}: ${a}`),
      ),
    ).toEqual([]);
  });

  test('3. создание записи с его аспектом → MODULE_DISABLED (create)', async () => {
    const { g, cat } = await setup();
    const r = await run(g, 'entity_create', {
      title: 'Новая',
      tags: [],
      props: c.props(cat),
      aspects: [c.aspect],
    });
    expect(refusalOf(r)).toMatchObject({
      code: 'MODULE_DISABLED',
      details: { extension: c.ext, reason: 'create' },
    });
  });

  test('4. правка его поля — только чтение для владельца (tRPC), агента (MCP), пачки и create без аспекта; ядро правится', async () => {
    const { g, cat, cat2, rec } = await setup();
    const readOnly = {
      code: 'MODULE_DISABLED',
      details: { extension: c.ext, reason: 'read_only' },
    };
    const before = await propsOf(g, rec);

    // Владелец в интерфейсе: tRPC `entity.update`.
    const owner = await trpcRefusal(callerOf(g).entity.update({ id: rec, props: c.extEdit(cat2) }));
    expect(owner.code).toBe('FORBIDDEN');
    expect(owner.cause).toMatchObject(readOnly);
    expect(owner.cause.message).toContain(`«${c.label}»`);

    // Агент: MCP `entity_update` через диспатч.
    expect(
      refusalOf(
        await dispatchTool(agentMcp(g), 'entity_update', { id: rec, props: c.extEdit(cat2) }),
      ),
    ).toMatchObject(readOnly);

    // Пачка: `batch_execute` владельца из чата.
    expect(
      refusalOf(
        await dispatchTool(ownerChat(g), 'batch_execute', {
          batch_id: newId(),
          operations: [{ tool: 'entity_update', input: { id: rec, props: c.extEdit(cat2) } }],
        }),
      ),
    ).toMatchObject(readOnly);

    // Четвёртый путь: запись БЕЗ аспекта расширения, но со свойством расширения (законно по
    // `executor/aspects-validate.ts` — свойство без своего аспекта) — тот же отказ.
    expect(
      refusalOf(
        await run(g, 'entity_create', {
          title: 'Без аспекта',
          tags: [],
          props: c.lone(cat),
          aspects: ['orbis/note'],
        }),
      ),
    ).toMatchObject(readOnly);

    expect(await propsOf(g, rec)).toEqual(before); // ни один путь не записал

    // Ядро той же записи — правится как обычно: заголовок, стандартное свойство ядра (у Финансов —
    // сумма), свойство ядерного аспекта.
    const core = await run(g, 'entity_update', {
      id: rec,
      title: `Запись ${c.ext} — правка`,
      props: { ...c.coreEdit, 'orbis/task_status': 'planned' },
    });
    expect(core.ok).toBe(true);
    const after = await propsOf(g, rec);
    expect(after['orbis/task_status']).toBe('planned');
    for (const [k, v] of Object.entries(c.coreEdit)) expect(after[k]).toEqual(v);
  });

  test('5. снятие его аспекта → MODULE_DISABLED (detach)', async () => {
    const { g, rec } = await setup();
    const r = await run(g, 'entity_update', { id: rec, aspects: { detach: [c.aspect] } });
    expect(refusalOf(r)).toMatchObject({
      code: 'MODULE_DISABLED',
      details: { extension: c.ext, reason: 'detach', aspect: c.aspect },
    });
    const aspects = (await withIdentity(db, personal(g), (tx) =>
      tx.execute(sql`SELECT aspects FROM entities WHERE id = ${rec}::uuid`),
    )) as unknown as Array<{ aspects: string[] }>;
    expect(aspects[0]?.aspects).toContain(c.aspect);
  });

  test('6. правило его аспекта срабатывает на правке прочих полей, отказ называет расширение', async () => {
    const { g, rec } = await setup();
    // Ограничивающие правила (C-род) на носителях расширения — из каталога, а не списком.
    const carriers = BUILTIN_ASPECT_DEFS.filter((a) => a.module === c.ext).map((a) => a.id);
    const constraint = carriers.flatMap((id) =>
      (BUILTIN_RULES_BY_CARRIER[id] ?? []).filter((r) =>
        ['requires_when', 'forbidden_when', 'unique_among'].includes(r.template),
      ),
    );
    if (c.ext !== 'finance') {
      // ПРОПУСК С ПРИЧИНОЙ: у носителей Целей, Проектов и Разработки нет ограничивающих правил
      // (у `orbis/project` — только движок `nearest_ancestor`, он пишет мимо патча). Выдумывать
      // правило ради пункта нельзя; пин держит посылку пропуска — появись такое правило, пункт
      // обязан стать проверкой.
      expect(constraint.map((r) => r.id)).toEqual([]);
      return;
    }
    // Финансы: `financial_requires_occurred_on` — снятие даты (свойство ЯДРА) у записи с
    // финансовым аспектом. Гейт «только чтение» дату пропускает, правило — нет.
    const r = await run(g, 'entity_update', { id: rec, unset: ['orbis/occurred_on'] });
    const refusal = refusalOf(r);
    expect(refusal.code).toBe('INVARIANT');
    expect(refusal.details.invariant).toBe('financial_requires_occurred_on');
    // Спека 1б §8.3, R-9: родительный падеж, слово «правило» один раз.
    expect(refusal.message).toStartWith(
      'правило Финансов: «financial_requires_occurred_on»: свойство orbis/occurred_on обязательно',
    );
  });

  test('7. записи видны: entity.query, entity.get, entity.blocks', async () => {
    const { g, rec } = await setup();
    const caller = callerOf(g);
    const found = await caller.entity.query({ query: `aspect=${c.aspect}` });
    expect(found.map((e) => e.id)).toContain(rec);
    const got = await caller.entity.get({ id: rec });
    expect(got.entity.aspects).toContain(c.aspect);
    const { results } = await caller.entity.blocks({
      blocks: [{ key: 'ext', text: `aspect=${c.aspect}` }],
    });
    const block = results.ext as { ok: boolean; kind: string; rows?: Array<{ id: string }> };
    expect(block.ok).toBe(true);
    expect((block.rows ?? []).map((r) => r.id)).toContain(rec);
  });

  test('8. Undo действия, совершённого при включённом расширении, проходит после выключения', async () => {
    const { g, undoRec, undoActionId, undoBefore } = await setup();
    const r = await undoAction(db, { identity: personal(g), actionId: undoActionId });
    expect(r.ok).toBe(true);
    const after = await propsOf(g, undoRec);
    for (const k of Object.keys(c.extEdit(''))) expect(after[k]).toEqual(undoBefore[k]);
  });

  test('15. рутина целиком из его тулов пропускается тиком без единой записи; безоружная — нет', async () => {
    const { g } = await setup();
    // Рутина с ТРЕМЯ плановыми провалами: стоп-кран поставил бы её на паузу (запись стадии и
    // заметки в тред) — пропуск обязан стоять ДО него, иначе «без записи» не выполняется.
    const armed = await seedRoutine(g, {
      title: 'Рутина расширения',
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': c.routineTools },
    });
    for (let i = 0; i < CONSECUTIVE_FAILURES_TO_PAUSE; i++) {
      await seedRoutineRun(g, {
        routineId: armed,
        bucket: `2026-08-1${i + 3}T07:00`,
        startedAt: new Date(T0.getTime() - (5 - i) * 24 * 3_600_000),
        run: { 'orbis/run_outcome': 'failed', 'orbis/fail_note': 'сбой провайдера' },
      });
    }
    const before = await counts(g);
    const provider = new ScriptedProvider([endTurn('не должно случиться')]);
    const tick = await routineTick({ db, provider, model: 'scripted-model', clock: () => T0 });
    expect(tick.skipped).toContainEqual({
      routineId: armed,
      bucket: '2026-08-18T07:00',
      reason: 'extension_disabled',
    });
    expect(tick.paused).not.toContain(armed);
    expect(tick.started.filter((id) => id === routineRunId(armed, '2026-08-18T07:00', 1))).toEqual(
      [],
    );
    expect(provider.requests).toHaveLength(0);
    expect(await counts(g)).toEqual(before);

    // Безоружная рутина (пустой белый список) — не «целиком из тулов расширения»: идёт.
    const bare = await seedRoutine(g, {
      title: 'Безоружная',
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': [] },
    });
    const bareProvider = new ScriptedProvider([endTurn('Утро спокойное.')]);
    const second = await routineTick({
      db,
      provider: bareProvider,
      model: 'scripted-model',
      clock: () => T0,
    });
    expect(second.started).toContain(routineRunId(bare, '2026-08-18T07:00', 1));
    // Обе — на паузу, иначе следующий тик соседнего блока подобрал бы их бакеты.
    for (const id of [armed, bare]) {
      await withIdentity(db, personal(g), (tx) =>
        tx.execute(sql`UPDATE entities SET props = props || '{"orbis/routine_stage":"paused"}'::jsonb
                       WHERE id = ${id}::uuid`),
      );
    }
  });

  test('M-2. отказ скрытого тула и операции пачки несёт провод {extension, reason: tool}', async () => {
    const { g, rec } = await setup();
    const tool = attachToolName(c.aspect);
    const wire = { code: 'MODULE_DISABLED', details: { extension: c.ext, reason: 'tool' } };
    expect(
      refusalOf(await dispatchTool(ownerChat(g), tool, { entity_id: rec, data: {} })),
    ).toMatchObject(wire);
    expect(
      refusalOf(
        await dispatchTool(ownerChat(g), 'batch_execute', {
          batch_id: newId(),
          operations: [{ tool, input: { entity_id: rec, data: {} } }],
        }),
      ),
    ).toMatchObject(wire);
    if (c.ext === 'finance') {
      // Действие выключенного расширения через `run_action` — `reason: 'action'`.
      expect(
        refusalOf(
          await dispatchTool(ownerChat(g), 'run_action', {
            action: 'finance/plan-to-fact',
            self: rec,
            params: { occurred_on: today },
          }),
        ),
      ).toMatchObject({
        code: 'MODULE_DISABLED',
        details: { extension: 'finance', reason: 'action' },
      });
    }
  });

  test('R-8. настройка его определений — MODULE_DISABLED (registry); снятие правила — проходит', async () => {
    const { g } = await setup();
    const registry = { code: 'MODULE_DISABLED', details: { extension: c.ext, reason: 'registry' } };
    // Включённое правило на его носителе.
    expect(
      refusalOf(await run(g, 'rule_set', carrierRule(c.aspect, `user_${c.ext}_post`))),
    ).toMatchObject({ ...registry, details: { ...registry.details, aspect: c.aspect } });
    // Дельта его аспекта (подпись) — настройка определения.
    expect(
      refusalOf(
        await run(g, 'aspect_delta_set', {
          aspect: c.aspect,
          delta: { label: { ru: 'Переименовано' } },
        }),
      ),
    ).toMatchObject(registry);
    // Правило на аспекте ЯДРА, ПИШУЩЕЕ его свойство (умолчание), — тоже: писало бы поле льготой
    // правил на ближайшей правке ядра (N-1: гейтятся адреса записи, не чтения).
    const own = [...BUILTIN_PROPERTY_META].find((p) => p.module === c.ext)?.id ?? '';
    expect(
      refusalOf(
        await run(g, 'rule_set', {
          target: { aspect: 'orbis/task' },
          rule: {
            id: `user_task_${c.ext}_default`,
            template: 'default',
            params: { property: own, value: { const: 'x' } },
          },
        }),
      ),
    ).toMatchObject({ ...registry, details: { ...registry.details, property: own } });
    // Снятие своего правила — разрешено.
    const removed = await run(g, 'rule_remove', {
      target: { aspect: c.aspect },
      rule: `user_${c.ext}_pre`,
    });
    expect(removed.ok).toBe(true);
  });

  test('9. включение возвращает тулы, канал, каталог и правку', async () => {
    const { g, rec, cat2 } = await setup();
    await setEnabled(g, c.ext, true);
    const ch = await channels(g);
    const attach = attachToolName(c.aspect);
    for (const defs of Object.values(ch)) expect(defs.map((d) => d.name)).toContain(attach);
    const prompt = await promptChannels(g);
    expect(prompt.chat).toContain(`- ${c.aspect} — `);
    for (const f of EXTENSION_MANIFESTS[c.ext].promptFragments)
      expect(prompt.chat).toContain(f.text);
    const out = await dispatchTool(ownerChat(g), 'property_catalog', {});
    if (out.status !== 'ok') throw new Error(`каталог: ${JSON.stringify(out)}`);
    const props = (out.result as { properties: Array<{ module: string | null }> }).properties;
    expect(props.some((p) => p.module === c.ext)).toBe(true);
    const edit = await run(g, 'entity_update', { id: rec, props: c.extEdit(cat2) });
    expect(edit.ok).toBe(true);
    // Настройка определений — снова открыта (R-8).
    expect((await run(g, 'rule_set', carrierRule(c.aspect, `user_${c.ext}_post`))).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Все четыре выключены: слой 5 целиком — ни одного id расширения, кроме исключений
// ---------------------------------------------------------------------------

test('все четыре выключены: JSON видимых тулов трёх каналов без единого следа расширений (кроме исключений Э-17)', async () => {
  const g = await newGraph();
  for (const ext of EXTENSION_IDS) await setEnabled(g, ext, false);
  const ch = await channels(g);
  for (const [name, defs] of Object.entries(ch)) {
    const leaks = EXTENSION_IDS.flatMap((ext) => leaksOf(defs, ext));
    expect({ name, leaks }).toEqual({ name, leaks: [] });
  }
  // Исключения не вырождены: каждое действительно встречается в своём тule — иначе оно лишнее.
  for (const x of LAYER5_EXCEPTIONS) {
    const def = ch.chat.find((d) => d.name === x.tool);
    expect(def).toBeDefined();
    expect(extensionIdsIn(JSON.stringify(def))).toContain(x.id);
  }
  // `subscription_set` не предлагается вовсе: поверхность ядра Повестки снята (1в §6.5), и
  // настраивать нечего; тул с пустым `enum` был бы вызовом, который нечем сделать.
  for (const defs of Object.values(ch)) {
    expect(defs.find((d) => d.name === 'subscription_set')).toBeUndefined();
  }
});

test('N-1: правило, которое свойство выключенного расширения лишь ЧИТАЕТ, заводится; пишущее — отказ (registry)', async () => {
  const g = await newGraph();
  await setEnabled(g, 'projects', false);
  const onStage = (id: string, set: { property: string; value: unknown }) => ({
    target: { aspect: 'orbis/task' },
    rule: {
      id,
      template: 'on_enter_class',
      params: { enter: { property: 'orbis/project_stage', in: ['done'] }, set },
    },
  });
  // Реагирует на стадию проекта (чтение), пишет только приоритет (ядро) — поле Проектов не пишет.
  const reads = await run(
    g,
    'rule_set',
    onStage('user_stage_done_priority', { property: 'orbis/priority', value: { const: 'high' } }),
  );
  expect(reads.ok ? 'ok' : `${reads.error.code}: ${reads.error.message}`).toBe('ok');
  // Пишет стадию проекта — запись поля выключенного расширения льготой правил.
  expect(
    refusalOf(
      await run(
        g,
        'rule_set',
        onStage('user_stage_done_stage', {
          property: 'orbis/project_stage',
          value: { const: 'paused' },
        }),
      ),
    ),
  ).toMatchObject({
    code: 'MODULE_DISABLED',
    details: { extension: 'projects', reason: 'registry', property: 'orbis/project_stage' },
  });
});

// ---------------------------------------------------------------------------
// Финансы: обходы маски (пункты 10–14)
// ---------------------------------------------------------------------------

describe('выключенные Финансы: обходы маски (С1б-4, пункты 10–14)', () => {
  test('10. шаблон повтора с orbis/financial не материализуется без warn и отказов; после включения догонка — не раньше today − 92', async () => {
    const g = await newGraph();
    const cat = await category(g);
    const start = addDays(today, -120);
    const templateId = await created(g, {
      title: 'Аренда',
      props: {
        'orbis/start_at': `${start}T09:00:00+03:00`,
        'orbis/timezone': TZ,
        'orbis/recurrence': { freq: 'daily', interval: 1 },
        'orbis/amount': '340.00',
        'orbis/currency': 'RUB',
        'orbis/direction': 'expense',
        'orbis/finance_category': cat,
        'orbis/recurring': true,
      },
      aspects: ['orbis/schedule', 'orbis/financial'],
    });
    await setEnabled(g, 'finance', false);
    const before = await counts(g);

    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    let off = -1;
    try {
      off = (
        await materializeInstances({
          db,
          identity: personal(g),
          from: start,
          to: addDays(today, 2),
          today,
        })
      ).created;
    } finally {
      console.warn = realWarn;
    }
    expect(off).toBe(0);
    expect(warns).toEqual([]);
    // Ни экземпляров, ни записей журнала отказов — граф не шелохнулся.
    expect(await counts(g)).toEqual(before);

    await setEnabled(g, 'finance', true);
    const on = await materializeInstances({
      db,
      identity: personal(g),
      from: start,
      to: today,
      today,
    });
    expect(on.created).toBeGreaterThan(0);
    const ids = (await withIdentity(db, personal(g), (tx) =>
      tx.execute(sql`SELECT id FROM entities WHERE id <> ${templateId}::uuid`),
    )) as unknown as Array<{ id: string }>;
    const have = new Set(ids.map((r) => r.id));
    const floor = addDays(today, -92);
    expect(have.has(recurringInstanceId(templateId, addDays(floor, -1)))).toBe(false);
    expect(have.has(recurringInstanceId(templateId, addDays(start, 1)))).toBe(false);
    expect(have.has(recurringInstanceId(templateId, floor))).toBe(true);
    expect(have.has(recurringInstanceId(templateId, today))).toBe(true);
  });

  test('11. postDueInstances при выключенных Финансах — {posted:0} и ничего не пишет (и через budgetOverview)', async () => {
    const g = await newGraph();
    const cat = await category(g);
    const start = addDays(today, -3);
    await created(g, {
      title: 'Подписка',
      props: {
        'orbis/start_at': `${start}T09:00:00+03:00`,
        'orbis/timezone': TZ,
        'orbis/recurrence': { freq: 'daily', interval: 1 },
        'orbis/amount': '500.00',
        'orbis/currency': 'RUB',
        'orbis/direction': 'expense',
        'orbis/finance_category': cat,
        'orbis/recurring': true,
      },
      aspects: ['orbis/schedule', 'orbis/financial'],
    });
    // Экземпляры рождаются при включённых Финансах — плановые, со сроком в прошлом.
    const born = await materializeInstances({
      db,
      identity: personal(g),
      from: start,
      to: today,
      today,
    });
    expect(born.created).toBeGreaterThan(0);
    const plannedDue = async () =>
      (
        (await withIdentity(db, personal(g), (tx) =>
          tx.execute(sql`SELECT count(*)::int AS n FROM entities
                         WHERE 'orbis/financial' = ANY(aspects)
                           AND (props->>'orbis/planned')::boolean = true
                           AND props->>'orbis/occurred_on' <= ${today}`),
        )) as unknown as Array<{ n: number }>
      )[0]?.n ?? 0;
    expect(await plannedDue()).toBeGreaterThan(0);

    await setEnabled(g, 'finance', false);
    const before = await counts(g);
    const due = await plannedDue();
    expect(await postDueInstances({ db, identity: personal(g), today })).toEqual({ posted: 0 });
    await budgetOverview(db, personal(g));
    expect(await plannedDue()).toBe(due);
    expect(await counts(g)).toEqual(before);
  });

  test('12. budget.confirmPurchase → FORBIDDEN (MODULE_DISABLED)', async () => {
    const g = await newGraph();
    const cat = await category(g);
    const purchase = await created(g, {
      title: 'Наушники',
      props: {
        'orbis/amount': '9000.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': cat,
        'orbis/occurred_on': addDays(today, 3),
        'orbis/planned': true,
      },
      aspects: ['orbis/financial'],
    });
    await setEnabled(g, 'finance', false);
    const before = await counts(g);
    const r = await trpcRefusal(
      callerOf(g).budget.confirmPurchase({
        entityId: purchase,
        occurredOn: today,
        batchId: newId(),
      }),
    );
    expect(r.code).toBe('FORBIDDEN');
    expect(r.cause).toMatchObject({ code: 'MODULE_DISABLED', details: { extension: 'finance' } });
    // Маска — ДО резолва, как у `run_action`: цель, которой нет (резолв ответил бы NOT_FOUND),
    // получает тот же отказ расширения — действие выключенного расширения целей не читает.
    const fact = await trpcRefusal(
      callerOf(g).budget.confirmPurchase({
        entityId: newId(),
        occurredOn: today,
        batchId: newId(),
      }),
    );
    expect(fact.cause).toMatchObject({ code: 'MODULE_DISABLED' });
    expect(await counts(g)).toEqual(before);
  });

  test('13. import.analyze / review / confirm → FORBIDDEN (MODULE_DISABLED)', async () => {
    const g = await newGraph();
    const cat = await category(g);
    await setEnabled(g, 'finance', false);
    // Провайдер модели в контексте — как у боевого `makeAiDeps`: без него `analyze` упал бы на
    // `defaultAiDeps()` раньше гейта, и тест проверял бы обвязку, а не гейт. Скрипт пуст: гейт
    // обязан ответить ДО обращения к модели (иначе ScriptedProvider бросит «скрипт исчерпан»).
    const provider = new ScriptedProvider([]);
    const caller = createCaller({
      identity: personal(g),
      actorKind: 'owner',
      db,
      clientVersion: null,
      ai: { provider, model: 'scripted-model' },
    });
    const row = {
      occurredOn: today,
      amount: '340.00',
      direction: 'expense' as const,
      counterparty: 'Кофе Хауз',
      raw: `${today};340.00;Кофе Хауз`,
      rowIndex: 0,
    };
    const fileHash = 'd'.repeat(64);
    const namespace = 'csv:tinkoff-c3';
    const refusals = [
      await trpcRefusal(caller.import.analyze({ sampleRows: ['дата;сумма;описание'] })),
      await trpcRefusal(caller.import.review({ rows: [row], fileHash, namespace })),
      await trpcRefusal(
        caller.import.confirm({
          batchId: newId(),
          namespace,
          fileHash,
          items: [{ row, action: 'create', categoryRef: cat }],
        }),
      ),
    ];
    for (const r of refusals) {
      expect(r.code).toBe('FORBIDDEN');
      expect(r.cause).toMatchObject({ code: 'MODULE_DISABLED', details: { extension: 'finance' } });
    }
    expect(provider.requests).toHaveLength(0); // токены на выписку не потрачены
  });

  test('M-5. поверхность Бюджета: enum subscription_set её не предлагает, запись по угаданному адресу — MODULE_DISABLED', async () => {
    const g = await newGraph();
    const surface = 'finance/budget-overview';
    const on = await channels(g);
    const subOn = on.chat.find((d) => d.name === 'subscription_set');
    expect(JSON.stringify(subOn)).toContain(surface); // сторож не вырожден: при включённых — есть
    await setEnabled(g, 'finance', false);
    const off = await channels(g);
    // Поверхность Бюджета — единственная с 1в (§6.5): без неё тул не предлагается вовсе, а не
    // несёт пустой `enum`.
    for (const defs of Object.values(off)) {
      expect(defs.find((d) => d.name === 'subscription_set')).toBeUndefined();
      expect(JSON.stringify(defs)).not.toContain(surface);
    }
    const definition = BUILTIN_SUBSCRIPTION_DEFS.find(
      (x) => x.id === 'orbis/budget-overview',
    )?.definition;
    expect(definition).toBeDefined();
    for (const id of ['orbis/budget-overview', 'user/my-budget']) {
      expect(
        refusalOf(await run(g, 'subscription_set', { id, surface, definition })),
      ).toMatchObject({
        code: 'MODULE_DISABLED',
        details: { extension: 'finance', surface },
      });
    }
  });

  test('R-8. слияние в поле Финансов и T-правило на их свойство — отказ (registry); после включения — проходят', async () => {
    const g = await newGraph();
    const cat = await category(g);
    // Своё свойство и запись с его значением — при включённых Финансах.
    const prop = await run(g, 'property_create', {
      key: 'user/moy-kontragent',
      label: { ru: 'Мой контрагент' },
      description: { ru: 'Кому платил' },
      type: { kind: 'text' },
      status: 'active',
    });
    expect(prop.ok).toBe(true);
    const note = await created(g, {
      title: 'Заметка с контрагентом',
      props: { 'user/moy-kontragent': 'Кофе Хауз' },
      aspects: ['orbis/note'],
    });
    await setEnabled(g, 'finance', false);
    const registry = {
      code: 'MODULE_DISABLED',
      details: { extension: 'finance', reason: 'registry' },
    };
    // Пробой I-1: слияние переносит значения в строки записей — это запись поля Финансов.
    expect(
      refusalOf(
        await run(g, 'property_merge', {
          source: 'user/moy-kontragent',
          into: 'orbis/counterparty',
        }),
      ),
    ).toMatchObject({
      ...registry,
      details: { ...registry.details, property: 'orbis/counterparty' },
    });
    expect((await propsOf(g, note))['orbis/counterparty']).toBeUndefined();
    // T-правило `default` на свойство Финансов, носитель — ядро: писало бы поле на правке ядра.
    const defaultRule = {
      target: { aspect: 'orbis/task' },
      rule: {
        id: 'user_task_category_default',
        template: 'default',
        params: { property: 'orbis/finance_category', value: { const: cat } },
      },
    };
    expect(refusalOf(await run(g, 'rule_set', defaultRule))).toMatchObject({
      ...registry,
      details: { ...registry.details, property: 'orbis/finance_category' },
    });
    // Отключённое правило поле не пишет — разрешено.
    expect(
      (
        await run(g, 'rule_set', {
          ...defaultRule,
          rule: { ...defaultRule.rule, id: 'user_task_category_off', enabled: false },
        })
      ).ok,
    ).toBe(true);

    await setEnabled(g, 'finance', true);
    expect((await run(g, 'rule_set', defaultRule)).ok).toBe(true);
    expect(
      (
        await run(g, 'property_merge', {
          source: 'user/moy-kontragent',
          into: 'orbis/counterparty',
        })
      ).ok,
    ).toBe(true);
    expect((await propsOf(g, note))['orbis/counterparty']).toBe('Кофе Хауз');
  });

  test('N-2. навешивание своего аспекта со свойством Финансов в составе: без значения — проходит; значение ставится или снимается — read_only', async () => {
    const g = await newGraph();
    const own = await run(g, 'aspect_create', {
      key: 'user/purchase',
      label: { ru: 'Покупка' },
      description: { ru: 'Своя покупка владельца' },
      properties: [{ propertyId: 'orbis/counterparty', required: false }],
    });
    if (!own.ok) throw new Error(`свой аспект: ${own.error.code} — ${own.error.message}`);
    const bare = await created(g, {
      title: 'Заметка без контрагента',
      props: {},
      aspects: ['orbis/note'],
    });
    const withValue = await created(g, {
      title: 'Заметка с контрагентом',
      props: { 'orbis/counterparty': 'Кофе Хауз' },
      aspects: ['orbis/note'],
    });
    await setEnabled(g, 'finance', false);
    const readOnly = {
      code: 'MODULE_DISABLED',
      details: { extension: 'finance', reason: 'read_only', property: 'orbis/counterparty' },
    };
    // Снимать нечего и ставить нечего — поле расширения не меняется, навешивание законно.
    expect((await run(g, 'attach_user_purchase', { entity_id: bare, data: {} })).ok).toBe(true);
    // Значение ставится — запись поля.
    const other = await created(g, { title: 'Ещё заметка', props: {}, aspects: ['orbis/note'] });
    expect(
      refusalOf(
        await run(g, 'attach_user_purchase', {
          entity_id: other,
          data: { 'orbis/counterparty': 'Такси' },
        }),
      ),
    ).toMatchObject(readOnly);
    // Значение было и снимается навешиванием без него — тоже запись поля.
    expect(
      refusalOf(await run(g, 'attach_user_purchase', { entity_id: withValue, data: {} })),
    ).toMatchObject(readOnly);
    expect((await propsOf(g, withValue))['orbis/counterparty']).toBe('Кофе Хауз');
  });

  test('14. правило памяти с областью orbis/money-movement создаётся и доходит до модели (язык жив)', async () => {
    const g = await newGraph();
    const cat = await category(g, 'Такси');
    await setEnabled(g, 'finance', false);
    const rule = await run(g, 'entity_create', {
      title: 'такси → Такси',
      tags: [],
      props: {
        'orbis/memory_kind': 'rule',
        'orbis/rule_pattern': 'такси',
        'orbis/rule_target': cat,
        'orbis/rule_scope': 'orbis/money-movement',
      },
      aspects: ['orbis/memory'],
    });
    expect(rule.ok).toBe(true);
    // Правило применяется моделью: слой памяти канала несёт его подписью «образец → категория»,
    // собранной из ссылки на категорию — запись выключенного расширения разыменовывается.
    const { chat } = await promptChannels(g);
    expect(chat).toContain('такси → Такси');
  });
});
