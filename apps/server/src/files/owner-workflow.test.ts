import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { newId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { buildGraphPackage } from './export-package';
import { readRange } from './read';
import { getFileStore } from './store';
import { writePart } from './uploads';

requireEnv();
const { db, client } = appDb();
afterAll(() => client.end());

test.skipIf(process.env.ORBIS_TEST_FILE_STORAGE !== '1')(
  'owner keeps five originals in order, edits a named PDF independently and reads after disabling writes',
  async () => {
    const prior = process.env.ORBIS_FILE_WRITES;
    const graph = await freshGraph();
    const ctx = { db, identity: personal(graph) };
    const caller = createCallerFactory(appRouter)({
      ...ctx,
      actorKind: 'owner',
      clientVersion: '0.8.0',
    });
    const store = getFileStore();
    const keys: string[] = [];
    const attachments = 'orbis/attachments';
    const countRecords = () =>
      withIdentity(
        db,
        ctx.identity,
        async (tx) =>
          (await tx.select({ id: entities.id }).from(entities).where(eq(entities.graphId, graph)))
            .length,
      );
    try {
      const id = newId();
      const empty = {
        uploadId: newId(),
        name: 'До включения.pdf',
        byteSize: 9,
        mediaType: 'application/pdf',
      };
      process.env.ORBIS_FILE_WRITES = '0';
      await expect(caller.files.begin(empty)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      process.env.ORBIS_FILE_WRITES = '1';
      await caller.entity.create({
        source: 'ui',
        input: { id, title: 'Сметы за месяц', tags: [] },
      });
      const named = await caller.registry.createProperty({
        label: { ru: 'Смета' },
        description: { ru: 'Подписанная смета' },
        status: 'active',
        type: { kind: 'file', cardinality: 'one' },
      });
      if (!('property' in named)) throw Error('Определение свойства не вернуло ID');
      const namedId = named.property;
      const before = await countRecords();
      const ids: string[] = [];
      for (let n = 1; n <= 5; n++) {
        const data = Buffer.from(`%PDF-1.4\n% estimate ${n}\n%%EOF`);
        const uploadId = newId();
        const status = await caller.files.begin({
          uploadId,
          name: `Смета ${n}.pdf`,
          byteSize: data.byteLength,
          mediaType: 'application/pdf',
        });
        keys.push(`parts/${graph}/${uploadId}/0`, `originals/${graph}/${status.fileId}`);
        await writePart(ctx, uploadId, 0, data);
        const info = await caller.files.finish({ uploadId });
        expect(info.sha256).toBe(createHash('sha256').update(data).digest('hex'));
        await caller.files.editField({
          entityId: id,
          propertyId: attachments,
          commandId: newId(),
          edit: { kind: 'add', fileId: info.id },
        });
        ids.push(info.id);
      }
      const estimate = ids[1];
      if (!estimate) throw Error('Отсутствует вторая смета');
      await caller.files.editField({
        entityId: id,
        propertyId: namedId,
        commandId: newId(),
        edit: { kind: 'set', expected: null, fileId: estimate },
      });
      const order = [...ids].reverse();
      expect(
        (
          await caller.files.editField({
            entityId: id,
            propertyId: attachments,
            commandId: newId(),
            edit: { kind: 'reorder', expected: ids, value: order },
          })
        ).value,
      ).toEqual(order);
      const remove = {
        entityId: id,
        propertyId: attachments,
        commandId: newId(),
        edit: { kind: 'remove' as const, fileId: estimate },
      };
      const result = await caller.files.editField(remove);
      expect(result.value).toEqual(order.filter((fileId) => fileId !== estimate));
      expect(await caller.files.editField(remove)).toEqual(result);
      expect(await countRecords()).toBe(before);
      const archived = await caller.entity.update({ id, archived: true });
      expect(archived.props[namedId]).toBe(estimate);
      process.env.ORBIS_FILE_WRITES = '0';
      await expect(caller.files.begin({ ...empty, uploadId: newId() })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        caller.files.editField({
          ...remove,
          commandId: newId(),
          edit: { kind: 'add', fileId: estimate },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await caller.files.describe({ ids: [estimate] }))[0]?.mediaType).toBe(
        'application/pdf',
      );
      const bytes = await new Response((await readRange(ctx, estimate)).stream).text();
      expect(bytes).toBe('%PDF-1.4\n% estimate 2\n%%EOF');
      const archive = await buildGraphPackage(ctx);
      const zip = new Uint8Array(await new Response(archive.stream).arrayBuffer());
      expect(zip.byteLength).toBe(archive.length);
      expect([...zip.subarray(0, 4)]).toEqual([80, 75, 3, 4]);
      expect((await caller.entity.update({ id, title: 'Архив смет' })).title).toBe('Архив смет');
    } finally {
      if (prior === undefined) delete process.env.ORBIS_FILE_WRITES;
      else process.env.ORBIS_FILE_WRITES = prior;
      for (const key of keys) await store.remove(key);
    }
  },
  30000,
);
