import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { actionsOf as journalActionsOf } from '../../test/journal-helpers';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();
const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);
function callerFor(graph: GraphId) {
  return createCaller({ identity: personal(graph), actorKind: 'owner', db, clientVersion: null });
}
async function actionsOf(graph: GraphId): Promise<string[]> {
  return (await journalActionsOf(graph)).map((action) => action.id).sort();
}
async function customFields(api: ReturnType<typeof createCaller>) {
  const raw = await api.registry.createProperty({
    key: 'user/shared_title',
    label: { ru: 'Общий текст' },
    description: { ru: 'Общее поле двух аспектов' },
    type: { kind: 'text' },
    status: 'active',
  });
  const propertyId = (raw as { property: string }).property;
  await api.registry.createAspect({
    key: 'user/first',
    label: { ru: 'Первый' },
    description: { ru: 'Первый носитель' },
    properties: [{ propertyId, required: true }],
  });
  await api.registry.createAspect({
    key: 'user/second',
    label: { ru: 'Второй' },
    description: { ru: 'Второй носитель' },
    properties: [{ propertyId, required: false }],
  });
  const reg = await api.registry.effective();
  const first = reg.aspects.find((a) => a.key === 'user/first');
  const second = reg.aspects.find((a) => a.key === 'user/second');
  if (!first || !second) throw new Error('созданные аспекты не найдены');
  return { propertyId, first: first.id, second: second.id };
}
async function textField(api: ReturnType<typeof createCaller>, key: string) {
  const raw = await api.registry.createProperty({
    key,
    label: { ru: 'Текст' },
    description: { ru: 'Свободный текст' },
    type: { kind: 'text' },
    status: 'active',
  });
  return (raw as { property: string }).property;
}
beforeAll(truncateAll);
afterAll(() => client.end());

test('ПС-18: delete с исходной тройкой возвращает реальный Undo', async () => {
  const graph = await freshGraph();
  const api = createCaller({
    identity: personal(graph),
    actorKind: 'owner',
    db,
    clientVersion: null,
  });
  const source = await api.entity.create({ input: { title: 'Проект', tags: [] }, source: 'ui' });
  const target = await api.entity.create({ input: { title: 'Задача', tags: [] }, source: 'ui' });
  const key = { source_id: source.id, target_id: target.id, role: 'subitem' };
  const made = await api.relation.create(key);
  expect(made.actionId).toEqual(expect.any(String));
  expect(made.consequences).toEqual(expect.any(Boolean));
  if (!made.actionId) throw new Error('create не вернул actionId');
  await api.ai.undo({ actionId: made.actionId });
  expect(await api.relation.listFor({ entityId: source.id })).toEqual([]);
  await api.relation.create(key);
  const removed = await api.relation.delete(key);
  expect(removed.actionId).toEqual(expect.any(String));
  expect(removed.consequences).toEqual(expect.any(Boolean));
  if (!removed.actionId) throw new Error('мутация не вернула actionId');
  await api.ai.undo({ actionId: removed.actionId });
  const got = await api.entity.get({ id: target.id, include: ['relations'] });
  expect(
    got.relations?.filter((r) => r.sourceId === source.id && r.role === 'subitem'),
  ).toHaveLength(1);
  await expect(api.relation.create(key)).rejects.toThrow();
  await api.relation.delete(key);
  await expect(api.relation.delete(key)).rejects.toThrow('связь не найдена');
});

test('ПС-04: required поле и attach атомарны, одно действие и Undo', async () => {
  const graph = await freshGraph();
  const api = callerFor(graph);
  const { propertyId, first } = await customFields(api);
  const source = await api.entity.create({ input: { title: 'Заметка', tags: [] }, source: 'ui' });
  const before = await api.entity.get({ id: source.id, include: ['body', 'relations'] });
  const actions = await actionsOf(graph);
  await expect(
    api.entity.updateBatch({
      operations: [
        { tool: 'entity_update', input: { id: source.id, aspects: { attach: [first] } } },
      ],
    }),
  ).rejects.toThrow();
  expect(await api.entity.get({ id: source.id, include: ['body', 'relations'] })).toEqual(before);
  expect(await actionsOf(graph)).toEqual(actions);
  const made = await api.entity.updateBatch({
    operations: [
      {
        tool: 'entity_update',
        input: { id: source.id, aspects: { attach: [first] }, props: { [propertyId]: 'готово' } },
      },
    ],
  });
  expect((await actionsOf(graph)).filter((id) => !actions.includes(id))).toEqual([made.actionId]);
  const after = await api.entity.get({ id: source.id, include: [] });
  expect(after.entity.aspects).toContain(first);
  expect(after.entity.props[propertyId]).toBe('готово');
  await api.ai.undo({ actionId: made.actionId });
  const undone = await api.entity.get({ id: source.id, include: [] });
  expect(undone.entity.aspects).toEqual(before.entity.aspects);
  expect(undone.entity.props).toEqual(before.entity.props);
});

test('ПС-05/06: пользовательские общие и свободные поля', async () => {
  const graph = await freshGraph();
  const api = callerFor(graph);
  const { propertyId, first, second } = await customFields(api);
  const free = await textField(api, 'user/free');
  const source = await api.entity.create({ input: { title: 'Носитель', tags: [] }, source: 'ui' });
  await api.entity.updateBatch({
    operations: [
      {
        tool: 'entity_update',
        input: {
          id: source.id,
          aspects: { attach: [first, second] },
          props: { [propertyId]: 'общее', [free]: 'свободное' },
        },
      },
    ],
  });
  await api.entity.update({ id: source.id, aspects: { detach: [first] } });
  const afterDetach = await api.entity.get({ id: source.id, include: [] });
  expect(afterDetach.entity.aspects).not.toContain(first);
  expect(afterDetach.entity.aspects).toContain(second);
  expect(afterDetach.entity.props[propertyId]).toBe('общее');
  await api.entity.update({ id: source.id, unset: [free] });
  const afterUnset = await api.entity.get({ id: source.id, include: [] });
  expect(afterUnset.entity.props[free]).toBeUndefined();
  expect(afterUnset.entity.props[propertyId]).toBe('общее');
  expect(afterUnset.entity.aspects).toEqual(afterDetach.entity.aspects);
  expect((await api.registry.effective()).properties.find((p) => p.id === free)).toBeDefined();
});

test('ПС-11: полная валидация изменённого массива', async () => {
  const graph = await freshGraph();
  const api = callerFor(graph);
  const text = await textField(api, 'user/text');
  const raw = await api.registry.createProperty({
    key: 'user/tasks',
    label: { ru: 'Задачи' },
    description: { ru: 'Ссылки на задачи' },
    type: { kind: 'ref', cardinality: 'many', target: { filter: { aspect: 'orbis/task' } } },
    status: 'active',
  });
  const list = (raw as { property: string }).property;
  const task = (title: string) =>
    api.entity.create({ input: { title, tags: [], aspects: ['orbis/task'] }, source: 'ui' });
  const archived = await task('Старая');
  const valid = await task('Сохранённая');
  const validNew = await task('Новая');
  const source = await api.entity.create({
    input: {
      title: 'Носитель',
      tags: [],
      props: { [text]: 'до', [list]: [archived.id, valid.id] },
    },
    source: 'ui',
  });
  await api.entity.update({ id: archived.id, archived: true });
  await api.entity.update({ id: source.id, props: { [text]: 'после' } });
  const before = await api.entity.get({ id: source.id, include: ['relations'] });
  expect(before.entity.props[list]).toEqual([archived.id, valid.id]);
  const actions = await actionsOf(graph);
  await expect(
    api.entity.updateBatch({
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: source.id,
            props: { [text]: 'не должно лечь', [list]: [archived.id, validNew.id] },
          },
        },
      ],
    }),
  ).rejects.toThrow();
  expect(await api.entity.get({ id: source.id, include: ['relations'] })).toEqual(before);
  expect(await actionsOf(graph)).toEqual(actions);
  const removed = await api.entity.updateBatch({
    operations: [
      { tool: 'entity_update', input: { id: source.id, props: { [list]: [valid.id] } } },
    ],
  });
  expect((await api.entity.get({ id: source.id, include: [] })).entity.props[list]).toEqual([
    valid.id,
  ]);
  if (!removed.actionId) throw new Error('мутация не вернула actionId');
  await api.ai.undo({ actionId: removed.actionId });
  expect((await api.entity.get({ id: source.id, include: [] })).entity.props[list]).toEqual([
    archived.id,
    valid.id,
  ]);
});

test('ПС-20: два независимых источника', async () => {
  const api = callerFor(await freshGraph());
  const target = await api.entity.create({ input: { title: 'Цель', tags: [] }, source: 'ui' });
  const source = await api.entity.create({
    input: { title: 'Источник', tags: [], body: `[[entity:${target.id}|Цель]]` },
    source: 'ui',
  });
  const key = { source_id: source.id, target_id: target.id, role: 'mention' };
  await api.relation.create(key);
  const before = await api.entity.get({ id: source.id, include: ['body', 'relations'] });
  expect(before.entity.bodyRefs).toEqual([target.id]);
  await api.relation.delete(key);
  const removed = await api.entity.get({ id: source.id, include: ['body', 'relations'] });
  expect(before.entity.body).toBeDefined();
  expect(removed.entity.body).toBe(before.entity.body!);
  expect(removed.entity.bodyRefs).toEqual([target.id]);
  expect(removed.relations).toEqual([]);
  await api.relation.create(key);
  const beforeBodyEdit = await api.entity.get({ id: source.id, include: ['body'] });
  await api.entity.update({
    id: source.id,
    body: 'Чип убран',
    expectedBodyRevision: beforeBodyEdit.entity.bodyRevision,
  });
  const after = await api.entity.get({ id: source.id, include: ['body', 'relations'] });
  expect(after.entity.bodyRefs).toEqual([]);
  expect(
    after.relations?.filter((r) => r.role === 'mention' && r.targetId === target.id),
  ).toHaveLength(1);
});
