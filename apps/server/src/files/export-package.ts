import { createHash } from 'node:crypto';
import { addAbortSignal, Readable } from 'node:stream';
import { and, eq, sql } from 'drizzle-orm';
import { ZipFile } from 'yazl';
import type { Db } from '../db/client';
import { fileAssets, fileHolds } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { readGraphExport } from '../export';
import type { Identity } from '../identity';
import { openResponseFile, type ResponseFile, sendResponseFile } from './response-file';
import { type FileStore, getFileStore } from './store';

type ExportContext = {
  db: Db;
  identity: Identity;
  store?: FileStore;
  signal?: AbortSignal;
  /** Bun keeps a native file response open until the request leaves its active set. */
  sending?: () => boolean;
};
export class ExportPackageError extends Error {}

const leaseExpiry = sql`clock_timestamp() + interval '2 minutes'`;
const MAX_ACTIVE_PACKAGES = 2;
const REQUEST_LIMIT_MS = 30 * 60_000;
let activePackages = 0;

function lockAssets(tx: Tx, ctx: ExportContext, ids: string[]) {
  // One parameter for graphs with more file IDs than PostgreSQL's parameter limit.
  return tx
    .select()
    .from(fileAssets)
    .where(
      and(
        eq(fileAssets.graphId, ctx.identity.graph),
        sql`${fileAssets.id} IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`,
      ),
    )
    .orderBy(fileAssets.id)
    .for('update');
}

async function snapshot(ctx: ExportContext, sourceKey: string, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await withIdentity(
        ctx.db,
        ctx.identity,
        async (tx) => {
          const [access] = await tx.execute<{ allowed: boolean }>(
            sql`SELECT public.actor_reads_current_graph() AS allowed`,
          );
          if (!access?.allowed) throw new ExecError('FORBIDDEN_LEVEL', 'Нет доступа к графу.');
          const { graph, fileIds, filePropertyDefinitions } = await readGraphExport(
            tx,
            ctx.identity.graph,
          );
          const assets = fileIds.length ? await lockAssets(tx, ctx, fileIds) : [];
          if (assets.length !== fileIds.length)
            throw new ExportPackageError('В снимке отсутствует обязательный оригинал.');
          const files = assets.map((asset) => {
            if (
              asset.objectKey !== `originals/${ctx.identity.graph}/${asset.id}` ||
              asset.state !== 'ready' ||
              !asset.publishedAt ||
              asset.byteSize === null ||
              !asset.sha256 ||
              !asset.mediaType
            )
              throw new ExportPackageError('Обязательный оригинал недоступен.');
            return {
              id: asset.id,
              key: asset.objectKey,
              info: {
                path: `files/${asset.id}`,
                name: asset.name,
                mediaType: asset.mediaType,
                byteSize: asset.byteSize,
                sha256: asset.sha256,
              },
            };
          });
          if (files.length)
            await tx.execute(sql`INSERT INTO file_holds (graph_id,file_id,source_kind,source_key,expires_at)
          SELECT ${ctx.identity.graph}::uuid, value::uuid, 'export', ${sourceKey}, ${leaseExpiry}
          FROM jsonb_array_elements_text(${JSON.stringify(fileIds)}::jsonb)`);
          signal.throwIfAborted();
          return {
            graph,
            files,
            fileIds,
            manifest: {
              version: 1,
              graph: 'graph.json',
              scope: {
                originals: 'current-entities-including-archived',
                journalOriginals: false,
                pinnedBodyVersions: false,
              },
              fileProperties: Object.fromEntries(
                filePropertyDefinitions.map(({ id, key, type, label }) => [
                  id,
                  { key, type, label },
                ]),
              ),
              files: Object.fromEntries(files.map(({ id, info }) => [id, info])),
            },
          };
        },
        { isolationLevel: 'repeatable read' },
      );
    } catch (error) {
      const pg = error as { code?: string; cause?: { code?: string } };
      if (attempt >= 3 || (pg.code ?? pg.cause?.code) !== '40001') throw error;
    }
  }
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

async function updateLease(
  ctx: ExportContext,
  ids: string[],
  sourceKey: string,
  action: 'renew' | 'release',
) {
  if (!ids.length) return;
  await withIdentity(ctx.db, ctx.identity, async (tx) => {
    await lockAssets(tx, ctx, ids);
    const lease = and(
      eq(fileHolds.graphId, ctx.identity.graph),
      eq(fileHolds.sourceKind, 'export'),
      eq(fileHolds.sourceKey, sourceKey),
    );
    if (action === 'release') {
      await tx.delete(fileHolds).where(lease);
      return;
    }
    const rows = await tx
      .update(fileHolds)
      .set({ expiresAt: leaseExpiry })
      .where(and(lease, sql`${fileHolds.expiresAt} > clock_timestamp()`))
      .returning({ id: fileHolds.fileId });
    if (rows.length !== ids.length)
      throw new ExportPackageError('Срок удержания оригиналов истёк.');
  });
}

async function* verifiedOriginal(
  file: Snapshot['files'][number],
  store: FileStore | undefined,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const stream = await (store ?? getFileStore()).read(file.key).catch(() => {
    throw new ExportPackageError('Не удалось открыть оригинал в хранилище.');
  });
  const reader = stream.pipeThrough(new TransformStream(), { signal }).getReader();
  const hash = createHash('sha256');
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read().catch(() => {
        throw new ExportPackageError('Чтение оригинала прервалось.');
      });
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > file.info.byteSize)
        throw new ExportPackageError('Размер оригинала превышает сохранённый.');
      hash.update(chunk.value);
      yield chunk.value;
    }
    if (size !== file.info.byteSize || hash.digest('hex') !== file.info.sha256)
      throw new ExportPackageError('Размер или SHA-256 оригинала не совпадает со снимком.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function writeArchive(
  ctx: ExportContext,
  data: Snapshot,
  spool: ResponseFile,
  signal: AbortSignal,
) {
  const zip = new ZipFile();
  // yazl exposes a Node PassThrough, typed as the narrower NodeJS.ReadableStream.
  const output = addAbortSignal(signal, zip.outputStream as Readable);
  zip.on('error', (error: Error) => output.destroy(error));
  zip.addBuffer(Buffer.from(JSON.stringify(data.graph)), 'graph.json');
  zip.addBuffer(Buffer.from(JSON.stringify(data.manifest)), 'manifest.json');
  for (const file of data.files) {
    zip.addReadStreamLazy(file.info.path, { size: file.info.byteSize, compress: false }, (cb) => {
      const source = Readable.from(verifiedOriginal(file, ctx.store, signal));
      source.on('error', (error: Error) => output.destroy(error));
      cb(null, source);
    });
  }
  zip.end(); // yazl switches to ZIP64 when a count, offset or size exceeds the ZIP limits.
  for await (const chunk of output) await spool.writeFile(chunk as Buffer);
}

export async function buildGraphPackage(ctx: ExportContext) {
  if (activePackages >= MAX_ACTIVE_PACKAGES)
    throw new ExecError('CONFLICT', 'Экспорт уже выполняется. Повторите позже.');
  activePackages++;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(REQUEST_LIMIT_MS),
    ...(ctx.signal ? [ctx.signal] : []),
  ]);
  const sourceKey = crypto.randomUUID();
  let spool: ResponseFile | undefined;
  try {
    spool = await openResponseFile();
    const data = await snapshot(ctx, sourceKey, signal);
    let renewing: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewing || !data.files.length) return;
      renewing = updateLease(ctx, data.fileIds, sourceKey, 'renew')
        .catch((error) => controller.abort(error))
        .finally(() => {
          renewing = undefined;
        });
    }, 30_000);
    heartbeat.unref();
    try {
      await writeArchive(ctx, data, spool, signal);
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      clearInterval(heartbeat);
      await renewing;
      await updateLease(ctx, data.fileIds, sourceKey, 'release');
    }
    signal.throwIfAborted();
    const { size } = await spool.stat();
    const stream = sendResponseFile(spool, signal, ctx.sending, () => {
      activePackages--;
    });
    return { stream, length: size };
  } catch (error) {
    controller.abort(error);
    try {
      await spool?.close();
    } finally {
      activePackages--;
    }
    if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
      throw new ExportPackageError('Недостаточно места для сборки полного пакета.');
    }
    throw error;
  }
}
