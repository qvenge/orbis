// Ответы владельческих мутаций сверяются с настоящим журналом: id ответа должен адресовать действие, а не запись отмены.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BUDGET_DEF, type GraphId, newId } from '@orbis/shared';
import { OWN_ACTION_DECL } from '../../test/fixtures/action-seed';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { actionsOf, journalOf, undoRecordOf } from '../../test/journal-helpers';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import { createPending } from '../policy/pending';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();
const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);
const callerFor = (g: GraphId) =>
  createCaller({ identity: personal(g), actorKind: 'owner', db, clientVersion: null });
beforeAll(truncateAll);
afterAll(() => client.end());

async function ref(g: GraphId, result: unknown, consequences: boolean) {
  expect(typeof (result as { actionId?: unknown }).actionId).toBe('string');
  expect((result as { consequences?: unknown }).consequences).toBe(consequences);
  const actionId = (result as { actionId: string }).actionId;
  const action = await journalOf(g, actionId);
  expect(action?.id).toBe(actionId);
  expect(action?.source).not.toBe('system');
  return action;
}

describe('JournalRef: последствия из результата исполнителя', () => {
  test('галочка дописывает штамп, тег не считается последствием; обычная пачка и её повтор сохраняют признак', async () => {
    const g = await freshGraph();
    const c = callerFor(g);
    const e = await c.entity.create({
      input: {
        title: 'Задача',
        tags: [],
        aspects: ['orbis/task'],
        props: { 'orbis/task_status': 'inbox' },
      },
      source: 'ui',
    });
    await ref(g, e, false);
    const tagged = await c.entity.update({ id: e.id, tags: ['важное'] });
    await ref(g, tagged, false);
    const done = await c.entity.update({ id: e.id, props: { 'orbis/task_status': 'done' } });
    await ref(g, done, true);
    expect(done.props['orbis/completed_at']).toBeDefined();
    const batchId = newId();
    const request = {
      identity: personal(g),
      actorKind: 'owner' as const,
      source: 'ui' as const,
      batchId,
      operations: [
        { tool: 'entity_update', input: { id: e.id, props: { 'orbis/task_status': 'inbox' } } },
      ],
    };
    const first = await execute(db, request, { sink: makeJournalSink() });
    const replay = await execute(db, request, { sink: makeJournalSink() });
    await ref(g, first, true);
    await ref(g, replay, true);
    expect(replay).toMatchObject({ idempotentReplay: true });
    const changedInput = await execute(
      db,
      {
        ...request,
        operations: [{ tool: 'entity_update', input: { id: e.id, tags: ['чужой повтор'] } }],
      },
      { sink: makeJournalSink() },
    );
    await ref(g, changedInput, true);
    expect((await journalOf(g, batchId))?.consequences).toBe(true);
    const plain = await c.entity.updateBatch({
      operations: [{ tool: 'entity_update', input: { id: e.id, tags: ['другое'] } }],
    });
    await ref(g, plain, false);
    expect(plain.results).toHaveLength(1);
  });

  test('выход из waiting снимает waiting_for; засев проекта — последствие, явное тело — нет', async () => {
    const g = await freshGraph();
    const c = callerFor(g);
    const task = await c.entity.create({
      input: {
        title: 'Ждёт',
        tags: [],
        aspects: ['orbis/task'],
        props: { 'orbis/task_status': 'waiting', 'orbis/waiting_for': 'Ответ' },
      },
      source: 'ui',
    });
    const ready = await c.entity.update({ id: task.id, props: { 'orbis/task_status': 'planned' } });
    await ref(g, ready, true);
    expect(ready.props['orbis/waiting_for']).toBeUndefined();
    const note = await c.entity.create({
      input: { title: 'Будущий проект', tags: [] },
      source: 'ui',
    });
    const seeded = await c.entity.update({
      id: note.id,
      aspects: { attach: ['orbis/project'] },
      props: { 'orbis/project_stage': 'active' },
    });
    await ref(g, seeded, true);
    expect(seeded.body.length).toBeGreaterThan(0);
    const explicit = await c.entity.update({
      id: note.id,
      body: 'Свой текст',
      expectedBodyRevision: seeded.bodyRevision,
    });
    await ref(g, explicit, false);
  });

  test('autosave продолжает S; standalone create replay не выдумывает новое действие', async () => {
    const g = await freshGraph();
    const c = callerFor(g);
    const id = newId();
    const input = { id, title: 'Текст', tags: [], body: 'Начало' };
    const e = await c.entity.create({ input, source: 'ui' });
    const replay = await c.entity.create({ input, source: 'ui' });
    expect(replay).not.toHaveProperty('actionId');
    expect(replay).not.toHaveProperty('consequences');
    const a = await c.entity.update({
      id,
      body: 'Первое',
      expectedBodyRevision: e.bodyRevision,
      autosave: true,
    });
    const b = await c.entity.update({
      id,
      body: 'Второе',
      expectedBodyRevision: a.bodyRevision,
      autosave: true,
    });
    await ref(g, a, false);
    await ref(g, b, false);
    expect(b.actionId).toBe(a.actionId);
    expect(b.bodyAction?.actionId).toBe(a.actionId);
    expect(b.bodyAction?.textSession).toBe(true);
  });

  test('relation create/delete и переключение модуля сохраняют старую форму плюс ссылку', async () => {
    const g = await freshGraph();
    const c = callerFor(g);
    const a = await c.entity.create({ input: { title: 'Первое', tags: [] }, source: 'ui' });
    const b = await c.entity.create({ input: { title: 'Второе', tags: [] }, source: 'ui' });
    const input = { source_id: a.id, target_id: b.id, role: 'mention' };
    const edge = await c.relation.create(input);
    await ref(g, edge, false);
    expect(edge.sourceId).toBe(a.id);
    const removed = await c.relation.delete(input);
    await ref(g, removed, false);
    expect(removed.ok).toBe(true);
    const settings = await c.user.setModuleEnabled({ module: 'finance', enabled: false });
    await ref(g, settings, false);
    expect(settings.disabledModules).toContain('finance');
  });

  test('обычный approve/replay — действия, ai.undo и approve undo_of/replay — исключения К41', async () => {
    const g = await freshGraph();
    const c = callerFor(g);
    const e = await c.entity.create({ input: { title: 'Цель', tags: [] }, source: 'ui' });
    const { pendingId } = await withIdentity(db, personal(g), (tx) =>
      createPending(tx, {
        actor: { graphId: g, kind: 'ai', source: 'chat' },
        level: 'explicit-confirmation',
        tool: 'entity_update',
        input: { id: e.id, tags: ['метка'] },
      }),
    );
    const approved = await c.ai.approve({ pendingId });
    await ref(g, approved, false);
    await ref(g, await c.ai.approve({ pendingId }), false);
    const undo = await c.ai.undo({ actionId: approved.actionId });
    expect(undo).not.toHaveProperty('consequences');
    expect(undo.undone.id).toBe(approved.actionId);
    expect((await undoRecordOf(g, approved.actionId))?.id).toBe(undo.actionId);
    const { pendingId: undoPending } = await withIdentity(db, personal(g), (tx) =>
      createPending(tx, {
        actor: { graphId: g, kind: 'ai', source: 'chat' },
        level: 'explicit-confirmation',
        tool: 'entity_update',
        input: { id: e.id, archived: true },
        undoOf: e.actionId,
      }),
    );
    const count = (await actionsOf(g)).length;
    const cancellation = await c.ai.approve({ pendingId: undoPending });
    expect(cancellation).toMatchObject({ ok: true, actionId: e.actionId, idempotentReplay: false });
    expect(cancellation).not.toHaveProperty('consequences');
    const repeated = await c.ai.approve({ pendingId: undoPending });
    expect(repeated).toMatchObject({ actionId: e.actionId, idempotentReplay: true });
    expect(repeated).not.toHaveProperty('consequences');
    expect((await actionsOf(g)).length).toBe(count);
    expect(await undoRecordOf(g, e.actionId as string)).toBeDefined();
  });
});

test('все 16 registry процедур адресуют собственные записи журнала', async () => {
  const g = await freshGraph();
  const c = callerFor(g);
  const property = (key: string) => ({
    key,
    label: { ru: 'Поле' },
    description: { ru: 'Смысл' },
    type: { kind: 'number' },
    status: 'active' as const,
  });
  await ref(g, await c.registry.createProperty(property('user/ref-one')), false);
  await ref(
    g,
    await c.registry.updateProperty({ id: 'user/ref-one', label: { ru: 'Переименовано' } }),
    false,
  );
  await c.registry.createProperty(property('user/ref-two'));
  await ref(
    g,
    await c.registry.mergeProperty({ source: 'user/ref-one', into: 'user/ref-two' }),
    false,
  );
  await ref(
    g,
    await c.registry.setAspectDelta({
      aspect: 'orbis/note',
      delta: { properties: { add: [{ propertyId: 'user/ref-two', required: false, rank: 90 }] } },
    }),
    false,
  );
  await ref(g, await c.registry.removeAspectDelta({ aspect: 'orbis/note' }), false);
  await ref(
    g,
    await c.registry.createAspect({
      key: 'user/ref-aspect',
      label: { ru: 'Аспект' },
      description: { ru: 'Смысл' },
      properties: [{ propertyId: 'orbis/start_at', required: false }],
    }),
    false,
  );
  await ref(
    g,
    await c.registry.setAspectImplements({
      aspect: 'user/ref-aspect',
      implements: [{ contract: 'orbis/when', bind: { moment: 'orbis/start_at' }, value_map: [] }],
    }),
    false,
  );
  await ref(
    g,
    await c.registry.removeAspectImplements({ aspect: 'user/ref-aspect', contract: 'orbis/when' }),
    false,
  );
  await ref(
    g,
    await c.registry.setSubscription({
      id: 'orbis/budget-overview',
      surface: 'finance/budget-overview',
      definition: BUDGET_DEF,
    }),
    false,
  );
  await ref(g, await c.registry.removeSubscription({ id: 'orbis/budget-overview' }), false);
  await ref(
    g,
    await c.registry.setContractSetsDelta({
      contract: 'orbis/completable',
      setsDelta: { my_open: ['active'] },
    }),
    false,
  );
  await ref(g, await c.registry.removeContractSetsDelta({ contract: 'orbis/completable' }), false);
  await ref(g, await c.registry.setAction(OWN_ACTION_DECL), false);
  await ref(g, await c.registry.removeAction({ action: OWN_ACTION_DECL.key }), false);
  const rule = {
    id: 'ref_needs_due',
    template: 'requires_when' as const,
    params: { property: 'orbis/due_date' },
    when: { op: '=', args: [{ prop: 'orbis/priority' }, { const: 'high' }] },
  };
  await ref(g, await c.registry.setRule({ target: { aspect: 'orbis/task' }, rule }), false);
  await ref(
    g,
    await c.registry.removeRule({ target: { aspect: 'orbis/task' }, rule: rule.id }),
    false,
  );
}, 20000);
