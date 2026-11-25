import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import type { UploadBeginInput } from '@orbis/shared/files';
import { and, eq, sql } from 'drizzle-orm';
import { accountOf, addMember, appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { fileAssets, fileHolds, fileUploads } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { identityOfGrant } from '../identity';
import { issuePatGrant, revokeGrant, verifyBearer } from '../oauth/grants';
import { describeFiles, readRange } from './read';
import { type FileStore, getFileStore } from './store';
import { beginUpload, finishUpload, uploadStatus, writePart } from './uploads';

requireEnv();
const { db, client } = appDb();
afterAll(() => client.end());

let previousWrites: string | undefined;
beforeEach(() => {
  previousWrites = process.env.ORBIS_FILE_WRITES;
  process.env.ORBIS_FILE_WRITES = '1';
});
afterEach(() => {
  if (previousWrites === undefined) delete process.env.ORBIS_FILE_WRITES;
  else process.env.ORBIS_FILE_WRITES = previousWrites;
});

function memoryStore() {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key, body) {
      objects.set(
        key,
        body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body.slice(),
      );
    },
    async read(key, range) {
      const bytes = objects.get(key);
      if (bytes === undefined) throw new Error('Object is absent');
      const selected = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
      return new Blob([Uint8Array.from(selected)]).stream();
    },
    async remove(key) {
      objects.delete(key);
    },
  } satisfies FileStore;
}

function input(byteSize: number, name = 'план.txt'): UploadBeginInput {
  return { uploadId: crypto.randomUUID(), byteSize, name };
}

const text = (value: string) => new TextEncoder().encode(value);
const content = 'hello attachments';
const hash = '42d3a7895ec8c25e9cda3e1ea5377a512db52029fadc49d34e70c57a1a54ebaf';

async function owner(store: FileStore = memoryStore()) {
  return { db, identity: personal(await freshGraph()), store };
}

async function uploadText(ctx: Awaited<ReturnType<typeof owner>>) {
  const data = input(content.length);
  await beginUpload(ctx, data, 'web');
  await writePart(ctx, data.uploadId, 0, text(content));
  return finishUpload(ctx, data.uploadId);
}

test('independent graphs can choose the same upload ID', async () => {
  const first = await owner();
  const second = await owner(first.store);
  const command = input(3);
  const a = await beginUpload(first, command, 'web');
  const b = await beginUpload(second, command, 'web');
  expect(a.fileId).not.toBe(b.fileId);
  await writePart(first, command.uploadId, 0, text('one'));
  await writePart(second, command.uploadId, 0, text('two'));
  expect((await finishUpload(first, command.uploadId)).sha256).not.toEqual(
    (await finishUpload(second, command.uploadId)).sha256,
  );
});

test('one attempt yields the same ID on replay, without using the visible name as identity', async () => {
  const ctx = await owner();
  const data = input(content.length);
  const original = await beginUpload(ctx, data, 'web');
  expect(await beginUpload(ctx, data, 'web')).toEqual(original);
  await expect(beginUpload(ctx, { ...data, name: 'другой.txt' }, 'web')).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  expect((await beginUpload(ctx, input(content.length), 'web')).fileId).not.toBe(original.fileId);
  expect(await describeFiles(ctx, [original.fileId])).toEqual([]);
});

test('parts reject gaps, empty, wrong lengths and conflicting bytes, while exact replay stays idempotent', async () => {
  const ctx = await owner();
  const data = { ...input(6147), chunkBytes: 6144 as const };
  const first = new Uint8Array(6144).fill(12);
  const state = await beginUpload(ctx, data, 'mcp');
  expect(state.chunkBytes).toBe(6144);
  await expect(writePart(ctx, data.uploadId, 6144, text('end'))).rejects.toThrow();
  await expect(writePart(ctx, data.uploadId, 0, new Uint8Array())).rejects.toThrow();
  await expect(writePart(ctx, data.uploadId, 0, first.subarray(1))).rejects.toThrow();
  await expect(finishUpload(ctx, data.uploadId)).rejects.toThrow();
  expect((await writePart(ctx, data.uploadId, 0, first)).nextOffset).toBe(6144);
  expect((await writePart(ctx, data.uploadId, 0, first)).nextOffset).toBe(6144);
  await expect(writePart(ctx, data.uploadId, 0, new Uint8Array(6144))).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  await expect(writePart(ctx, data.uploadId, 6144, text('longer'))).rejects.toThrow();
  expect((await writePart(ctx, data.uploadId, 6144, text('end'))).nextOffset).toBe(6147);
  const file = await finishUpload(ctx, data.uploadId);
  const read = await readRange(ctx, file.id, 6142, 5);
  expect(new Uint8Array(await new Response(read.stream).arrayBuffer())).toEqual(
    Uint8Array.of(12, 12, 101, 110, 100),
  );
});

test('lost response on part Put preserves reservation and lets only matching bytes advance', async () => {
  const backend = memoryStore();
  let loseResponse = true;
  const ctx = await owner({
    ...backend,
    async put(key, body) {
      await backend.put(key, body);
      if (loseResponse) {
        loseResponse = false;
        throw new Error('Part response lost');
      }
    },
  });
  const data = input(3);
  await beginUpload(ctx, data, 'web');
  await expect(writePart(ctx, data.uploadId, 0, text('abc'))).rejects.toThrow();
  expect((await uploadStatus(ctx, data.uploadId)).nextOffset).toBe(0);
  await expect(writePart(ctx, data.uploadId, 0, text('xyz'))).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  expect((await writePart(ctx, data.uploadId, 0, text('abc'))).nextOffset).toBe(3);
});

test('lost response after storing original checks its hash and yields one stable ready result', async () => {
  const backend = memoryStore();
  const ctx = await owner({
    ...backend,
    async put(key, body) {
      await backend.put(key, body);
      if (body instanceof Blob) throw new Error('Original response lost');
    },
  });
  const file = await uploadText(ctx);
  const [saved] = await describeFiles(ctx, [file.id]);
  expect(saved).toEqual({
    id: file.id,
    name: 'план.txt',
    mediaType: 'application/octet-stream',
    byteSize: 17,
    sha256: hash,
  });
  const { stream } = await readRange(ctx, file.id);
  expect(await new Response(stream).text()).toBe(content);
});

test('transient original Put failure can resume finishing after another call', async () => {
  const backend = memoryStore();
  let failOriginal = true;
  const ctx = await owner({
    ...backend,
    async put(key, body) {
      if (body instanceof Blob && failOriginal) {
        failOriginal = false;
        throw new Error('Provider unavailable');
      }
      await backend.put(key, body);
    },
  });
  const data = input(content.length);
  const { fileId } = await beginUpload(ctx, data, 'web');
  await writePart(ctx, data.uploadId, 0, text(content));
  await expect(finishUpload(ctx, data.uploadId)).rejects.toThrow();
  expect(await describeFiles(ctx, [fileId])).toEqual([]);
  expect((await finishUpload(ctx, data.uploadId)).sha256).toBe(hash);
  expect((await finishUpload(ctx, data.uploadId)).id).toBe(fileId);
});

test('generic empty files complete with no parts and invalid empty PNG is never published', async () => {
  const ctx = await owner();
  const empty = input(0);
  await beginUpload(ctx, empty, 'web');
  expect((await finishUpload(ctx, empty.uploadId)).sha256).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  const invalid = { ...input(0, 'empty.png'), mediaType: 'image/png' };
  const { fileId } = await beginUpload(ctx, invalid, 'web');
  await expect(finishUpload(ctx, invalid.uploadId)).rejects.toThrow();
  expect(await describeFiles(ctx, [fileId])).toEqual([]);
});

test('effective file size and graph reservation admit the boundary and reject excess', async () => {
  const ctx = await owner();
  await expect(beginUpload(ctx, input(32 * 1024 * 1024 + 1), 'web')).rejects.toMatchObject({
    code: 'LIMIT',
  });
  for (let i = 0; i < 8; i++) await beginUpload(ctx, input(32 * 1024 * 1024), 'web');
  await expect(beginUpload(ctx, input(1), 'web')).rejects.toMatchObject({ code: 'LIMIT' });

  const attempts = await owner();
  for (let i = 0; i < 16; i++) await beginUpload(attempts, input(0), 'web');
  await expect(beginUpload(attempts, input(0), 'web')).rejects.toMatchObject({ code: 'LIMIT' });
});

test('uploads stay tied to a live specific grant and expire before further writes', async () => {
  const ctx = await owner();
  const token = await issuePatGrant(db, { identity: ctx.identity, label: 'test file access' });
  const verified = await verifyBearer(db, token);
  if (!verified) throw new Error('Не удалось проверить тестовый грант.');
  const viaGrant = {
    ...ctx,
    identity: identityOfGrant(verified),
    grant: { id: verified.grantId, scope: verified.scope, label: verified.label },
  };
  const data = input(3);
  await beginUpload(viaGrant, data, 'mcp');
  await expect(uploadStatus(ctx, data.uploadId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    writePart(
      { ...viaGrant, grant: { ...viaGrant.grant, scope: 'worker' } },
      data.uploadId,
      0,
      text('abc'),
    ),
  ).rejects.toMatchObject({ code: 'FORBIDDEN_LEVEL' });
  await revokeGrant(db, { graphId: verified.graphId, grantId: verified.grantId });
  await expect(writePart(viaGrant, data.uploadId, 0, text('abc'))).rejects.toMatchObject({
    code: 'FORBIDDEN_LEVEL',
  });
  await expect(finishUpload(viaGrant, data.uploadId)).rejects.toMatchObject({
    code: 'FORBIDDEN_LEVEL',
  });

  const own = await beginUpload(ctx, input(3), 'web');
  await withIdentity(db, ctx.identity, (tx) =>
    tx
      .update(fileUploads)
      .set({ expiresAt: new Date(0) })
      .where(eq(fileUploads.id, own.uploadId)),
  );
  expect((await uploadStatus(ctx, own.uploadId)).state).toBe('expired');
  await expect(writePart(ctx, own.uploadId, 0, text('abc'))).rejects.toThrow();
});

test('a read lease covers an open stream and clears on cancellation', async () => {
  const backend = memoryStore();
  const ctx = await owner(backend);
  const file = await uploadText(ctx);
  let cancelled = false;
  const result = await readRange(
    {
      ...ctx,
      store: {
        ...backend,
        async read() {
          return new ReadableStream({
            cancel() {
              cancelled = true;
            },
          });
        },
      },
    },
    file.id,
  );
  const countHolds = () =>
    withIdentity(db, ctx.identity, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(fileHolds)
        .where(and(eq(fileHolds.fileId, file.id), eq(fileHolds.sourceKind, 'read'))),
    );
  expect(await countHolds()).toEqual([{ count: 1 }]);
  await result.stream.cancel();
  expect(cancelled).toBe(true);
  expect(await countHolds()).toEqual([{ count: 0 }]);
});

test('an unpublished file belongs to its upload while published originals are visible to graph readers', async () => {
  const ctx = await owner();
  const file = await uploadText(ctx);
  const outsider = await owner(ctx.store);
  await expect(readRange(outsider, file.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const memberGraph = await freshGraph();
  await addMember(ctx.identity.graph, accountOf(memberGraph), 'observer');
  const member = {
    ...ctx,
    identity: identityOfGrant({ accountId: accountOf(memberGraph), graphId: ctx.identity.graph }),
  };
  expect(await describeFiles(member, [file.id])).toEqual([]);
  await expect(readRange(member, file.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await withIdentity(db, ctx.identity, (tx) =>
    tx.update(fileAssets).set({ publishedAt: new Date() }).where(eq(fileAssets.id, file.id)),
  );
  expect(await describeFiles(member, [file.id])).toEqual([file]);
  expect(await new Response((await readRange(member, file.id, 6, 50)).stream).text()).toBe(
    'attachments',
  );
});

test.skipIf(!process.env.ORBIS_TEST_FILE_STORAGE)(
  'the same upload and range contract works against Supabase Storage',
  async () => {
    const ctx = await owner(getFileStore());
    const file = await uploadText(ctx);
    const { stream, length } = await readRange(ctx, file.id, 6, 11);
    expect(length).toBe(11);
    expect(await new Response(stream).text()).toBe('attachments');
    expect(file.sha256).toBe(hash);
  },
);

test('concurrent finish calls share one verified generation, reject a different grant, and resume an abandoned generation', async () => {
  const backend = memoryStore();
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let partReads = 0;
  const ctx = await owner({
    ...backend,
    async read(key, range) {
      if (key.startsWith('parts/')) {
        partReads++;
        started.resolve();
        await release.promise;
      }
      return backend.read(key, range);
    },
  });
  const data = input(content.length);
  const { fileId } = await beginUpload(ctx, data, 'web');
  await writePart(ctx, data.uploadId, 0, text(content));
  // A process died after claiming this generation. Its work must be recoverable.
  await withIdentity(db, ctx.identity, async (tx) => {
    await tx
      .update(fileUploads)
      .set({ state: 'finishing', generation: 5 })
      .where(eq(fileUploads.fileId, fileId));
    await tx.insert(fileHolds).values({
      graphId: ctx.identity.graph,
      fileId,
      sourceKind: 'finish',
      sourceKey: '5',
      expiresAt: new Date(0),
    });
  });
  const first = finishUpload(ctx, data.uploadId);
  await Promise.race([
    started.promise,
    first.then(() => {
      throw Error('expected outstanding Storage read');
    }),
  ]);
  const retry = finishUpload(ctx, data.uploadId);
  const joined = Promise.allSettled([first, retry]);
  try {
    const token = await issuePatGrant(db, { identity: ctx.identity, label: 'separate grant' });
    const verified = await verifyBearer(db, token);
    if (!verified) throw Error('expected grant');
    await expect(
      finishUpload(
        { ...ctx, grant: { id: verified.grantId, scope: verified.scope, label: verified.label } },
        data.uploadId,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A separate database connection can read the state while both callers wait.
    expect((await uploadStatus(ctx, data.uploadId)).state).toBe('finishing');
    await Bun.sleep(200);
  } finally {
    release.resolve();
  }
  const result = await joined;
  expect(result[0]?.status).toBe('fulfilled');
  expect(result[1]).toEqual(result[0]);
  expect(partReads).toBe(1);
  const [row] = await withIdentity(db, ctx.identity, (tx) =>
    tx.select().from(fileUploads).where(eq(fileUploads.fileId, fileId)),
  );
  expect(row?.generation).toBe(6);
});

test.skipIf(process.env.ORBIS_TEST_FILE_STORAGE !== '1')(
  'web and MCP finish survive the Bun idle deadline with a paused Storage read',
  async () => {
    const { SignJWT } = await import('jose');
    const { createApp } = await import('../app');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    const { spyOn } = await import('bun:test');
    const store = getFileStore(),
      ctx = await owner(store),
      savedJwt = process.env.SUPABASE_JWT_SECRET;
    const token = await issuePatGrant(db, { identity: ctx.identity, label: 'slow finish' });
    const verified = await verifyBearer(db, token);
    if (!verified) throw Error('expected grant');
    const grant = { id: verified.grantId, label: verified.label, scope: verified.scope };
    const web = input(content.length),
      mcp = input(content.length);
    const a = await beginUpload(ctx, web, 'web'),
      b = await beginUpload({ ...ctx, grant }, mcp, 'mcp');
    await writePart(ctx, web.uploadId, 0, text(content));
    await writePart({ ...ctx, grant }, mcp.uploadId, 0, text(content));
    const { db: appDbHandle } = ctx;
    const app = createApp({ db: appDbHandle, ai: {} as import('../ai/send-message').AiDeps });
    const extended: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 10,
      fetch(request, nativeServer) {
        return app.fetch(request, {
          server: {
            timeout(original: Request, seconds: number) {
              if (original === request && seconds > 10)
                extended.push(new URL(original.url).pathname);
              nativeServer.timeout(original, seconds);
            },
          },
        });
      },
    });
    const agent = new Client({ name: 'slow-finish-test', version: '1' });
    const originalRead = store.read.bind(store);
    const pause = spyOn(store, 'read').mockImplementation(async (key, range) => {
      if (key.startsWith(`parts/${ctx.identity.graph}/`)) await Bun.sleep(11_000);
      return originalRead(key, range);
    });
    try {
      process.env.SUPABASE_JWT_SECRET = 'local-transfer-test-key';
      const jwt = await new SignJWT({ role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(ctx.identity.actor)
        .setAudience('authenticated')
        .setExpirationTime('5m')
        .sign(text(process.env.SUPABASE_JWT_SECRET));
      await agent.connect(
        new StreamableHTTPClientTransport(new URL('/mcp', server.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const [webResponse, mcpResponse] = await Promise.all([
        fetch(new URL('/trpc/files.finish', server.url), {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId: web.uploadId }),
        }),
        agent.callTool({ name: 'file_upload_finish', arguments: { uploadId: mcp.uploadId } }),
      ]);
      expect(extended.sort()).toEqual(['/mcp', '/trpc/files.finish']);
      expect(webResponse.status).toBe(200);
      expect((await webResponse.json()).result.data.id).toBe(a.fileId);
      expect(mcpResponse.isError).not.toBe(true);
      expect(
        JSON.parse((mcpResponse.content as Array<{ text: string }>)[0]?.text ?? '{}').result.id,
      ).toBe(b.fileId);
    } finally {
      pause.mockRestore();
      await agent.close();
      await server.stop(true);
      if (savedJwt === undefined) delete process.env.SUPABASE_JWT_SECRET;
      else process.env.SUPABASE_JWT_SECRET = savedJwt;
      for (const upload of [a, b]) {
        await store.remove(`parts/${ctx.identity.graph}/${upload.uploadId}/0`);
        await store.remove(`originals/${ctx.identity.graph}/${upload.fileId}`);
      }
    }
  },
  35_000,
);

test('revocation while two finish callers are waiting prevents publication and receipt replay', async () => {
  const backend = memoryStore();
  const started = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const ctx = await owner({
    ...backend,
    async read(key, range) {
      started.resolve();
      await resume.promise;
      return backend.read(key, range);
    },
  });
  const token = await issuePatGrant(db, {
    identity: ctx.identity,
    label: 'revocation during finish',
  });
  const verified = await verifyBearer(db, token);
  if (!verified) throw Error('expected grant');
  const viaGrant = {
    ...ctx,
    grant: { id: verified.grantId, scope: verified.scope, label: verified.label },
  };
  const data = input(content.length);
  const { fileId } = await beginUpload(viaGrant, data, 'mcp');
  await writePart(viaGrant, data.uploadId, 0, text(content));
  const first = finishUpload(viaGrant, data.uploadId);
  await Promise.race([
    started.promise,
    first.then(() => {
      throw Error('expected outstanding part');
    }),
  ]);
  const retry = finishUpload(viaGrant, data.uploadId);
  const joined = Promise.allSettled([first, retry]);
  try {
    await revokeGrant(db, { graphId: verified.graphId, grantId: verified.grantId });
  } finally {
    resume.resolve();
  }
  const outcomes = await joined;
  expect(outcomes).toMatchObject([
    { status: 'rejected', reason: { code: 'FORBIDDEN_LEVEL' } },
    { status: 'rejected', reason: { code: 'FORBIDDEN_LEVEL' } },
  ]);
  expect(await describeFiles(ctx, [fileId])).toEqual([]);
});

test.skipIf(process.env.ORBIS_TEST_FILE_STORAGE !== '1')(
  'the bounded finish wait returns a recoverable status while its assembly continues',
  async () => {
    const backend = memoryStore(),
      resume = Promise.withResolvers<void>();
    let reads = 0;
    const ctx = await owner({
      ...backend,
      async read(key, range) {
        reads++;
        await resume.promise;
        return backend.read(key, range);
      },
    });
    const data = input(content.length);
    const { fileId } = await beginUpload(ctx, data, 'web');
    await writePart(ctx, data.uploadId, 0, text(content));
    try {
      await expect(finishUpload(ctx, data.uploadId)).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'upload_finishing', state: 'finishing' },
      });
      expect((await uploadStatus(ctx, data.uploadId)).state).toBe('finishing');
    } finally {
      resume.resolve();
    }
    expect((await finishUpload(ctx, data.uploadId)).id).toBe(fileId);
    expect(reads).toBe(1);
  },
  52_000,
);
