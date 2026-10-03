// Создание и привязка проверяются через настоящий executor, журнал и отмену владельца.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createLinkBatchId, type GraphId, newId, ROLE_SUBITEM } from '@orbis/shared';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { actionsOf, journalOf, undoRecordOf } from '../../test/journal-helpers';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();
const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);
const callerFor = (graph: GraphId) =>
  createCaller({ identity: personal(graph), actorKind: 'owner', db, clientVersion: null });
beforeAll(truncateAll);
afterAll(() => client.end());

function actionIdOf(result: { actionId?: string }): string {
  if (result.actionId === undefined) throw new Error('успех не вернул действие журнала');
  return result.actionId;
}

async function fixture() {
  const graph = await freshGraph();
  const caller = callerFor(graph);
  const parent = await caller.entity.create({
    input: { title: 'Родитель', tags: [], aspects: ['orbis/task'] },
    source: 'ui',
  });
  const linkCall = (id: string, title = 'Подзадача') =>
    caller.entity.create({
      input: {
        id,
        title,
        tags: [],
        props: { 'orbis/task_status': 'inbox' },
        aspects: ['orbis/task'],
      },
      source: 'quick_capture',
      link: { parentId: parent.id, role: ROLE_SUBITEM },
    });
  return { graph, caller, parent: parent.id, linkCall };
}

test('одна транзакция, одна запись журнала: запись и связь родитель → запись', async () => {
  const { graph, caller, parent, linkCall } = await fixture();
  const id = newId();
  const result = await linkCall(id);
  expect(result.id).toBe(id);
  expect(result.actionId).toBe(createLinkBatchId(graph, id));
  expect(result.body).toBe('');
  expect(result.bodyRevision).toBe(1);
  const entries = (await actionsOf(graph)).filter((entry) => entry.entityIds.includes(id));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    id: result.actionId,
    type: 'batch',
    source: 'quick_capture',
    title: 'Создано и привязано: Подзадача',
  });
  expect(entries[0]?.operations.map((operation) => operation.op)).toEqual([
    'entity_create',
    'relation_create',
  ]);
  const relations =
    (await caller.entity.get({ id: parent, include: ['relations'] })).relations ?? [];
  expect(
    relations.filter(
      (relation) =>
        relation.sourceId === parent && relation.targetId === id && relation.role === ROLE_SUBITEM,
    ),
  ).toHaveLength(1);
});

test('одна отмена архивирует запись и снимает связь', async () => {
  const { graph, caller, parent, linkCall } = await fixture();
  const id = newId();
  const result = await linkCall(id);
  const before = (await caller.entity.get({ id: parent, include: ['relations'] })).relations ?? [];
  expect(before.some((relation) => relation.targetId === id)).toBe(true);
  await caller.ai.undo({ actionId: actionIdOf(result) });
  expect((await caller.entity.get({ id })).entity.archived).toBe(true);
  const relations =
    (await caller.entity.get({ id: parent, include: ['relations'] })).relations ?? [];
  expect(relations.some((relation) => relation.targetId === id)).toBe(false);
  expect(await undoRecordOf(graph, actionIdOf(result))).toBeDefined();
});

test('повтор той же пачки — replay: исходный ответ и JournalRef, запись журнала и связь по одной', async () => {
  const { graph, caller, parent, linkCall } = await fixture();
  const id = newId();
  const first = await linkCall(id);
  const again = await linkCall(id);
  expect(again).toEqual(first);
  expect((await actionsOf(graph)).filter((entry) => entry.entityIds.includes(id))).toHaveLength(1);
  const relations =
    (await caller.entity.get({ id: parent, include: ['relations'] })).relations ?? [];
  expect(relations.filter((relation) => relation.targetId === id)).toHaveLength(1);
});

test('replay возвращает сохранённый полный результат, даже после правки записи и смены входа', async () => {
  const { graph, caller, linkCall } = await fixture();
  const id = newId();
  const first = await linkCall(id);
  await caller.entity.update({
    id,
    title: 'Позже',
    body: 'Новый текст',
    expectedBodyRevision: first.bodyRevision,
  });
  const again = await linkCall(id, 'Изменённый повтор');
  expect(again).toEqual(first);
  expect(again.body).toBe('');
  expect(again.consequences).toBe(false);
  expect((await journalOf(graph, actionIdOf(first)))?.consequences).toBe(false);
  expect((await caller.entity.get({ id })).entity.title).toBe('Позже');
});

test('всё или ничего: родителя нет — отказ, записи и журнала тоже нет', async () => {
  const { graph, caller } = await fixture();
  const id = newId();
  await expect(
    caller.entity.create({
      input: { id, title: 'Сирота', tags: [] },
      source: 'quick_capture',
      link: { parentId: newId(), role: ROLE_SUBITEM },
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(caller.entity.get({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await actionsOf(graph)).filter((entry) => entry.entityIds.includes(id))).toHaveLength(0);
});

test('привязка без клиентского id — VALIDATION до выполнения', async () => {
  const { graph, caller, parent } = await fixture();
  const before = await actionsOf(graph);
  await expect(
    caller.entity.create({
      input: { title: 'Без id', tags: [] },
      source: 'quick_capture',
      link: { parentId: parent, role: ROLE_SUBITEM },
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'привязка при создании требует id записи от клиента — иначе повтор не найдёт пачку',
  });
  expect(await actionsOf(graph)).toHaveLength(before.length);
});

test('чужая роль и лишнее поле привязки отвергаются строгой схемой', async () => {
  const { caller, parent } = await fixture();
  await expect(
    caller.entity.create({
      input: { id: newId(), title: 'Чужая роль', tags: [] },
      source: 'quick_capture',
      link: { parentId: parent, role: 'ticket' as 'subitem' },
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(
    caller.entity.create({
      input: { id: newId(), title: 'Лишнее поле', tags: [] },
      source: 'quick_capture',
      link: { parentId: parent, role: ROLE_SUBITEM, extra: true } as {
        parentId: string;
        role: 'subitem';
      },
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('привязка сохраняет source и fast_path threadId, проверки треда не обходятся', async () => {
  const { graph, caller, parent } = await fixture();
  const { threadId } = await caller.chat.ensureThread({ entityId: parent });
  const result = await caller.entity.create({
    input: { id: newId(), title: 'Быстрый ввод', tags: [] },
    source: 'fast_path',
    threadId,
    link: { parentId: parent, role: ROLE_SUBITEM },
  });
  expect(await journalOf(graph, actionIdOf(result))).toMatchObject({
    source: 'fast_path',
    threadId,
    type: 'batch',
  });
  await expect(
    caller.entity.create({
      input: { id: newId(), title: 'Неверный тред', tags: [] },
      source: 'ui',
      threadId,
      link: { parentId: parent, role: ROLE_SUBITEM },
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  const id = newId();
  await expect(
    caller.entity.create({
      input: { id, title: 'Нет треда', tags: [] },
      source: 'fast_path',
      threadId: newId(),
      link: { parentId: parent, role: ROLE_SUBITEM },
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(caller.entity.get({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('пачка с последствиями сохраняет исходный признак при replay', async () => {
  const { graph, caller, parent } = await fixture();
  const input = {
    input: {
      id: newId(),
      title: 'Завершена',
      tags: [],
      aspects: ['orbis/task'],
      props: { 'orbis/task_status': 'done' },
    },
    source: 'quick_capture' as const,
    link: { parentId: parent, role: ROLE_SUBITEM } as const,
  };
  const first = await caller.entity.create(input);
  expect(first.consequences).toBe(true);
  expect((await journalOf(graph, actionIdOf(first)))?.consequences).toBe(true);
  expect(await caller.entity.create(input)).toEqual(first);
});
