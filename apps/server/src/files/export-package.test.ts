import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphId } from '@orbis/shared';
import { and, eq, sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { openPromise } from 'yauzl';
import { appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import type { AiDeps } from '../ai/send-message';
import { createApp } from '../app';
import {
  actionJournal,
  chatMessages,
  chatThreads,
  entities,
  fileAssets,
  fileHolds,
  propertyDefinitions,
} from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { exportData } from '../export';
import { issuePatGrant } from '../oauth/grants';
import { bumpOwnerRegistryVersion } from '../registry/version';
import { buildGraphPackage } from './export-package';
import { type FileStore, getFileStore } from './store';

requireEnv();
const { db, client } = appDb();
afterAll(() => client.end());

function scoped<T>(graph: GraphId, fn: Parameters<typeof withIdentity<T>>[2]): Promise<T> {
  return withIdentity(db, personal(graph), fn);
}

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

async function namedField(graph: GraphId) {
  const id = crypto.randomUUID();
  await scoped(graph, async (tx) => {
    await tx.insert(propertyDefinitions).values({
      id,
      graphId: graph,
      key: 'user/estimate',
      rank: 42,
      label: { en: 'Estimate', ru: 'Смета' },
      description: { en: 'Estimate', ru: 'Смета' },
      type: { kind: 'file', cardinality: 'one' },
    });
    await bumpOwnerRegistryVersion(tx, graph);
  });
  return id;
}

async function original<T extends string | Buffer>(
  graph: GraphId,
  payload: T,
  mediaType = 'application/octet-stream',
) {
  const id = crypto.randomUUID();
  const key = `originals/${graph}/${id}`;
  await scoped(graph, (tx) =>
    tx.insert(fileAssets).values({
      graphId: graph,
      id,
      name: 'одинаковое имя.txt',
      objectKey: key,
      state: 'ready',
      mediaType,
      byteSize: Buffer.byteLength(payload),
      sha256: digest(payload),
      publishedAt: new Date(),
    }),
  );
  return { id, key, payload };
}

async function readZip(stream: ReadableStream<Uint8Array>) {
  const temp = await mkdtemp(join(tmpdir(), 'orbis-export-test-'));
  try {
    const path = join(temp, 'export.zip');
    await writeFile(path, new Uint8Array(await new Response(stream).arrayBuffer()));
    const zip = await openPromise(path);
    const entries = new Map<string, Buffer>();
    try {
      for await (const entry of zip.eachEntry()) {
        const chunks: Buffer[] = [];
        for await (const chunk of await zip.openReadStreamPromise(entry))
          chunks.push(Buffer.from(chunk));
        entries.set(entry.fileName, Buffer.concat(chunks));
      }
    } finally {
      zip.close();
    }
    return entries;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function fixtureStore(entries: Map<string, string>): FileStore {
  return {
    async put() {
      throw new Error('Unexpected attempt to write fixtures');
    },
    async remove() {
      throw new Error('Unexpected attempt to remove fixtures');
    },
    async read(key) {
      const payload = entries.get(key);
      if (payload === undefined) throw new Error('Fixture object missing');
      return new Blob([payload]).stream();
    },
  };
}

test('v3 survives legacy literals and v4 stamps on plain bodies, but an empty custom file field requires a package', async () => {
  const graph = await freshGraph();
  const bare = crypto.randomUUID();
  const legacy = crypto.randomUUID();
  const literal = `[старый текст](orbis-file:${crypto.randomUUID()})`;
  await scoped(graph, (tx) =>
    tx.insert(entities).values([
      { id: bare, graphId: graph, title: 'Обычный новый текст', body: 'План', bodyFormat: 4 },
      { id: legacy, graphId: graph, title: 'Старый текст', body: literal },
    ]),
  );
  const read = () => scoped(graph, (tx) => exportData(tx, graph));
  const json = await read();
  expect(json.version).toBe(3);
  expect(json.entities.find((entity) => entity.id === bare)).not.toHaveProperty(
    'bodyFormatVersion',
  );
  expect(json.entities.find((entity) => entity.id === legacy)?.body).toBe(literal);

  await namedField(graph);
  await expect(read()).rejects.toMatchObject({ code: 'EXPORT_FORMAT_REQUIRED' });
});

test('history alone with a file-field operation requires the new format but does not select a binary', async () => {
  const graph = await freshGraph();
  const file = await original(graph, 'detached');
  await scoped(graph, (tx) =>
    tx.insert(actionJournal).values({
      graphId: graph,
      id: crypto.randomUUID(),
      title: 'Вложение',
      cardTool: 'file_field_edit',
      type: 'entity_updated',
      actorUserId: personal(graph).actor,
      actorKind: 'owner',
      source: 'ui',
      mechanism: 'direct',
      bodyFormat: 4,
      operations: [
        { op: 'file_field_edit', payload: { edit: { kind: 'remove', fileId: file.id } } },
      ],
      inverse: [],
    }),
  );
  await expect(scoped(graph, (tx) => exportData(tx, graph))).rejects.toMatchObject({
    code: 'EXPORT_FORMAT_REQUIRED',
  });
  const archive = await buildGraphPackage({ db, identity: personal(graph) });
  const entries = await readZip(archive.stream);
  expect([...entries.keys()].sort()).toEqual(['graph.json', 'manifest.json']);
  const journal = JSON.parse(entries.get('graph.json')?.toString() ?? '').journal;
  expect(journal).toHaveLength(1);
  expect(journal[0].bodyFormatVersion).toBe(4);
});

test('a package includes distinct same-name originals, archived references, and body-only references exactly once', async () => {
  const graph = await freshGraph();
  const propertyId = await namedField(graph);
  const property = await original(graph, 'property original');
  const body = await original(graph, 'body original');
  const unrelated = await original(graph, 'unreferenced in the graph');
  const other = await original(await freshGraph(), 'other graph');
  await scoped(graph, (tx) =>
    tx.insert(entities).values([
      {
        graphId: graph,
        id: crypto.randomUUID(),
        title: 'Архивная смета',
        archived: true,
        props: { [propertyId]: property.id },
      },
      {
        graphId: graph,
        id: crypto.randomUUID(),
        title: 'Две ссылки на одну смету',
        bodyFormat: 4,
        body: `[Смета](orbis-file:${property.id}) [Схема](orbis-file:${body.id}) [Схема](orbis-file:${body.id})`,
      },
    ]),
  );
  const store = fixtureStore(
    new Map([
      [property.key, property.payload],
      [body.key, body.payload],
    ]),
  );
  const output = await buildGraphPackage({ db, identity: personal(graph), store });
  const entries = await readZip(output.stream);
  expect([...entries.keys()].sort()).toEqual(
    [`files/${property.id}`, `files/${body.id}`, 'graph.json', 'manifest.json'].sort(),
  );
  const manifest = JSON.parse(entries.get('manifest.json')?.toString() ?? '');
  expect(manifest).toMatchObject({
    version: 1,
    graph: 'graph.json',
    fileProperties: { [propertyId]: { key: 'user/estimate' } },
    files: {
      [property.id]: {
        name: 'одинаковое имя.txt',
        path: `files/${property.id}`,
        sha256: digest(property.payload),
      },
      [body.id]: {
        name: 'одинаковое имя.txt',
        path: `files/${body.id}`,
        sha256: digest(body.payload),
      },
    },
  });
  expect(manifest.files[unrelated.id]).toBeUndefined();
  expect(manifest.files[other.id]).toBeUndefined();
  const graphJson = JSON.parse(entries.get('graph.json')?.toString() ?? '');
  expect(graphJson.version).toBe(4);
  expect(
    graphJson.entities.find((entry: { archived: boolean }) => entry.archived).props[propertyId],
  ).toBe(property.id);
  for (const file of [property, body]) {
    const bytes = entries.get(`files/${file.id}`);
    expect(bytes?.toString()).toBe(file.payload);
    if (!bytes) throw new Error('Expected archived original bytes');
    expect(digest(bytes)).toBe(manifest.files[file.id].sha256);
  }
});

test('a provider failure after the snapshot leaves no successful partial archive or export lease', async () => {
  const graph = await freshGraph();
  const file = await original(graph, 'test');
  await scoped(graph, (tx) =>
    tx.insert(entities).values({
      graphId: graph,
      id: crypto.randomUUID(),
      title: 'Файл',
      bodyFormat: 4,
      body: `[Файл](orbis-file:${file.id})`,
    }),
  );
  const abort = new AbortController();
  let entered = false;
  const store: FileStore = {
    ...fixtureStore(new Map()),
    async read() {
      const leases = await scoped(graph, (tx) =>
        tx
          .select()
          .from(fileHolds)
          .where(and(eq(fileHolds.fileId, file.id), eq(fileHolds.sourceKind, 'export'))),
      );
      expect(leases).toHaveLength(1);
      entered = true;
      abort.abort();
      return new Blob(['wrong']).stream();
    },
  };
  await expect(
    buildGraphPackage({ db, identity: personal(graph), store, signal: abort.signal }),
  ).rejects.toThrow();
  expect(entered).toBe(true);
  expect(
    await scoped(graph, (tx) =>
      tx
        .select()
        .from(fileHolds)
        .where(and(eq(fileHolds.fileId, file.id), eq(fileHolds.sourceKind, 'export'))),
    ),
  ).toEqual([]);
});

async function attach(graph: GraphId, file: string) {
  const id = crypto.randomUUID();
  await scoped(graph, (tx) =>
    tx.insert(entities).values({
      graphId: graph,
      id,
      title: 'Схема',
      bodyFormat: 4,
      body: `![Схема](orbis-file:${file})`,
    }),
  );
  return id;
}

test('pending file edits in exported chat history require v4, with no current original', async () => {
  const graph = await freshGraph();
  const threadId = crypto.randomUUID();
  await scoped(graph, async (tx) => {
    await tx.insert(chatThreads).values({ graphId: graph, id: threadId });
    await tx.insert(chatMessages).values({
      id: crypto.randomUUID(),
      threadId,
      role: 'system',
      content: '',
      metadata: {
        pending: {
          id: crypto.randomUUID(),
          bodyFormatVersion: 4,
          tool: 'file_field_edit',
          input: {},
        },
      },
    });
  });
  await expect(scoped(graph, (tx) => exportData(tx, graph))).rejects.toMatchObject({
    code: 'EXPORT_FORMAT_REQUIRED',
  });
});

test('an active export protects detached bytes from GC and returns the original snapshot', async () => {
  const { maintainFiles } = await import('./gc');
  const graph = await freshGraph(),
    file = await original(graph, 'original bytes');
  const entity = await attach(graph, file.id);
  const base = fixtureStore(new Map([[file.key, file.payload]]));
  let removals = 0;
  const ctx = {
    db,
    identity: personal(graph),
    store: {
      ...base,
      async remove() {
        removals++;
      },
      async read(key: string) {
        // The writer commits after the snapshot. Its last live reference is gone.
        await scoped(graph, (tx) =>
          tx.update(entities).set({ body: '' }).where(eq(entities.id, entity)),
        );
        expect((await maintainFiles(ctx, 'delete')).deleted).toBe(0);
        return base.read(key);
      },
    },
  };
  const output = await buildGraphPackage(ctx);
  const zip = await readZip(output.stream);
  expect(zip.get('graph.json')?.toString()).toContain(`orbis-file:${file.id}`);
  expect(zip.get(`files/${file.id}`)?.toString()).toBe(file.payload);
  expect((await maintainFiles(ctx, 'delete')).deleted).toBe(1);
  expect(removals).toBe(1);
});

test('a conflicting asset change during snapshot acquisition retries the whole graph', async () => {
  const graph = await freshGraph(),
    file = await original(graph, 'before');
  const entity = await attach(graph, file.id);
  const locked = Promise.withResolvers<number>();
  const finish = Promise.withResolvers<void>();
  const writer = scoped(graph, async (tx) => {
    await tx
      .update(fileAssets)
      .set({ state: 'deleting', deleteGeneration: 1 })
      .where(eq(fileAssets.id, file.id));
    await tx.update(entities).set({ body: '' }).where(eq(entities.id, entity));
    const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
    if (!backend) throw Error('missing test backend');
    locked.resolve(backend.pid);
    await finish.promise;
  });
  // Propagate setup failures immediately; neither a blocked writer nor a stale snapshot
  // may survive a failed assertion and occupy the shared test connection pool.
  void writer.catch((error) => locked.reject(error));
  const deadline = AbortSignal.timeout(10_000);
  const stop = () => {
    locked.reject(deadline.reason);
    finish.resolve();
  };
  deadline.addEventListener('abort', stop, { once: true });
  const blocker = await locked.promise;
  const archive = buildGraphPackage({
    db,
    identity: personal(graph),
    store: fixtureStore(new Map()),
  });
  let waited = false;
  try {
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      const [row] =
        await client`SELECT EXISTS (SELECT FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))) AS waiting`;
      waiting = row?.waiting === true;
      if (!waiting) await Bun.sleep(10);
    }
    waited = waiting;
  } finally {
    deadline.removeEventListener('abort', stop);
    finish.resolve();
    await writer;
  }
  const entries = await readZip((await archive).stream);
  expect(waited).toBe(true);
  expect([...entries.keys()].sort()).toEqual(['graph.json', 'manifest.json']);
  expect(entries.get('graph.json')?.toString()).not.toContain(file.id);
}, 15000);

test.each([
  'short',
  'corrupt',
  'provider',
])('partial assembly refuses %s bytes and can be retried', async (fault) => {
  const graph = await freshGraph(),
    file = await original(graph, 'abcdefgh');
  await attach(graph, file.id);
  const base = fixtureStore(new Map([[file.key, file.payload]]));
  const bad: FileStore = {
    ...base,
    async read() {
      let sent = false;
      return new ReadableStream({
        pull(c) {
          if (!sent) {
            sent = true;
            c.enqueue(Buffer.from(fault === 'corrupt' ? 'badbytes' : 'ab'));
            return;
          }
          if (fault === 'provider') c.error(new Error('provider stopped after first bytes'));
          else c.close();
        },
      });
    },
  };
  const ctx = { db, identity: personal(graph) };
  await expect(buildGraphPackage({ ...ctx, store: bad })).rejects.toThrow();
  expect(
    await scoped(graph, (tx) =>
      tx.select().from(fileHolds).where(eq(fileHolds.sourceKind, 'export')),
    ),
  ).toHaveLength(0);
  expect(
    (await readZip((await buildGraphPackage({ ...ctx, store: base })).stream))
      .get(`files/${file.id}`)
      ?.toString(),
  ).toBe(file.payload);
});

test.skipIf(process.env.ORBIS_TEST_FILE_STORAGE !== '1')(
  'owner HTTP ZIP carries verified test Storage bytes; missing original returns 503',
  async () => {
    const graph = await freshGraph();
    // Larger than a Node stream block. Only the isolated test Storage is configured for this suite.
    const file = await original(graph, 'original ZIP content '.repeat(65000));
    const image = await original(
      graph,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=',
        'base64',
      ),
      'image/png',
    );
    const propertyId = await namedField(graph);
    const foreign = await original(await freshGraph(), 'соседний граф');
    const store = getFileStore();
    const jwtSecret = process.env.SUPABASE_JWT_SECRET;
    const app = createApp({ db, ai: {} as AiDeps });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
    const url = new URL('/api/exports/graph-package', server.url);
    const post = (token?: string) =>
      fetch(url, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
    try {
      await scoped(graph, (tx) =>
        tx.insert(entities).values([
          {
            graphId: graph,
            id: crypto.randomUUID(),
            title: 'Архивная смета',
            archived: true,
            props: { [propertyId]: file.id },
          },
          {
            graphId: graph,
            id: crypto.randomUUID(),
            title: 'Рабочая запись',
            bodyFormat: 4,
            body: `[Смета](orbis-file:${file.id}) ![План](orbis-file:${image.id})`,
          },
        ]),
      );
      await store.put(file.key, Buffer.from(file.payload));
      await store.put(image.key, image.payload);
      process.env.SUPABASE_JWT_SECRET = 'orbis-export-local-stand-jwt-secret';
      const jwt = await new SignJWT({ role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(graph)
        .setAudience('authenticated')
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET));
      expect((await post()).status).toBe(401);
      const pat = await issuePatGrant(db, {
        identity: personal(graph),
        label: 'test export restrictions',
      });
      expect((await post(pat)).status).toBe(403);
      const content = new URL(`/api/files/${file.id}/content`, server.url);
      const headers = { Authorization: `Bearer ${jwt}` };
      const get = await fetch(content, { headers });
      expect(get.status).toBe(200);
      expect(get.headers.get('Content-Length')).toBe(String(Buffer.byteLength(file.payload)));
      expect(get.headers.get('Accept-Ranges')).toBe('bytes');
      expect(digest(Buffer.from(await get.arrayBuffer()))).toBe(digest(file.payload));
      const range = await fetch(content, { headers: { ...headers, Range: 'bytes=100000-624287' } });
      expect(range.status).toBe(206);
      expect(range.headers.get('Content-Range')).toBe(
        `bytes 100000-624287/${Buffer.byteLength(file.payload)}`,
      );
      expect(range.headers.get('Content-Length')).toBe('524288');
      expect(digest(Buffer.from(await range.arrayBuffer()))).toBe(
        digest(file.payload.slice(100000, 624288)),
      );
      const beyond = await fetch(content, {
        headers: { ...headers, Range: `bytes=${Buffer.byteLength(file.payload)}-` },
      });
      expect(beyond.status).toBe(416);
      expect(beyond.headers.get('Content-Length')).toBe('0');
      expect(beyond.headers.get('Content-Range')).toBe(
        `bytes */${Buffer.byteLength(file.payload)}`,
      );
      expect((await beyond.arrayBuffer()).byteLength).toBe(0);
      const full = await post(jwt);
      expect(full.status).toBe(200);
      expect(full.headers.get('content-type')).toBe('application/zip');
      expect(full.headers.get('cache-control')).toContain('no-store');
      const bytes = await full.arrayBuffer();
      expect(bytes.byteLength).toBe(Number(full.headers.get('content-length')));
      const entries = await readZip(new Blob([bytes]).stream());
      expect([...entries.keys()].sort()).toEqual(
        ['graph.json', 'manifest.json', `files/${file.id}`, `files/${image.id}`].sort(),
      );
      const manifest = JSON.parse(entries.get('manifest.json')?.toString() ?? '');
      expect(manifest.fileProperties[propertyId].key).toBe('user/estimate');
      expect(manifest.files[foreign.id]).toBeUndefined();
      expect(manifest.files[image.id].mediaType).toBe('image/png');
      expect(manifest.files[image.id].name).toBe(manifest.files[file.id].name);
      for (const resource of [file, image]) {
        const saved = entries.get(`files/${resource.id}`);
        expect(saved && digest(saved)).toBe(digest(resource.payload));
        expect(manifest.files[resource.id].sha256).toBe(digest(resource.payload));
      }
      await store.remove(file.key);
      const failed = await post(jwt);
      expect(failed.status).toBe(503);
      expect(failed.headers.get('content-type')).toContain('application/json');
      expect(await failed.json()).toMatchObject({ code: 'EXPORT_INCOMPLETE' });
    } finally {
      await server.stop(true);
      await Promise.all([store.remove(file.key), store.remove(image.key)]);
      if (jwtSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
      else process.env.SUPABASE_JWT_SECRET = jwtSecret;
    }
  },
  30000,
);
