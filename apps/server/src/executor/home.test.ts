// apps/server/src/executor/home.test.ts
// «Первое место задаёт дом» (срез 1б §4.3, Д-6): бездомная страница, поставленная домашней или
// разделом приложения A (A ≠ оболочка хоста), получает «Дом» = A — сервером, в ТОМ ЖЕ action с
// inverse, для любого актора. Предмет — рубеж записи, поэтому всё идёт через `execute()`,
// `dispatchTool` и tRPC-ручки, как в бою.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  APP_ASPECT,
  APP_HOME,
  APP_NAV,
  type GraphId,
  HOME_PROPERTY,
  newId,
  PAGE_ASPECT,
  SUPPLY_ASPECT,
  SUPPLY_KEY,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { appRouter } from '../router';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';
import { execute } from './executor';
import { makeChatJournalSink } from './journal';
import type { ActionRecord, ExecuteRequest, ExecuteResult, WireEntity } from './types';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);
const sink = makeChatJournalSink();

beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

function callerFor(graph: GraphId) {
  return createCaller({ identity: personal(graph), actorKind: 'owner', db, clientVersion: null });
}

function run(
  graph: GraphId,
  tool: string,
  input: Record<string, unknown>,
  mechanism?: ExecuteRequest['mechanism'],
): Promise<ExecuteResult> {
  return execute(
    db,
    {
      identity: personal(graph),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool, input }],
      ...(mechanism === undefined ? {} : { mechanism }),
    },
    { sink },
  );
}

function okId(r: ExecuteResult): string {
  if (!r.ok) throw new Error(`ожидался успех, получено ${JSON.stringify(r.error)}`);
  return (r.results[0] as WireEntity).id;
}

function okAction(r: ExecuteResult): string {
  if (!r.ok) throw new Error(`ожидался успех, получено ${JSON.stringify(r.error)}`);
  return r.actionId;
}

const page = (graph: GraphId, title: string) =>
  run(graph, 'entity_create', { title, tags: [], aspects: [PAGE_ASPECT] }).then(okId);

const app = (graph: GraphId, title: string, props: Record<string, unknown> = {}) =>
  run(graph, 'entity_create', { title, tags: [], aspects: [APP_ASPECT], props }).then(okId);

/** Оболочка хоста так, как её заводит сев графа: механизмом `supply` (флаг `writer`). */
const hostShell = (graph: GraphId) =>
  run(
    graph,
    'entity_create',
    {
      title: 'Orbis',
      tags: [],
      aspects: [APP_ASPECT, SUPPLY_ASPECT],
      props: { [SUPPLY_KEY]: 'host-shell' },
    },
    'supply',
  ).then(okId);

async function homeOf(graph: GraphId, id: string): Promise<unknown> {
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.execute(sql`SELECT props -> ${HOME_PROPERTY} AS home FROM entities WHERE id = ${id}::uuid`),
  );
  return rows[0]?.home ?? undefined;
}

async function propOf(graph: GraphId, id: string, prop: string): Promise<unknown> {
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.execute(sql`SELECT props -> ${prop} AS v FROM entities WHERE id = ${id}::uuid`),
  );
  return rows[0]?.v ?? undefined;
}

/** Записанный action по id — containment по GIN, как `findAction` эскалации. */
async function actionOf(graph: GraphId, actionId: string): Promise<ActionRecord[]> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.execute(sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb`),
  );
  return rows.flatMap((r) =>
    ((r.metadata as { actions?: ActionRecord[] }).actions ?? []).filter((a) => a.id === actionId),
  );
}

test('раздел навигации A → бездомная страница получает «Дом» = A в том же action; Undo снимает и раздел, и дом', async () => {
  const graph = await freshGraph();
  const p1 = await page(graph, 'P1');
  const a = await app(graph, 'Приложение A');

  const actionId = okAction(
    await run(graph, 'entity_update', { id: a, props: { [APP_NAV]: [p1] } }),
  );
  expect(await homeOf(graph, p1)).toBe(a);

  // Одна запись журнала: операции несут и раздел, и дом; inverse — снятие дома.
  const actions = await actionOf(graph, actionId);
  expect(actions).toHaveLength(1);
  const action = actions[0] as ActionRecord;
  const touched = action.operations
    .filter((o) => o.op === 'entity_update')
    .map((o) => (o.payload as { id: string }).id);
  expect(touched).toEqual([a, p1]);
  const inverseOfPage = action.inverse.find(
    (o) => o.op === 'entity_update' && (o.payload as { id: string }).id === p1,
  );
  expect(inverseOfPage).toBeDefined();
  expect(JSON.stringify(inverseOfPage?.payload)).toContain(HOME_PROPERTY);

  await callerFor(graph).ai.undo({ actionId });
  expect(await propOf(graph, a, APP_NAV)).toBeUndefined();
  expect(await homeOf(graph, p1)).toBeUndefined();
});

test('«Домашняя» A → бездомная страница получает «Дом» = A', async () => {
  const graph = await freshGraph();
  const p2 = await page(graph, 'P2');
  const a = await app(graph, 'Приложение A');
  okAction(await run(graph, 'entity_update', { id: a, props: { [APP_HOME]: p2 } }));
  expect(await homeOf(graph, p2)).toBe(a);
});

test('страница уже в навигации другого приложения B — не бездомная, дом не ставится', async () => {
  const graph = await freshGraph();
  const p1 = await page(graph, 'P1');
  const b = await app(graph, 'Приложение B');
  // Дом у P1 снят после постановки в B — страница «с пустым Домом», но не бездомная.
  okAction(await run(graph, 'entity_update', { id: b, props: { [APP_NAV]: [p1] } }));
  okAction(await run(graph, 'entity_update', { id: p1, unset: [HOME_PROPERTY] }));
  expect(await homeOf(graph, p1)).toBeUndefined();

  const a = await app(graph, 'Приложение A');
  okAction(await run(graph, 'entity_update', { id: a, props: { [APP_NAV]: [p1] } }));
  expect(await homeOf(graph, p1)).toBeUndefined();
});

test('страница в навигации ОБОЛОЧКИ ХОСТА (как «Daily Planning») — не бездомная, дом не ставится (Н-1)', async () => {
  const graph = await freshGraph();
  const p1 = await page(graph, 'Daily Planning');
  const shell = await hostShell(graph);
  okAction(await run(graph, 'entity_update', { id: shell, props: { [APP_NAV]: [p1] } }));
  // Оболочка хоста сама «Дом» не ставит (хост — пустой «Дом»).
  expect(await homeOf(graph, p1)).toBeUndefined();

  const a = await app(graph, 'Приложение A');
  okAction(await run(graph, 'entity_update', { id: a, props: { [APP_NAV]: [p1] } }));
  expect(await homeOf(graph, p1)).toBeUndefined();
});

test('страница — «Домашняя» приложения B (не раздел) — не бездомная, дом не ставится', async () => {
  const graph = await freshGraph();
  const p1 = await page(graph, 'P1');
  const b = await app(graph, 'Приложение B');
  okAction(await run(graph, 'entity_update', { id: b, props: { [APP_HOME]: p1 } }));
  okAction(await run(graph, 'entity_update', { id: p1, unset: [HOME_PROPERTY] }));

  const a = await app(graph, 'Приложение A');
  okAction(await run(graph, 'entity_update', { id: a, props: { [APP_NAV]: [p1] } }));
  expect(await homeOf(graph, p1)).toBeUndefined();
});

test('страница уже с «Домом» = B — дом не меняется', async () => {
  const graph = await freshGraph();
  const p1 = await page(graph, 'P1');
  const b = await app(graph, 'Приложение B');
  okAction(await run(graph, 'entity_update', { id: p1, props: { [HOME_PROPERTY]: b } }));
  const a = await app(graph, 'Приложение A');
  okAction(await run(graph, 'entity_update', { id: a, props: { [APP_NAV]: [p1] } }));
  expect(await homeOf(graph, p1)).toBe(b);
});

test('запись без аспекта «страница» в навигации — «Дом» не ставится', async () => {
  const graph = await freshGraph();
  const note = okId(await run(graph, 'entity_create', { title: 'Заметка', tags: [] }));
  const a = await app(graph, 'Приложение A');
  okAction(await run(graph, 'entity_update', { id: a, props: { [APP_NAV]: [note] } }));
  expect(await homeOf(graph, note)).toBeUndefined();
});

test('A — оболочка хоста: ничего не пишется (хост — пустой «Дом», Н-1)', async () => {
  const graph = await freshGraph();
  const p1 = await page(graph, 'P1');
  const p2 = await page(graph, 'P2');
  const shell = await hostShell(graph);
  const actionId = okAction(
    await run(graph, 'entity_update', { id: shell, props: { [APP_NAV]: [p1], [APP_HOME]: p2 } }),
  );
  expect(await homeOf(graph, p1)).toBeUndefined();
  expect(await homeOf(graph, p2)).toBeUndefined();
  const [action] = await actionOf(graph, actionId);
  expect(action?.operations.filter((o) => o.op === 'entity_update')).toHaveLength(1);
});

test('агент через dispatchTool `entity_update` — тот же результат', async () => {
  const graph = await freshGraph();
  const p1 = await page(graph, 'P1');
  const a = await app(graph, 'Приложение A');
  const d = await dispatchTool(
    { db, identity: personal(graph), actorKind: 'agent', source: 'mcp', explicitCommand: false },
    'entity_update',
    { id: a, props: { [APP_NAV]: [p1] } },
  );
  if (d.status !== 'ok') throw new Error(`ожидался ok, получено ${JSON.stringify(d)}`);
  expect(await homeOf(graph, p1)).toBe(a);
});

test('`entity_create` приложения с «Домашней» P1 одной пачкой → «Дом» P1 = новое приложение', async () => {
  const graph = await freshGraph();
  const p1 = await page(graph, 'P1');
  const appId = newId();
  const r = await callerFor(graph).entity.updateBatch({
    label: 'Новое приложение',
    operations: [
      {
        tool: 'entity_create',
        input: {
          id: appId,
          title: 'Новое приложение',
          tags: [],
          aspects: [APP_ASPECT],
          props: { [APP_HOME]: p1 },
        },
      },
    ],
  });
  expect(r.results).toHaveLength(1);
  expect(await homeOf(graph, p1)).toBe(appId);

  // Один Undo: приложение в архиве, дом снят.
  await callerFor(graph).ai.undo({ actionId: r.actionId });
  expect(await homeOf(graph, p1)).toBeUndefined();
});

test('откат возвращает раздел, но «Дом» НЕ довычисляет: Undo воспроизводит inverse и только их', async () => {
  const graph = await freshGraph();
  const p1 = await page(graph, 'P1');
  const a = await app(graph, 'Приложение A');
  okAction(await run(graph, 'entity_update', { id: a, props: { [APP_NAV]: [p1] } }));
  // Владелец снял «Дом» руками, потом убрал раздел: откат последнего возвращает раздел, а
  // бездомная страница, вернувшаяся в навигацию откатом, дом не получает — откат не пишет
  // сверх записанного inverse.
  okAction(await run(graph, 'entity_update', { id: p1, unset: [HOME_PROPERTY] }));
  const removed = okAction(await run(graph, 'entity_update', { id: a, unset: [APP_NAV] }));
  await callerFor(graph).ai.undo({ actionId: removed });
  expect(await propOf(graph, a, APP_NAV)).toEqual([p1]);
  expect(await homeOf(graph, p1)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Фикс-раунд 1 гейта (R-15 п. 2, M-3, M-4)
// ---------------------------------------------------------------------------

function runBatch(
  graph: GraphId,
  operations: Array<{ tool: string; input: Record<string, unknown> }>,
): Promise<ExecuteResult> {
  return execute(
    db,
    { identity: personal(graph), actorKind: 'owner', source: 'ui', batchId: newId(), operations },
    { sink },
  );
}

test('одна пачка ставит страницу в два приложения — «Дом» = первое по порядку операций (R-15 п. 2)', async () => {
  const graph = await freshGraph();
  const p1 = await page(graph, 'P1');
  const a = await app(graph, 'Приложение A');
  const b = await app(graph, 'Приложение B');
  okAction(
    await runBatch(graph, [
      { tool: 'entity_update', input: { id: a, props: { [APP_NAV]: [p1] } } },
      { tool: 'entity_update', input: { id: b, props: { [APP_NAV]: [p1] } } },
    ]),
  );
  expect(await homeOf(graph, p1)).toBe(a);

  // Обратный порядок операций — обратный «Дом».
  const p2 = await page(graph, 'P2');
  okAction(
    await runBatch(graph, [
      { tool: 'entity_update', input: { id: b, props: { [APP_HOME]: p2 } } },
      { tool: 'entity_update', input: { id: a, props: { [APP_HOME]: p2 } } },
    ]),
  );
  expect(await homeOf(graph, p2)).toBe(b);
});

test('пачка «раздел → архив A» проходит и «Дом» не ставит; «раздел → снять раздел» — тоже без «Дома» (M-3)', async () => {
  const graph = await freshGraph();
  const p1 = await page(graph, 'P1');
  const a = await app(graph, 'Приложение A');
  okAction(
    await runBatch(graph, [
      { tool: 'entity_update', input: { id: a, props: { [APP_NAV]: [p1] } } },
      { tool: 'entity_update', input: { id: a, archived: true } },
    ]),
  );
  expect(await homeOf(graph, p1)).toBeUndefined();

  const p2 = await page(graph, 'P2');
  const c = await app(graph, 'Приложение C');
  okAction(
    await runBatch(graph, [
      { tool: 'entity_update', input: { id: c, props: { [APP_NAV]: [p2] } } },
      { tool: 'entity_update', input: { id: c, unset: [APP_NAV] } },
    ]),
  );
  expect(await homeOf(graph, p2)).toBeUndefined();
});

test('attach аспекта «приложение» с навигацией — тот же «Дом», что у entity_update (M-4)', async () => {
  const graph = await freshGraph();
  const p1 = await page(graph, 'P1');
  const host = okId(await run(graph, 'entity_create', { title: 'Будущее приложение', tags: [] }));
  // Тула у модели нет (AUTHORING_DEFERRED_ASPECTS), но исполнитель его резолвит — прямым execute.
  okAction(await run(graph, 'attach_orbis_app', { entity_id: host, data: { [APP_NAV]: [p1] } }));
  expect(await homeOf(graph, p1)).toBe(host);
});
