import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { type GraphId, newId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal } from '../../test/helpers';
import {
  actionJournal,
  chatMessages,
  chatThreads,
  entities,
  entityVersions,
  fileAssets,
  fileHolds,
  fileUploads,
} from '../db/schema';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import { maintainFiles } from './gc';
import type { FileStore } from './store';
import { beginUpload, writePart } from './uploads';

const admin = adminDb(),
  app = appDb();
let previousWrites: string | undefined;
beforeEach(() => {
  previousWrites = process.env.ORBIS_FILE_WRITES;
  process.env.ORBIS_FILE_WRITES = '1';
});
afterEach(() => {
  if (previousWrites === undefined) delete process.env.ORBIS_FILE_WRITES;
  else process.env.ORBIS_FILE_WRITES = previousWrites;
});
afterAll(async () => {
  await Promise.all([admin.client.end(), app.client.end()]);
});
test('audit finds missing holds on archived records and only deletes after last source disappears', async () => {
  const graph = await freshGraph(),
    file = newId(),
    key = `originals/${graph}/${file}`,
    entity = newId();
  const calls: string[] = [];
  const store: FileStore = {
    async put() {
      throw Error();
    },
    async read() {
      throw Error();
    },
    async remove(k) {
      calls.push(k);
    },
  };
  const ctx = { db: app.db, identity: personal(graph), store };
  await admin.db.insert(fileAssets).values({
    id: file,
    graphId: graph,
    state: 'ready',
    name: 'a',
    objectKey: key,
    byteSize: 1,
    sha256: 'a'.repeat(64),
    mediaType: 'application/octet-stream',
    publishedAt: new Date(),
  });
  await admin.db.insert(entities).values({
    id: entity,
    graphId: graph,
    title: 'Архив',
    archived: true,
    props: { 'orbis/attachments': [file] },
  });
  expect((await maintainFiles(ctx, 'audit')).missing).toHaveLength(1);
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(0);
  await maintainFiles(ctx, 'repair');
  expect((await maintainFiles(ctx, 'audit')).missing).toHaveLength(0);
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(0);
  expect(calls).toHaveLength(0);
  await admin.db.update(entities).set({ props: {} }).where(eq(entities.id, entity));
  await maintainFiles(ctx, 'repair');
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(1);
  expect(calls).toEqual([key]);
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(0);
});
test('active read lease wins, interrupted removal resumes from deleting', async () => {
  const graph = await freshGraph(),
    file = newId(),
    key = `originals/${graph}/${file}`;
  let fail = true;
  const store: FileStore = {
    async put() {
      throw Error();
    },
    async read() {
      throw Error();
    },
    async remove() {
      if (fail) throw new Error('temporary');
    },
  };
  const ctx = { db: app.db, identity: personal(graph), store };
  await admin.db.insert(fileAssets).values({
    id: file,
    graphId: graph,
    state: 'ready',
    name: 'b',
    objectKey: key,
    byteSize: 1,
    sha256: 'b'.repeat(64),
    mediaType: 'text/plain',
    publishedAt: new Date(),
  });
  await admin.db.insert(fileHolds).values({
    fileId: file,
    graphId: graph,
    sourceKind: 'read',
    sourceKey: newId(),
    expiresAt: new Date(Date.now() + 60000),
  });
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(0);
  await admin.db
    .update(fileHolds)
    .set({ expiresAt: new Date(0) })
    .where(eq(fileHolds.fileId, file));
  await expect(maintainFiles(ctx, 'delete')).rejects.toThrow('temporary');
  expect((await admin.db.select().from(fileAssets).where(eq(fileAssets.id, file)))[0]?.state).toBe(
    'deleting',
  );
  fail = false;
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(1);
});

test.skipIf(process.env.ORBIS_TEST_FILE_STORAGE !== '1')(
  'audit preserves the test bucket and delete removes a verified orphan, along with its reserved parts',
  async () => {
    const { getFileStore } = await import('./store');
    const { beginUpload, finishUpload, writePart } = await import('./uploads');
    const { fileUploads } = await import('../db/schema');
    const graph = await freshGraph(),
      store = getFileStore(),
      ctx = { db: app.db, identity: personal(graph), store };
    const upload = await beginUpload(
      ctx,
      { uploadId: newId(), name: 'gc.txt', byteSize: 3 },
      'web',
    );
    const bytes = new TextEncoder().encode('abc');
    await writePart(ctx, upload.uploadId, 0, bytes);
    const file = await finishUpload(ctx, upload.uploadId);
    const key = `originals/${graph}/${file.id}`,
      partKey = `parts/${graph}/${upload.uploadId}/0`;
    await admin.db
      .update(fileUploads)
      .set({ expiresAt: new Date(0) })
      .where(eq(fileUploads.id, upload.uploadId));
    await admin.db
      .update(fileHolds)
      .set({ expiresAt: new Date(0) })
      .where(eq(fileHolds.fileId, file.id));
    expect((await maintainFiles(ctx, 'audit')).deleted).toBe(0);
    expect(await new Response(await store.read(key)).text()).toBe('abc');
    expect((await maintainFiles(ctx, 'delete')).deleted).toBe(1);
    const left = await store.listGraph?.(graph);
    expect(left?.map((x) => x.key)).not.toContain(key);
    expect(left?.map((x) => x.key)).not.toContain(partKey);
  },
);

async function orphan(graph: GraphId) {
  const id = newId();
  const objectKey = `originals/${graph}/${id}`;
  await admin.db.insert(fileAssets).values({
    id,
    graphId: graph,
    state: 'ready',
    name: 'a',
    byteSize: 1,
    sha256: 'b'.repeat(64),
    mediaType: 'text/plain',
    publishedAt: new Date(),
    objectKey,
  });
  return id;
}

function memoryStore() {
  const objects = new Map<string, Uint8Array>();
  const store: FileStore = {
    async put(key, bytes) {
      objects.set(
        key,
        bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes.slice(),
      );
    },
    async read(key) {
      const bytes = objects.get(key);
      if (!bytes) throw Error('missing');
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    async remove(key) {
      objects.delete(key);
    },
    async listGraph(graph) {
      return [...objects.keys()]
        .filter((key) => key.split('/')[1] === graph)
        .map((key) => ({ key, modifiedAt: new Date(0) }));
    },
  };
  return { store, objects };
}

test('recovers independent body, pin, insurance, inverse, run and pending holds from their sources', async () => {
  const graph = await freshGraph(),
    file = await orphan(graph),
    identity = personal(graph),
    entity = newId();
  const { store } = memoryStore(),
    ctx = { db: app.db, identity, store };
  const body = `[a](orbis-file:${file})`;
  await admin.db
    .insert(entities)
    .values({ id: entity, graphId: graph, title: 'a', body, bodyFormat: 4 });
  const pinned = newId(),
    insurance = newId(),
    journal = newId(),
    threadId = newId(),
    pendingId = newId();
  await admin.db.insert(entityVersions).values(
    [pinned, insurance].map((id, i) => ({
      id,
      graphId: graph,
      entityId: entity,
      label: i ? 'Страховочная версия' : 'Версия',
      body,
      bodyFormat: 4,
      actorUserId: identity.actor,
      actorKind: 'owner',
    })),
  );
  const record = {
    graphId: graph,
    entityId: entity,
    type: 'entity_updated',
    actorUserId: identity.actor,
    actorKind: 'owner',
    source: 'ui',
    mechanism: 'user',
    title: 'edit',
    cardTool: 'entity_update',
    operations: [],
    bodyFormat: 4,
    inverse: [{ op: 'entity_update', payload: { id: entity, body, bodyFormatVersion: 4 } }],
  };
  const run = newId();
  await admin.db.insert(actionJournal).values([
    { ...record, id: journal, textSession: true },
    { ...record, id: run, runId: newId(), source: 'routine' },
  ]);
  await admin.db.insert(chatThreads).values({ id: threadId, graphId: graph });
  await admin.db.insert(chatMessages).values({
    id: pendingId,
    threadId,
    role: 'system',
    content: 'Запрос',
    metadata: {
      pending: {
        id: pendingId,
        level: 'explicit-confirmation',
        kind: 'action',
        source: 'chat',
        actor_kind: 'ai',
        created_at: new Date().toISOString(),
        tool: 'entity_update',
        input: { id: entity, props: { 'orbis/attachments': [file] } },
      },
    },
  });
  const audit = await maintainFiles(ctx, 'audit');
  expect(audit.blocked).toEqual([]);
  expect(audit.missing.map((h) => [h.sourceKind, h.sourceKey]).sort()).toEqual(
    [
      ['body', entity],
      ['version', pinned],
      ['version', insurance],
      ['inverse', journal],
      ['inverse', run],
      ['pending', pendingId],
    ].sort(),
  );
  await maintainFiles(ctx, 'repair');
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(0);
  await admin.db
    .insert(actionJournal)
    .values({ ...record, id: newId(), type: 'undo', undoes: journal, inverse: [] });
  await admin.db.insert(chatMessages).values({
    id: newId(),
    threadId,
    role: 'system',
    content: 'Отклонено',
    metadata: { type: 'confirmation_rejected', rejects: pendingId },
  });
  const closed = await maintainFiles(ctx, 'audit');
  expect(closed.surplus.map((h) => h.sourceKey).sort()).toEqual([journal, pendingId].sort());
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(0);
});

test('a future document or unknown private prefix blocks only the affected graph', async () => {
  const graph = await freshGraph(),
    foreign = await freshGraph(),
    entity = newId(),
    a = await orphan(graph),
    b = await orphan(foreign);
  const { store, objects } = memoryStore();
  objects.set(`originals/${graph}/${a}`, new Uint8Array([1]));
  objects.set(`originals/${foreign}/${b}`, new Uint8Array([2]));
  await admin.db.insert(entities).values({
    id: entity,
    graphId: graph,
    title: 'future',
    bodyDoc: { v: 5, doc: { type: 'future' } },
  });
  const run = (id: GraphId) =>
    maintainFiles({ db: app.db, identity: personal(id), store }, 'delete');
  expect((await run(graph)).blocked).toEqual([`entity/${entity}`]);
  expect((await run(foreign)).deleted).toBe(1);
  expect([...objects.keys()]).toEqual([`originals/${graph}/${a}`]);
  await admin.db.update(entities).set({ bodyDoc: null }).where(eq(entities.id, entity));
  const unknown = `parts/${graph}/${newId()}/0`;
  objects.set(unknown, new Uint8Array([3]));
  expect((await run(graph)).unowned).toEqual([unknown]);
  expect(objects.size).toBe(2);
});

test('an attachment racing after the durable delete claim is rejected before provider acknowledgement', async () => {
  const graph = await freshGraph(),
    file = await orphan(graph),
    entityId = newId(),
    identity = personal(graph);
  await admin.db.insert(entities).values({ id: entityId, graphId: graph, title: 'race' });
  const { store } = memoryStore();
  const claimed = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  store.remove = async () => {
    claimed.resolve();
    await finish.promise;
  };
  const deleting = maintainFiles({ db: app.db, identity, store }, 'delete');
  try {
    await Promise.race([
      claimed.promise,
      deleting.then(() => {
        throw Error('collector failed to claim');
      }),
    ]);
    const result = await execute(
      app.db,
      {
        identity,
        source: 'ui',
        actorKind: 'owner',
        fileCapability: true,
        operations: [
          {
            tool: 'file_field_edit',
            input: {
              entityId,
              propertyId: 'orbis/attachments',
              commandId: newId(),
              edit: { kind: 'add', fileId: file },
            },
          },
        ],
      },
      { sink: makeJournalSink() },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  } finally {
    finish.resolve();
    await deleting;
  }
  expect(
    (await admin.db.select().from(entities).where(eq(entities.id, entityId)))[0]?.props,
  ).toEqual({});
});

test('an expired in-flight Put is fenced, and a subsequent pass reclaims the late object', async () => {
  const graph = await freshGraph(),
    { store, objects } = memoryStore(),
    ctx = { db: app.db, identity: personal(graph), store };
  const upload = await beginUpload(
    ctx,
    { uploadId: newId(), name: 'late.txt', byteSize: 2 },
    'web',
  );
  const started = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>(),
    put = store.put.bind(store);
  store.put = async (...args) => {
    started.resolve();
    await resume.promise;
    await put(...args);
  };
  const writing = writePart(ctx, upload.uploadId, 0, new Uint8Array([1, 2]));
  try {
    await Promise.race([
      started.promise,
      writing.then(() => {
        throw Error('missing reservation');
      }),
    ]);
    await admin.db
      .update(fileUploads)
      .set({ expiresAt: new Date(0) })
      .where(eq(fileUploads.id, upload.uploadId));
    expect((await maintainFiles(ctx, 'delete')).deleted).toBe(1);
  } finally {
    resume.resolve();
  }
  await expect(writing).rejects.toThrow();
  const key = `parts/${graph}/${upload.uploadId}/0`;
  expect(objects.has(key)).toBe(true);
  expect((await maintainFiles(ctx, 'audit')).leftovers).toEqual([key]);
  expect(objects.has(key)).toBe(true);
  expect((await maintainFiles(ctx, 'delete')).leftovers).toEqual([key]);
  expect(objects.has(key)).toBe(false);
});

test('a lost provider delete response retries the same generation and never repeats a completed delete', async () => {
  const graph = await freshGraph(),
    file = await orphan(graph);
  const key = `originals/${graph}/${file}`;
  const { store, objects } = memoryStore(),
    ctx = { db: app.db, identity: personal(graph), store };
  objects.set(key, new Uint8Array([1]));
  const calls: string[] = [];
  store.remove = async (k) => {
    calls.push(k);
    if (objects.delete(k)) throw Error('lost acknowledgement');
  };
  await expect(maintainFiles(ctx, 'delete')).rejects.toThrow('lost acknowledgement');
  const readState = async () =>
    (
      await admin.db
        .select({ state: fileAssets.state, generation: fileAssets.deleteGeneration })
        .from(fileAssets)
        .where(eq(fileAssets.id, file))
    )[0];
  expect(await readState()).toEqual({ state: 'deleting', generation: 1 });
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(1);
  expect(await readState()).toEqual({ state: 'deleted', generation: 1 });
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(0);
  expect(calls).toEqual([key, key]);
});

test('a range opened before expiry holds its original; after expiry a lost stream cannot report truncated success', async () => {
  const graph = await freshGraph(),
    file = await orphan(graph),
    key = `originals/${graph}/${file}`;
  const { store, objects } = memoryStore(),
    ctx = { db: app.db, identity: personal(graph), store };
  objects.set(key, new Uint8Array([1]));
  const resume = Promise.withResolvers<void>();
  store.read = async () =>
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await resume.promise;
          const bytes = objects.get(key);
          if (bytes) controller.enqueue(bytes);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
  const { readRange } = await import('./read');
  const opened = await readRange(ctx, file, 0, 1);
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(0);
  const response = new Response(opened.stream).arrayBuffer();
  try {
    await admin.db
      .update(fileHolds)
      .set({ expiresAt: new Date(0) })
      .where(eq(fileHolds.fileId, file));
    expect((await maintainFiles(ctx, 'delete')).deleted).toBe(1);
  } finally {
    resume.resolve();
  }
  await expect(response).rejects.toThrow();
  await expect(readRange(ctx, file, 0, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('a missing live property definition can be reconstructed for its remaining inverse', async () => {
  const graph = await freshGraph(),
    identity = personal(graph),
    file = await orphan(graph),
    property = newId(),
    id = newId();
  const { store } = memoryStore(),
    ctx = { db: app.db, identity, store };
  const record = {
    graphId: graph,
    type: 'property_created',
    actorUserId: identity.actor,
    actorKind: 'owner',
    source: 'ui',
    mechanism: 'user',
    title: 'Смета',
    cardTool: 'property_create',
    bodyFormat: 4,
  };
  await admin.db.insert(actionJournal).values([
    {
      ...record,
      id: newId(),
      operations: [
        {
          op: 'property_create',
          payload: {
            id: property,
            key: 'user/estimate',
            type: { kind: 'file', cardinality: 'one' },
          },
        },
      ],
      inverse: [],
    },
    {
      ...record,
      id,
      type: 'entity_updated',
      operations: [],
      inverse: [{ op: 'entity_update', payload: { props: { [property]: file } } }],
    },
  ]);
  expect(
    (await maintainFiles(ctx, 'audit')).missing.map((h) => [h.sourceKind, h.sourceKey, h.fileId]),
  ).toEqual([['inverse', id, file]]);
  await maintainFiles(ctx, 'repair');
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(0);
});

test.skipIf(process.env.ORBIS_TEST_FILE_STORAGE !== '1')(
  'unexpected Storage directories suspend only their graph until both test objects are removed',
  async () => {
    const { getFileStore } = await import('./store');
    const store = getFileStore();
    const graph = await freshGraph();
    const other = await freshGraph();
    const key = `originals/${graph}/${await orphan(graph)}`;
    const otherKey = `originals/${other}/${await orphan(other)}`;
    const originalDir = `originals/${graph}/unexpected`;
    const partDir = `parts/${graph}/${newId()}/unexpected`;
    const nestedOriginal = `${originalDir}/deeper/file`;
    const nestedPart = `${partDir}/file`;
    const keys = [key, otherKey, nestedOriginal, nestedPart];
    const ctx = { db: app.db, identity: personal(graph), store };
    try {
      for (const k of keys) await store.put(k, new Uint8Array([42]));
      const audit = await maintainFiles(ctx, 'audit');
      expect(audit.unowned.sort()).toEqual([originalDir, partDir].sort());
      expect((await maintainFiles(ctx, 'delete')).deleted).toBe(0);
      expect([...new Uint8Array(await new Response(await store.read(key)).arrayBuffer())]).toEqual([
        42,
      ]);
      expect((await maintainFiles({ ...ctx, identity: personal(other) }, 'delete')).deleted).toBe(
        1,
      );
      await store.remove(nestedOriginal);
      expect((await maintainFiles(ctx, 'delete')).unowned).toEqual([partDir]);
      await store.remove(nestedPart);
      expect((await maintainFiles(ctx, 'audit')).unowned).toEqual([]);
      expect((await maintainFiles(ctx, 'delete')).deleted).toBe(1);
    } finally {
      for (const k of keys) await store.remove(k);
    }
  },
);
