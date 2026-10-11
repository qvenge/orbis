// Настройки владельца возвращаются той же транзакцией, что пишет журнал.
import { afterAll, describe, expect, test } from 'bun:test';
import { appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { actionsOf, journalOf, undoRecordOf } from '../../test/journal-helpers';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import { appRouter } from '../router';
import { seedOwner } from '../seed/onboarding';
import { createCallerFactory } from '../trpc';

requireEnv();
const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);
afterAll(() => client.end());
async function owner() {
  const graph = await freshGraph();
  await seedOwner(db, personal(graph));
  return {
    graph,
    caller: createCaller({
      identity: personal(graph),
      actorKind: 'owner',
      db,
      clientVersion: null,
    }),
  };
}
describe('настройки через executor (§10.2 п. 1)', () => {
  test('ручка возвращает настройки и JournalRef из единственной транзакции', async () => {
    const { graph, caller } = await owner();
    let transactions = 0;
    const observedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction')
          return (...args: Parameters<typeof db.transaction>) => {
            transactions += 1;
            return target.transaction(...args);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const c = createCaller({
      identity: personal(graph),
      actorKind: 'owner',
      db: observedDb,
      clientVersion: null,
    });
    const result = await c.user.updateSettings({ timezone: 'UTC' });
    expect(transactions).toBe(1);
    expect(result).toEqual({
      ...(await caller.user.getSettings()),
      actionId: expect.any(String),
      consequences: false,
    });
  });
  test('сбой синка откатывает и настройки, и уже вставленную запись журнала', async () => {
    const { graph, caller } = await owner();
    const before = await caller.user.getSettings();
    const count = (await actionsOf(graph)).length;
    const sink = makeJournalSink();
    await expect(
      execute(
        db,
        {
          identity: personal(graph),
          actorKind: 'owner',
          source: 'ui',
          operations: [{ tool: 'settings_set', input: { timezone: 'UTC' } }],
        },
        {
          sink: {
            ...sink,
            async write(tx, entry) {
              await sink.write(tx, entry);
              throw new Error('контроль отката транзакции');
            },
          },
        },
      ),
    ).rejects.toThrow('контроль отката транзакции');
    expect(await caller.user.getSettings()).toEqual(before);
    expect((await actionsOf(graph)).length).toBe(count);
  });

  test('правка — одна запись журнала, настройки той же транзакции; отмена возвращает прежнее', async () => {
    const { graph, caller } = await owner();
    const before = await caller.user.getSettings();
    const count = (await actionsOf(graph)).length;
    const r = await caller.user.updateSettings({ timezone: 'Asia/Almaty', weekStartDay: 'sunday' });
    expect(r.timezone).toBe('Asia/Almaty');
    expect(r.weekStartDay).toBe('sunday');
    expect(typeof r.actionId).toBe('string');
    expect(r.consequences).toBe(false);
    expect((await actionsOf(graph)).length).toBe(count + 1);
    const entry = await journalOf(graph, r.actionId);
    expect(entry?.type).toBe('settings_set');
    expect(entry?.entityId).toBeNull();
    expect(entry?.title).toBe('Настройки: часовой пояс, начало недели');
    expect(entry?.inverse).toEqual([
      {
        op: 'settings_set',
        payload: { timezone: before.timezone, weekStartDay: before.weekStartDay },
      },
    ]);
    await caller.ai.undo({ actionId: r.actionId });
    const after = await caller.user.getSettings();
    expect([after.timezone, after.weekStartDay]).toEqual([before.timezone, before.weekStartDay]);
    expect(await undoRecordOf(graph, r.actionId)).toBeDefined();
  });
  test('пустая правка и невалидная зона — отказ схемы без журнала', async () => {
    const { graph, caller } = await owner();
    const count = (await actionsOf(graph)).length;
    await expect(caller.user.updateSettings({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.user.updateSettings({ timezone: 'Mars/Olympus' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect((await actionsOf(graph)).length).toBe(count);
  });
  test('не владелец — FORBIDDEN_LEVEL в самом executor (защита в глубину)', async () => {
    const graph = await freshGraph();
    for (const actorKind of ['ai', 'agent'] as const) {
      const r = await execute(
        db,
        {
          identity: personal(graph),
          actorKind,
          source: 'chat',
          operations: [{ tool: 'settings_set', input: { timezone: 'UTC' } }],
        },
        { sink: makeJournalSink() },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_LEVEL');
    }
    expect(await actionsOf(graph)).toEqual([]);
  });
  test('прикладные поля сохраняются, inverse несёт только тронутые поля', async () => {
    const { graph, caller } = await owner();
    const before = await caller.user.getSettings();
    const input = {
      defaultCurrency: 'USD',
      tagColors: { work: 'red' },
      installedViews: ['mine'],
      pinnedEntities: [{ id: crypto.randomUUID(), order: 1 }],
      viewPreferences: { mine: { layout: 'list' } },
    };
    const result = await caller.user.updateSettings(input);
    expect(result).toMatchObject(input);
    expect(result.timezone).toBe(before.timezone);
    expect((await journalOf(graph, result.actionId))?.inverse).toEqual([
      {
        op: 'settings_set',
        payload: Object.fromEntries(
          Object.keys(input).map((k) => [k, before[k as keyof typeof before]]),
        ),
      },
    ]);
    await caller.ai.undo({ actionId: result.actionId });
    expect(await caller.user.getSettings()).toEqual({ ...before, updatedAt: expect.any(String) });
  });
});
