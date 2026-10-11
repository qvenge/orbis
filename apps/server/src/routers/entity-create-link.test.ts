// Создание и привязка проверяются через настоящий executor, журнал и отмену владельца.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createLinkBatchId, type GraphId, newId, ROLE_SUBITEM } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { actionsOf, journalOf, undoRecordOf } from '../../test/journal-helpers';
import { withIdentity } from '../db/with-identity';
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

test('сохранённый create.link не обходит проверку треда при повторе fast_path', async () => {
  const { caller, parent, linkCall } = await fixture();
  const id = newId();
  const first = await linkCall(id);
  await expect(
    caller.entity.create({
      input: { id, title: 'Подзадача', tags: [], aspects: ['orbis/task'] },
      source: 'fast_path',
      threadId: newId(),
      link: { parentId: parent, role: ROLE_SUBITEM },
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'тред не найден' });
  expect(await linkCall(id)).toEqual(first);
});

/** Замок родителя удерживает оба запроса после их первой проверки журнала, без шва в production-коде. */
async function overlappingCreates(
  graph: GraphId,
  parent: string,
  payload: Parameters<ReturnType<typeof callerFor>['entity']['create']>[0],
) {
  let announce: (pid: number) => void = () => {};
  let failLock: (error: unknown) => void = () => {};
  const locked = new Promise<number>((resolve, reject) => {
    announce = resolve;
    failLock = reject;
  });
  let release: () => void = () => {};
  const unlocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = withIdentity(db, personal(graph), async (tx) => {
    const rows = await tx.execute(
      sql`SELECT pg_backend_pid()::int AS pid FROM entities WHERE id = ${parent}::uuid FOR UPDATE`,
    );
    announce(rows[0]?.pid as number);
    await unlocked;
  });
  void blocker.catch(failLock);
  let inFlight: Promise<unknown> = Promise.resolve();
  let observerClient: ReturnType<typeof adminDb>['client'] | undefined;
  try {
    const pid = await locked;
    const responses = Promise.allSettled([
      callerFor(graph).entity.create(payload),
      callerFor(graph).entity.create(payload),
    ]);
    inFlight = responses;
    const connection = adminDb();
    const observer = connection.db;
    observerClient = connection.client;
    const deadline = performance.now() + 3000;
    while (true) {
      // Второй запрос может ждать первый: рекурсивно считаем всю очередь за нашим замком.
      const rows = await observer.execute(sql`WITH RECURSIVE blocked AS (
        SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
      ) SELECT count(*)::int AS n FROM blocked`);
      if ((rows[0]?.n as number) >= 2) break;
      if (performance.now() >= deadline) throw new Error('оба запроса не дошли до замка родителя');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return responses;
  } finally {
    release();
    try {
      await blocker;
    } finally {
      try {
        await inFlight;
      } finally {
        await observerClient?.end();
      }
    }
  }
}

for (const completed of [false, true]) {
  test(`перекрывающиеся create.link возвращают исходный ответ: consequences=${completed}`, async () => {
    const { graph, caller, parent } = await fixture();
    const id = newId();
    const payload = {
      input: {
        id,
        title: 'Перекрытие',
        tags: [],
        aspects: ['orbis/task'],
        props: { 'orbis/task_status': completed ? 'done' : 'inbox' },
      },
      source: 'quick_capture' as const,
      link: { parentId: parent, role: ROLE_SUBITEM } as const,
    };
    const responses = await overlappingCreates(graph, parent, payload);
    expect(responses.map((response) => response.status)).toEqual(['fulfilled', 'fulfilled']);
    const values = responses.map((response) => {
      if (response.status === 'rejected') throw response.reason;
      return response.value;
    });
    const first = values[0];
    if (first === undefined) throw new Error('нет первого ответа');
    expect(values[1]).toEqual(first);
    expect(first).toMatchObject({
      id,
      actionId: createLinkBatchId(graph, id),
      consequences: completed,
      body: '',
    });
    const entries = (await actionsOf(graph)).filter((entry) => entry.entityIds.includes(id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: first.actionId,
      type: 'batch',
      consequences: completed,
    });
    const relations =
      (await caller.entity.get({ id: parent, include: ['relations'] })).relations ?? [];
    expect(
      relations.filter(
        (relation) =>
          relation.sourceId === parent &&
          relation.targetId === id &&
          relation.role === ROLE_SUBITEM,
      ),
    ).toHaveLength(1);
    expect((await caller.entity.get({ id })).entity).toMatchObject({ id, archived: false });
    await caller.entity.update({
      id,
      title: 'Поздняя правка',
      body: 'Поздний текст',
      expectedBodyRevision: first.bodyRevision,
    });
    expect(await caller.entity.create(payload)).toEqual(first);
  });
}
