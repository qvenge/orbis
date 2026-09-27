// apps/server/src/routers/apps.test.ts
// Действия владельца над записью-приложением (срез 1б §8.6, РП-12): выключение и архив — ОДНА
// пачка (`entity_update` приложения + `module_set` отмеченных расширений), один Undo; оболочку
// хоста выключить и заархивировать нельзя; правка «Состава» маску не меняет (С1б-11).
// Против живой БД через createCallerFactory, как в бою.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  APP_ASPECT,
  APP_DISABLED,
  APP_EXTENSIONS,
  type GraphId,
  SUPPLY_ASPECT,
  SUPPLY_KEY,
} from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ActionRecord, ExecuteResult, WireEntity } from '../executor/types';
import { disabledExtensionsOf } from '../registry/extensions';
import { appRouter } from '../router';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';

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

function callerFor(graph: GraphId, actorKind: 'owner' | 'agent' = 'owner') {
  return createCaller({ identity: personal(graph), actorKind, db, clientVersion: null });
}

async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

function okId(r: ExecuteResult): string {
  if (!r.ok) throw new Error(`ожидался успех, получено ${JSON.stringify(r.error)}`);
  return (r.results[0] as WireEntity).id;
}

async function createApp(graph: GraphId, title: string, props: Record<string, unknown> = {}) {
  return okId(
    await execute(
      db,
      {
        identity: personal(graph),
        actorKind: 'owner',
        source: 'ui',
        operations: [
          { tool: 'entity_create', input: { title, tags: [], aspects: [APP_ASPECT], props } },
        ],
      },
      { sink },
    ),
  );
}

/** Оболочка хоста так, как её заводит сев графа: механизмом `supply` (флаг `writer`). */
async function createHostShell(graph: GraphId): Promise<string> {
  return okId(
    await execute(
      db,
      {
        identity: personal(graph),
        actorKind: 'owner',
        source: 'ui',
        mechanism: 'supply',
        operations: [
          {
            tool: 'entity_create',
            input: {
              title: 'Orbis',
              tags: [],
              aspects: [APP_ASPECT, SUPPLY_ASPECT],
              props: { [SUPPLY_KEY]: 'host-shell' },
            },
          },
        ],
      },
      { sink },
    ),
  );
}

async function mask(graph: GraphId): Promise<readonly string[]> {
  return withIdentity(db, personal(graph), (tx) => disabledExtensionsOf(tx, graph));
}

async function rowOf(
  graph: GraphId,
  id: string,
): Promise<{ disabled: unknown; archived: boolean }> {
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.execute(
      sql`SELECT props -> ${APP_DISABLED} AS disabled, archived FROM entities WHERE id = ${id}::uuid`,
    ),
  );
  const row = rows[0] as { disabled: unknown; archived: boolean } | undefined;
  if (row === undefined) throw new Error('запись не найдена');
  return { disabled: row.disabled ?? undefined, archived: row.archived };
}

async function actionsOf(graph: GraphId, actionId: string): Promise<ActionRecord[]> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const rows = await withIdentity(db, personal(graph), (tx) =>
    tx.execute(sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb`),
  );
  return rows.flatMap((r) =>
    ((r.metadata as { actions?: ActionRecord[] }).actions ?? []).filter((a) => a.id === actionId),
  );
}

test('setDisabled(A, true, [goals]) — «Выключено» и маска одним action; ai.undo возвращает оба', async () => {
  const graph = await freshGraph();
  const a = await createApp(graph, 'Цели', { [APP_EXTENSIONS]: ['goals'] });
  const r = await callerFor(graph).app.setDisabled({
    appId: a,
    disabled: true,
    extensions: ['goals'],
  });
  expect((await rowOf(graph, a)).disabled).toBe(true);
  expect(await mask(graph)).toEqual(['goals']);

  const actions = await actionsOf(graph, r.actionId);
  expect(actions).toHaveLength(1);
  expect(actions[0]?.operations.map((o) => o.op)).toEqual(['entity_update', 'module_set']);

  await callerFor(graph).ai.undo({ actionId: r.actionId });
  expect((await rowOf(graph, a)).disabled).toBeUndefined();
  expect(await mask(graph)).toEqual([]);
});

test('setDisabled(A, false, [goals]) — включение: «Выключено» снято, расширение включено', async () => {
  const graph = await freshGraph();
  const a = await createApp(graph, 'Цели', { [APP_EXTENSIONS]: ['goals'] });
  await callerFor(graph).app.setDisabled({ appId: a, disabled: true, extensions: ['goals'] });
  await callerFor(graph).app.setDisabled({ appId: a, disabled: false, extensions: ['goals'] });
  expect((await rowOf(graph, a)).disabled).toBeUndefined();
  expect(await mask(graph)).toEqual([]);
});

test('агент не может выключить и заархивировать приложение (ownerOnly)', async () => {
  const graph = await freshGraph();
  const a = await createApp(graph, 'Цели');
  const agent = callerFor(graph, 'agent');
  expect(
    (await trpcError(agent.app.setDisabled({ appId: a, disabled: true, extensions: [] }))).code,
  ).toBe('FORBIDDEN');
  expect((await trpcError(agent.app.archive({ appId: a, disableExtensions: [] }))).code).toBe(
    'FORBIDDEN',
  );
  expect(await rowOf(graph, a)).toEqual({ disabled: undefined, archived: false });
});

test('оболочку хоста не выключить и не заархивировать — отказ VALIDATION', async () => {
  const graph = await freshGraph();
  const shell = await createHostShell(graph);
  const owner = callerFor(graph);
  const off = await trpcError(
    owner.app.setDisabled({ appId: shell, disabled: true, extensions: [] }),
  );
  expect(off.code).toBe('BAD_REQUEST');
  expect(off.message).toContain('приложение хоста не выключается');
  const gone = await trpcError(owner.app.archive({ appId: shell, disableExtensions: [] }));
  expect(gone.code).toBe('BAD_REQUEST');
  expect(await rowOf(graph, shell)).toEqual({ disabled: undefined, archived: false });
});

test('запись без аспекта «приложение» — отказ, не выключение', async () => {
  const graph = await freshGraph();
  const note = okId(
    await execute(
      db,
      {
        identity: personal(graph),
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool: 'entity_create', input: { title: 'Заметка', tags: [] } }],
      },
      { sink },
    ),
  );
  const err = await trpcError(
    callerFor(graph).app.setDisabled({ appId: note, disabled: true, extensions: ['goals'] }),
  );
  expect(err.code).toBe('BAD_REQUEST');
  expect(await mask(graph)).toEqual([]);
});

test('archive(A, [goals]) — A в архиве и расширение выключено одним action; Undo возвращает оба', async () => {
  const graph = await freshGraph();
  const a = await createApp(graph, 'Цели', { [APP_EXTENSIONS]: ['goals'] });
  const r = await callerFor(graph).app.archive({ appId: a, disableExtensions: ['goals'] });
  expect((await rowOf(graph, a)).archived).toBe(true);
  expect(await mask(graph)).toEqual(['goals']);
  const actions = await actionsOf(graph, r.actionId);
  expect(actions).toHaveLength(1);

  await callerFor(graph).ai.undo({ actionId: r.actionId });
  expect((await rowOf(graph, a)).archived).toBe(false);
  expect(await mask(graph)).toEqual([]);
});

test('правка «Состава» агентом маску НЕ меняет (С1б-11)', async () => {
  const graph = await freshGraph();
  const a = await createApp(graph, 'Цели');
  const d = await dispatchTool(
    { db, identity: personal(graph), actorKind: 'agent', source: 'mcp', explicitCommand: false },
    'entity_update',
    { id: a, props: { [APP_EXTENSIONS]: ['goals', 'finance'] } },
  );
  if (d.status !== 'ok') throw new Error(`ожидался ok, получено ${JSON.stringify(d)}`);
  expect(await mask(graph)).toEqual([]);
});

test('архивное приложение не выключить и не «удалить» повторно — отказ VALIDATION «приложение в архиве» (M-5)', async () => {
  const graph = await freshGraph();
  const a = await createApp(graph, 'Цели', { [APP_EXTENSIONS]: ['goals'] });
  const owner = callerFor(graph);
  await owner.app.archive({ appId: a, disableExtensions: [] });
  for (const call of [
    () => owner.app.archive({ appId: a, disableExtensions: ['goals'] }),
    () => owner.app.setDisabled({ appId: a, disabled: true, extensions: ['goals'] }),
  ]) {
    const err = await trpcError(call());
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toContain('приложение в архиве');
  }
  expect(await mask(graph)).toEqual([]);
  expect((await rowOf(graph, a)).disabled).toBeUndefined();
});
