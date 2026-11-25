import { afterAll, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import type { FileFieldEdit } from '@orbis/shared/files';
import { eq, sql } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { agentGrants, entities, fileAssets, fileHolds, fileUploads } from '../db/schema';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import { approvePending, rejectPending } from '../policy/pending';
import { appRouter } from '../router';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';

requireEnv();
const admin = adminDb();
const app = appDb();
afterAll(async () => {
  await Promise.all([admin.client.end(), app.client.end()]);
});

test('concurrent additions keep both bindings, original result replays, and a foreign file rolls back', async () => {
  const previous = process.env.ORBIS_FILE_WRITES;
  process.env.ORBIS_FILE_WRITES = '1';
  try {
    const graph = await freshGraph();
    const identity = personal(graph);
    const other = await freshGraph();
    const id = newId();
    await admin.db.insert(entities).values({ id, graphId: graph, title: 'file bindings' });
    const a = newId(),
      b = newId(),
      foreign = newId();
    for (const [file, graphId] of [
      [a, graph],
      [b, graph],
      [foreign, other],
    ] as const) {
      await admin.db.insert(fileAssets).values({
        id: file,
        graphId,
        state: 'ready',
        name: 'file.txt',
        objectKey: file,
        publishedAt: new Date(),
        byteSize: 1,
        mediaType: 'text/plain',
        sha256: 'c'.repeat(64),
      });
    }
    const propertyId = 'orbis/attachments';
    const add = (fileId: string): FileFieldEdit => ({
      entityId: id,
      propertyId,
      commandId: newId(),
      edit: { kind: 'add', fileId },
    });
    const run = (tool: string, input: unknown) =>
      execute(
        app.db,
        {
          identity,
          source: 'ui',
          actorKind: 'owner',
          fileCapability: true,
          operations: [{ tool, input }],
        },
        { sink: makeJournalSink() },
      );
    const first = add(a),
      second = add(b);
    let concurrent: ReturnType<typeof run>[] = [];
    await admin.db.transaction(async (tx) => {
      // Hold the entity row until both independent writers queue on the row
      // (Postgres queues later tuple lockers behind the first waiting writer).
      const [blocker] = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid FROM entities WHERE id=${id} FOR UPDATE`,
      );
      concurrent = [run('file_field_edit', first), run('file_field_edit', second)];
      let waiting = 0;
      const deadline = Date.now() + 10000;
      while (waiting < 2 && Date.now() < deadline) {
        const [row] = await tx.execute<{ n: number }>(sql`WITH RECURSIVE waiting(pid) AS (
          SELECT ${blocker!.pid}::int UNION
          SELECT a.pid FROM pg_locks a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE NOT a.granted
        ) SELECT (count(*)-1)::int AS n FROM waiting`);
        waiting = row?.n ?? 0;
        if (waiting < 2) await Bun.sleep(15);
      }
      expect(waiting).toBeGreaterThanOrEqual(2);
    });
    const results = await Promise.all(concurrent);
    expect(results.map((x) => x.ok)).toEqual([true, true]);
    const original = results[0];
    if (!original?.ok) throw new Error(JSON.stringify(original));
    const replay = await run('file_field_edit', first);
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    const [row] = await admin.db.select().from(entities).where(eq(entities.id, id));
    expect(new Set((row?.props as Record<string, string[]>)[propertyId])).toEqual(new Set([a, b]));
    expect(row?.bodyRevision).toBe(1);
    const holds = await admin.db.select().from(fileHolds).where(eq(fileHolds.graphId, graph));
    expect(
      holds
        .filter((x) => x.sourceKind === 'property')
        .map((x) => x.fileId)
        .sort(),
    ).toEqual([a, b].sort());
    const denied = await run('entity_update', {
      id,
      props: { [propertyId]: [foreign] },
      expectedFileProps: { [propertyId]: (row?.props as Record<string, string[]>)[propertyId] },
    });
    expect(denied.ok).toBe(false);
    const remove = { ...add(a), edit: { kind: 'remove', fileId: a } };
    const batchId = newId();
    const failed = await run('batch_execute', {
      batch_id: batchId,
      operations: [
        { tool: 'file_field_edit', input: remove },
        { tool: 'file_field_edit', input: add(foreign) },
      ],
    });
    expect(failed).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect((await admin.db.select().from(entities).where(eq(entities.id, id)))[0]?.props).toEqual(
      row?.props,
    );
    const [receipts] = await admin.db.execute<{ n: number }>(sql`SELECT (
      (SELECT count(*) FROM file_commands WHERE graph_id=${graph} AND id=${remove.commandId}) +
      (SELECT count(*) FROM action_journal WHERE graph_id=${graph} AND id=${batchId})
      )::int AS n`);
    expect(receipts?.n).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.ORBIS_FILE_WRITES;
    else process.env.ORBIS_FILE_WRITES = previous;
  }
}, 30000);

test('owner field edits recover selection order and preserve another client’s addition', async () => {
  const saved = process.env.ORBIS_FILE_WRITES;
  process.env.ORBIS_FILE_WRITES = '1';
  try {
    const graph = await freshGraph();
    const identity = personal(graph);
    const caller = (clientVersion: string | null) =>
      createCallerFactory(appRouter)({ db: app.db, identity, actorKind: 'owner', clientVersion });
    const owner = caller('0.8.0');
    const entityId = newId();
    const propertyId = 'orbis/attachments';
    const a = newId(),
      b = newId(),
      c = newId(),
      x = newId();
    await admin.db.insert(entities).values({ id: entityId, graphId: graph, title: 'Материалы' });
    await admin.db.insert(fileAssets).values(
      [a, b, c, x].map((id) => ({
        id,
        graphId: graph,
        name: 'материал',
        state: 'ready',
        publishedAt: new Date(),
        objectKey: `originals/${graph}/${id}`,
        byteSize: 1,
        mediaType: 'text/plain',
        sha256: 'a'.repeat(64),
      })),
    );
    const edit = (change: FileFieldEdit['edit'], commandId = newId()) =>
      owner.files.editField({ entityId, propertyId, commandId, edit: change });
    await edit({ kind: 'add', fileId: a });
    await edit({ kind: 'add', fileId: c });
    await edit({ kind: 'add', fileId: x });
    const retry = newId();
    const inserted = await edit({ kind: 'add', fileId: b, beforeId: c }, retry);
    expect(inserted.value).toEqual([a, b, c, x]);
    expect(await edit({ kind: 'add', fileId: b, beforeId: c }, retry)).toEqual(inserted);
    await edit({ kind: 'remove', fileId: b });
    await edit({ kind: 'remove', fileId: c });
    await expect(edit({ kind: 'add', fileId: b, beforeId: c })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      edit({ kind: 'reorder', expected: [a, b, c, x], value: [x, c, b, a] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const independent = await edit({ kind: 'add', fileId: b });
    await edit({ kind: 'add', fileId: c });
    if (!independent.actionId) throw Error('Ожидалось действие добавления');
    await owner.ai.undo({ actionId: independent.actionId });
    expect((await owner.entity.get({ id: entityId })).entity.props[propertyId]).toEqual([a, x, c]);
    await edit({ kind: 'remove', fileId: c });
    const replacement = await owner.entity.update({
      id: entityId,
      props: { [propertyId]: [b.toUpperCase()] },
      expectedFileProps: { [propertyId]: [a, x] },
    });
    expect(replacement.props[propertyId]).toEqual([b]);
    await edit({ kind: 'add', fileId: c });
    await expect(owner.ai.undo({ actionId: replacement.actionId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await owner.entity.update({
      id: entityId,
      props: { [propertyId]: [] },
      expectedFileProps: { [propertyId]: [b, c] },
    });
    expect((await owner.entity.get({ id: entityId })).entity.props).not.toHaveProperty(propertyId);
    await edit({ kind: 'add', fileId: b });
    expect((await edit({ kind: 'remove', fileId: b })).value).toBeNull();
    expect((await owner.entity.get({ id: entityId })).entity.props).not.toHaveProperty(propertyId);
    await edit({ kind: 'add', fileId: a });
    await edit({ kind: 'add', fileId: x });
    const first = await owner.entity.update({
      id: entityId,
      body: `[файл](orbis-file:${a}) [повтор](orbis-file:${a})`,
      expectedBodyRevision: 1,
    });
    const second = await owner.entity.update({
      id: entityId,
      body: `[файл](orbis-file:${a})`,
      expectedBodyRevision: first.bodyRevision,
    });
    expect(
      (await admin.db.select().from(fileHolds).where(eq(fileHolds.graphId, graph)))
        .filter((h) => h.sourceKind === 'body')
        .map((h) => h.fileId),
    ).toEqual([a]);
    const pin = await owner.version.pin({ entityId, label: 'Файловая версия' });
    const input = { id: entityId, body: 'новое тело', expectedBodyRevision: second.bodyRevision };
    for (const version of [null, 'invalid', '0.7.0']) {
      await expect(caller(version).entity.update(input)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      await expect(
        caller(version).entity.updateBatch({ operations: [{ tool: 'entity_update', input }] }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    }
    await expect(
      owner.entity.update({
        id: entityId,
        expectedBodyRevision: second.bodyRevision,
        bodyDoc: {
          v: 4,
          doc: {
            type: 'doc',
            content: [
              { type: 'rawBlock', attrs: { markdown: '* раз' } },
              {
                type: 'paragraph',
                content: [
                  { type: 'fileRef', attrs: { fileId: a, display: 'link', label: 'Файл' } },
                ],
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await owner.entity.get({ id: entityId, include: ['body'] })).entity.body).toBe(
      second.body,
    );
    const clean = await owner.entity.update(input);
    const restored = await owner.version.restore({
      versionId: pin.id,
      expectedBodyRevision: clean.bodyRevision,
    });
    expect(restored.body).toContain(a);
    expect(restored.props[propertyId]).toEqual([a, x]);
    process.env.ORBIS_FILE_WRITES = '0';
    await expect(edit({ kind: 'add', fileId: b })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      owner.entity.update({
        id: entityId,
        body: 'стереть',
        expectedBodyRevision: restored.bodyRevision,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await owner.entity.update({ id: entityId, title: 'Без правки файлов' })).title).toBe(
      'Без правки файлов',
    );
    expect((await owner.files.describe({ ids: [a] }))[0]?.id).toBe(a);
  } finally {
    if (saved === undefined) delete process.env.ORBIS_FILE_WRITES;
    else process.env.ORBIS_FILE_WRITES = saved;
  }
}, 30000);

test('pending attachment survives upload expiry, deduplicates retries and rechecks revoked grants', async () => {
  const flag = process.env.ORBIS_FILE_WRITES;
  process.env.ORBIS_FILE_WRITES = '1';
  try {
    const graph = await freshGraph(),
      identity = personal(graph),
      entityId = newId(),
      grantId = newId();
    const propertyId = 'orbis/attachments';
    await admin.db.insert(entities).values({ id: entityId, graphId: graph, title: 'Согласование' });
    await admin.db.insert(agentGrants).values({
      id: grantId,
      graphId: graph,
      issuedBy: identity.actor,
      kind: 'pat',
      label: 'Файлы',
    });
    const ctx: ToolCallCtx = {
      db: app.db,
      identity,
      actorKind: 'agent',
      source: 'mcp',
      explicitCommand: false,
      grant: { id: grantId, scope: 'full', label: 'Файлы' },
    };
    const call = (tool: string, input: unknown) => dispatchTool(ctx, tool, input);
    async function propose() {
      const fileId = newId(),
        uploadId = newId(),
        expiresAt = new Date(Date.now() + 60_000);
      await admin.db.insert(fileAssets).values({
        id: fileId,
        graphId: graph,
        state: 'ready',
        name: 'файл',
        objectKey: fileId,
        byteSize: 1,
        mediaType: 'text/plain',
        sha256: 'b'.repeat(64),
      });
      await admin.db.insert(fileUploads).values({
        id: uploadId,
        fileId,
        graphId: graph,
        ownerActor: identity.actor,
        ownerGrantId: grantId,
        declaredSize: 1,
        nextOffset: 1,
        chunkBytes: 6144,
        state: 'ready',
        expiresAt,
      });
      await admin.db
        .insert(fileHolds)
        .values({ graphId: graph, fileId, sourceKind: 'upload', sourceKey: uploadId, expiresAt });
      const command = { entityId, propertyId, commandId: newId(), edit: { kind: 'add', fileId } };
      const batch = {
        batch_id: newId(),
        operations: [
          { tool: 'file_field_edit', input: command },
          ...Array.from({ length: 10 }, () => ({
            tool: 'entity_create',
            input: { id: newId(), title: 'Строка группы', tags: [] },
          })),
        ],
      };
      const r = await call('batch_execute', batch);
      if (r.status !== 'pending_confirmation') throw Error(JSON.stringify(r));
      expect(await call('batch_execute', batch)).toEqual(r);
      expect(await call('file_field_edit', command)).toEqual(r);
      const holds = () => admin.db.select().from(fileHolds).where(eq(fileHolds.fileId, fileId));
      expect(
        (await holds()).some((h) => h.sourceKind === 'pending' && h.sourceKey === r.pendingId),
      ).toBe(true);
      await admin.db
        .update(fileUploads)
        .set({ expiresAt: new Date(0) })
        .where(eq(fileUploads.id, uploadId));
      await admin.db
        .update(fileHolds)
        .set({ expiresAt: new Date(0) })
        .where(eq(fileHolds.sourceKey, uploadId));
      return { fileId, command, batch, pendingId: r.pendingId, holds };
    }
    const owner = createCallerFactory(appRouter)({
      db: app.db,
      identity,
      actorKind: 'owner',
      clientVersion: '0.8.0',
    });
    const definition = (await owner.registry.createProperty({
      key: 'user/cover',
      label: { ru: 'Обложка' },
      description: { ru: 'Файл' },
      type: { kind: 'file', cardinality: 'one' },
      status: 'proposed',
    })) as { property: string };
    const a = await propose();

    const approved = await approvePending(app.db, { identity, pendingId: a.pendingId });
    if (!approved.ok) throw Error(JSON.stringify(approved));
    expect(approved.results[0]).toMatchObject({ value: [a.fileId] });
    expect((await a.holds()).map((h) => h.sourceKind)).toEqual(['property']);
    expect(await call('file_field_edit', a.command)).toMatchObject({
      status: 'ok',
      result: approved.results[0],
      actionId: a.pendingId,
    });
    expect(await call('batch_execute', a.batch)).toMatchObject({
      status: 'ok',
      result: approved.results,
      actionId: a.pendingId,
    });
    await owner.files.editField({
      entityId,
      propertyId: definition.property,
      commandId: newId(),
      edit: { kind: 'set', expected: null, fileId: a.fileId },
    });
    const clear = await owner.files.editField({
      entityId,
      propertyId: definition.property,
      commandId: newId(),
      edit: { kind: 'clear', expected: a.fileId },
    });
    await owner.registry.updateProperty({ id: definition.property, status: 'deprecated' });
    expect(
      (await owner.registry.effective()).properties.find((p) => p.id === definition.property)
        ?.status,
    ).toBe('deprecated');
    if (!clear.actionId) throw Error('Ожидалось действие очистки');
    await owner.ai.undo({ actionId: clear.actionId });
    expect((await owner.entity.get({ id: entityId })).entity.props[definition.property]).toBe(
      a.fileId,
    );
    const b = await propose();
    await rejectPending(app.db, { identity, pendingId: b.pendingId });
    expect((await b.holds()).map((h) => h.sourceKind)).toEqual(['upload']);
    expect(await call('batch_execute', b.batch)).toMatchObject({
      status: 'error',
      error: { code: 'CONFLICT' },
    });
    expect(await call('file_field_edit', b.command)).toMatchObject({
      status: 'error',
      error: { code: 'CONFLICT', details: { reason: 'file_command_rejected' } },
    });
    const c = await propose();
    await admin.db
      .update(agentGrants)
      .set({ revokedAt: new Date() })
      .where(eq(agentGrants.id, grantId));
    expect(await approvePending(app.db, { identity, pendingId: c.pendingId })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN_LEVEL' },
    });
    expect(await call('file_field_edit', a.command)).toMatchObject({
      status: 'error',
      error: { code: 'FORBIDDEN_LEVEL' },
    });
    expect((await c.holds()).some((h) => h.sourceKind === 'property')).toBe(false);
    const [row] = await admin.db.select().from(entities).where(eq(entities.id, entityId));
    expect((row?.props as Record<string, unknown>)[propertyId]).toEqual([a.fileId]);
  } finally {
    if (flag === undefined) delete process.env.ORBIS_FILE_WRITES;
    else process.env.ORBIS_FILE_WRITES = flag;
  }
}, 30000);

test('no-op file commands return receipts and preserve the last real Undo action', async () => {
  const flag = process.env.ORBIS_FILE_WRITES;
  process.env.ORBIS_FILE_WRITES = '1';
  try {
    const graph = await freshGraph(),
      identity = personal(graph),
      entityId = newId(),
      fileId = newId(),
      propertyId = 'orbis/attachments';
    const owner = createCallerFactory(appRouter)({
      db: app.db,
      identity,
      actorKind: 'owner',
      clientVersion: '0.8.0',
    });
    await admin.db
      .insert(entities)
      .values({ id: entityId, graphId: graph, title: 'Без изменений' });
    await admin.db.insert(fileAssets).values({
      id: fileId,
      graphId: graph,
      state: 'ready',
      publishedAt: new Date(),
      name: 'test',
      objectKey: fileId,
      byteSize: 1,
      mediaType: 'text/plain',
      sha256: 'a'.repeat(64),
    });
    const add = () => ({
      entityId,
      propertyId,
      commandId: newId(),
      edit: { kind: 'add' as const, fileId },
    });
    const real = await owner.files.editField(add());
    if (real.actionId === null)
      throw new Error('Добавление файла должно создать действие журнала.');
    const before = (await owner.entity.get({ id: entityId })).entity.updatedAt;
    const retry = add();
    const noop = await owner.files.editField(retry);
    expect(noop).toMatchObject({ actionId: null, value: [fileId], consequences: false });
    expect(await owner.files.editField(retry)).toEqual(noop);
    expect(
      await owner.files.editField({ ...add(), edit: { kind: 'remove', fileId: newId() } }),
    ).toMatchObject({ actionId: null, value: [fileId] });
    const ctx: ToolCallCtx = {
      db: app.db,
      identity,
      actorKind: 'ai',
      source: 'chat',
      explicitCommand: false,
    };
    const batch = {
      batch_id: newId(),
      operations: Array.from({ length: 11 }, () => ({ tool: 'file_field_edit', input: add() })),
    };
    const proposed = await dispatchTool(ctx, 'batch_execute', batch);
    if (proposed.status !== 'pending_confirmation') throw Error(JSON.stringify(proposed));
    const approved = await approvePending(app.db, { identity, pendingId: proposed.pendingId });
    expect(approved).toMatchObject({ ok: true, noGraphChange: true });
    expect(await approvePending(app.db, { identity, pendingId: proposed.pendingId })).toMatchObject(
      { ok: true, noGraphChange: true, idempotentReplay: true },
    );
    expect(await dispatchTool(ctx, 'batch_execute', batch)).toMatchObject({
      status: 'ok',
      result: batch.operations.map(() => ({ entityId, propertyId, value: [fileId] })),
    });
    expect(await rejectPending(app.db, { identity, pendingId: proposed.pendingId })).toMatchObject({
      ok: false,
    });
    expect((await owner.entity.get({ id: entityId })).entity.updatedAt).toEqual(before);
    const [row] = await admin.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM action_journal WHERE graph_id=${graph}`,
    );
    expect(row?.n).toBe(1);
    expect((await owner.ai.undoLast()).actionId).toBe(real.actionId);
    expect((await owner.entity.get({ id: entityId })).entity.props).not.toHaveProperty(propertyId);
    expect(await owner.files.editField(retry)).toEqual(noop);
  } finally {
    if (flag === undefined) delete process.env.ORBIS_FILE_WRITES;
    else process.env.ORBIS_FILE_WRITES = flag;
  }
}, 30000);
