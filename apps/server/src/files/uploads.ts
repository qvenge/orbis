import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FileInfo,
  type UploadBeginInput,
  type UploadStatus,
  uploadBeginInput,
  uploadStatusSchema,
} from '@orbis/shared/files';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { fileAssets, fileHolds, fileUploadParts, fileUploads } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import { type FileContext, ownedAttempt, parseFileId, withFileAccess } from './access';
import { fileLimits, requireFileWrites } from './file-limits';
import { verifyMediaType } from './media-type';
import { type FileStore, getFileStore } from './store';

type Upload = typeof fileUploads.$inferSelect;
type Asset = typeof fileAssets.$inferSelect;
type Part = typeof fileUploadParts.$inferSelect;

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_UPLOADS = 16;
const nextExpiration = () => new Date(Date.now() + RETENTION_MS);

function status(upload: Upload): UploadStatus {
  const pending = upload.state === 'open' || upload.state === 'finishing';
  return uploadStatusSchema.parse({
    uploadId: upload.id,
    fileId: upload.fileId,
    nextOffset: upload.nextOffset,
    chunkBytes: upload.chunkBytes,
    state: pending && upload.expiresAt.getTime() <= Date.now() ? 'expired' : upload.state,
    expiresAt: upload.expiresAt.toISOString(),
  });
}

function fileInfo(asset: Asset): FileInfo {
  if (
    asset.state !== 'ready' ||
    asset.mediaType === null ||
    asset.byteSize === null ||
    asset.sha256 === null
  ) {
    throw new ExecError('NOT_FOUND', 'Оригинал файла недоступен.');
  }
  return {
    id: asset.id,
    name: asset.name,
    mediaType: asset.mediaType,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
  };
}

async function findUpload(tx: Tx, ctx: FileContext, id: string, lock = false) {
  const query = tx
    .select()
    .from(fileUploads)
    .where(and(ownedAttempt(ctx), eq(fileUploads.id, id)));
  const [upload] = await (lock ? query.for('update') : query);
  return upload;
}

async function requireUpload(tx: Tx, ctx: FileContext, id: string, lock = false) {
  const upload = await findUpload(tx, ctx, id, lock);
  if (!upload) throw new ExecError('NOT_FOUND', 'Загрузка недоступна.');
  return upload;
}

async function requireAsset(tx: Tx, ctx: FileContext, id: string, lock = false) {
  const query = tx
    .select()
    .from(fileAssets)
    .where(and(eq(fileAssets.graphId, ctx.identity.graph), eq(fileAssets.id, id)));
  const [asset] = await (lock ? query.for('update') : query);
  if (!asset) throw new ExecError('NOT_FOUND', 'Оригинал файла недоступен.');
  return asset;
}

async function lockFinalization(tx: Tx, ctx: FileContext, id: string) {
  // Hold writers and GC take the same asset lock first, including when closing the upload.
  const attempt = await requireUpload(tx, ctx, id);
  const asset = await requireAsset(tx, ctx, attempt.fileId, true);
  const upload = await requireUpload(tx, ctx, id, true);
  return { asset, upload };
}

function rejectClosed(upload: Upload) {
  if (upload.expiresAt.getTime() <= Date.now() || upload.state === 'expired') {
    throw new ExecError('CONFLICT', 'Срок загрузки истёк.', { reason: 'upload_expired' });
  }
  if (upload.state === 'failed') {
    throw new ExecError('CONFLICT', 'Попытка завершилась ошибкой. Начните новую загрузку.', {
      reason: 'upload_failed',
    });
  }
}

export async function beginUpload(
  ctx: FileContext,
  input: UploadBeginInput,
  surface: 'web' | 'mcp',
): Promise<UploadStatus> {
  requireFileWrites();
  const parsed = uploadBeginInput.safeParse(input);
  if (!parsed.success) throw new ExecError('VALIDATION', 'Некорректные параметры загрузки.');
  const { uploadId, name, byteSize, mediaType } = parsed.data;
  const limits = fileLimits();
  const chunkBytes =
    surface === 'mcp' ? (parsed.data.chunkBytes ?? limits.mcpChunkBytes) : limits.webChunkBytes;
  if (
    (surface === 'web' && parsed.data.chunkBytes !== undefined) ||
    (surface === 'mcp' && chunkBytes > limits.mcpChunkBytes)
  ) {
    throw new ExecError('VALIDATION', 'Недопустимый размер порции.');
  }

  return withFileAccess(ctx, 'write', async (tx) => {
    const graph = ctx.identity.graph;
    // Quota and duplicate begin requests within the graph are decided together.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${graph}:file-uploads`}, 0))`,
    );
    const existing = await findUpload(tx, ctx, uploadId);
    if (existing) {
      const asset = await requireAsset(tx, ctx, existing.fileId);
      if (
        existing.declaredSize !== byteSize ||
        existing.declaredType !== (mediaType ?? null) ||
        existing.chunkBytes !== chunkBytes ||
        asset.name !== name
      ) {
        throw new ExecError('CONFLICT', 'Параметры уже начатой загрузки отличаются.', {
          reason: 'id_conflict',
        });
      }
      return status(existing);
    }

    if (byteSize > limits.maxFileBytes) {
      throw new ExecError('LIMIT', 'Файл превышает допустимый размер.', {
        maxFileBytes: limits.maxFileBytes,
      });
    }
    const [reserved] = await tx
      .select({
        attempts: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(${fileUploads.declaredSize}), 0)::int`,
      })
      .from(fileUploads)
      .innerJoin(
        fileAssets,
        and(eq(fileAssets.id, fileUploads.fileId), eq(fileAssets.graphId, fileUploads.graphId)),
      )
      .where(
        and(
          eq(fileUploads.graphId, graph),
          ne(fileUploads.state, 'ready'),
          inArray(fileAssets.state, ['staging', 'deleting']),
        ),
      );
    if (
      !reserved ||
      reserved.attempts >= MAX_PENDING_UPLOADS ||
      reserved.bytes + byteSize > MAX_PENDING_BYTES
    ) {
      throw new ExecError('LIMIT', 'Исчерпан временный бюджет загрузок графа.', {
        reason: 'upload_budget',
      });
    }

    const fileId = crypto.randomUUID();
    await tx.insert(fileAssets).values({
      graphId: graph,
      id: fileId,
      state: 'staging',
      name,
      objectKey: `originals/${graph}/${fileId}`,
    });
    const [upload] = await tx
      .insert(fileUploads)
      .values({
        graphId: graph,
        id: uploadId,
        fileId,
        ownerActor: ctx.identity.actor,
        ownerGrantId: ctx.grant?.id,
        declaredSize: byteSize,
        declaredType: mediaType,
        state: 'open',
        chunkBytes,
        expiresAt: nextExpiration(),
      })
      .onConflictDoNothing({ target: [fileUploads.graphId, fileUploads.id] })
      .returning();
    if (!upload)
      throw new ExecError('CONFLICT', 'Этот ID загрузки нельзя использовать.', {
        reason: 'id_conflict',
      });
    return status(upload);
  });
}

export function uploadStatus(ctx: FileContext, uploadId: string): Promise<UploadStatus> {
  const id = parseFileId(uploadId);
  return withFileAccess(ctx, 'read', async (tx) => status(await requireUpload(tx, ctx, id)));
}

export async function writePart(
  ctx: FileContext,
  uploadId: string,
  offset: number,
  bytes: Uint8Array,
): Promise<UploadStatus> {
  requireFileWrites();
  const id = parseFileId(uploadId);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > fileLimits().webChunkBytes
  ) {
    throw new ExecError('VALIDATION', 'Некорректная порция загрузки.');
  }
  const body = Buffer.from(bytes);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const partScope = and(
    eq(fileUploadParts.graphId, ctx.identity.graph),
    eq(fileUploadParts.uploadId, id),
    eq(fileUploadParts.offset, offset),
  );

  const reservation = await withFileAccess(ctx, 'write', async (tx) => {
    const upload = await requireUpload(tx, ctx, id, true);
    rejectClosed(upload);
    if (
      offset >= upload.declaredSize ||
      body.byteLength !== Math.min(upload.chunkBytes, upload.declaredSize - offset)
    ) {
      throw new ExecError('VALIDATION', 'Неверная длина порции загрузки.');
    }
    const [part] = await tx.select().from(fileUploadParts).where(partScope);
    if (part && (part.sha256 !== sha256 || part.byteSize !== body.byteLength)) {
      throw new ExecError('CONFLICT', 'В этом смещении зарезервированы другие байты.', {
        reason: 'part_conflict',
      });
    }
    if (part?.confirmed) return { replay: status(upload) };
    if (upload.state !== 'open' || offset !== upload.nextOffset) {
      throw new ExecError('CONFLICT', 'Запрошено неверное смещение загрузки.', {
        nextOffset: upload.nextOffset,
      });
    }
    const key = part?.objectKey ?? `parts/${ctx.identity.graph}/${id}/${offset}`;
    if (!part) {
      await tx.insert(fileUploadParts).values({
        graphId: ctx.identity.graph,
        uploadId: id,
        offset,
        byteSize: body.byteLength,
        sha256,
        objectKey: key,
      });
    }
    return { key, generation: upload.generation };
  });

  if ('replay' in reservation && reservation.replay) return reservation.replay;
  const store = ctx.store ?? getFileStore();
  try {
    await store.put(reservation.key, body);
  } catch {
    throw new Error('Не удалось сохранить порцию в хранилище.');
  }

  return withFileAccess(ctx, 'write', async (tx) => {
    const upload = await requireUpload(tx, ctx, id, true);
    rejectClosed(upload);
    const [part] = await tx.select().from(fileUploadParts).where(partScope);
    // A same-byte retry can have committed the receipt while our provider request was in flight.
    if (part?.confirmed && part.sha256 === sha256) return status(upload);
    if (
      upload.generation !== reservation.generation ||
      upload.state !== 'open' ||
      upload.nextOffset !== offset ||
      !part ||
      part.sha256 !== sha256
    ) {
      throw new ExecError('CONFLICT', 'Резервация загрузки уже закрыта.');
    }
    await tx.update(fileUploadParts).set({ confirmed: true }).where(partScope);
    const [confirmed] = await tx
      .update(fileUploads)
      .set({ nextOffset: offset + body.byteLength, expiresAt: nextExpiration() })
      .where(and(eq(fileUploads.graphId, ctx.identity.graph), eq(fileUploads.id, id)))
      .returning();
    if (!confirmed) throw new ExecError('CONFLICT', 'Не удалось подтвердить порцию загрузки.');
    return status(confirmed);
  });
}

// The SDK waits 60 s for a normal tools/call. Return a recoverable result
// before this and the per-request Bun idle deadline, while the worker continues.
const FINISH_RESPONSE_MS = 40_000;
export const FINISH_HTTP_IDLE_SECONDS = 55;
const FINISH_IO_MS = 90_000;
const finishLeaseExpiry = sql`clock_timestamp() + interval '2 minutes'`;

function within<T>(work: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error()), ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

const storageStalled = () => new Error('Превышено время ожидания Storage при сборке файла.');

async function pipeBounded(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  consume: (chunk: Uint8Array) => void | Promise<void>,
) {
  const reader = source.getReader();
  let bytes = 0;
  try {
    while (true) {
      const result = await within(reader.read(), FINISH_IO_MS, storageStalled).catch(() => {
        throw new Error('Не удалось прочитать объект из хранилища.');
      });
      if (result.done) return bytes;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) throw new ExecError('INVARIANT', 'Хранилище вернуло лишние байты.');
      await consume(result.value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function assemble(
  path: string,
  store: FileStore,
  parts: Part[],
  expected: number,
  progressed: () => Promise<void>,
): Promise<string> {
  const output = await open(path, 'wx', 0o600);
  const originalHash = createHash('sha256');
  let written = 0;
  try {
    for (const part of parts) {
      await progressed();
      const partHash = createHash('sha256');
      if (part.offset !== written || written + part.byteSize > expected) {
        throw new ExecError('INVARIANT', 'Подтверждённые порции не образуют исходный файл.');
      }
      const size = await pipeBounded(
        await within(store.read(part.objectKey), FINISH_IO_MS, storageStalled),
        part.byteSize,
        async (chunk) => {
          partHash.update(chunk);
          originalHash.update(chunk);
          for (let offset = 0; offset < chunk.length; ) {
            const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
            if (bytesWritten === 0) throw new Error('Не удалось записать временный файл.');
            offset += bytesWritten;
          }
        },
      );
      if (size !== part.byteSize || partHash.digest('hex') !== part.sha256) {
        throw new ExecError('INVARIANT', 'Контрольная сумма подтверждённой порции не совпала.');
      }
      written += size;
    }
    if (written !== expected)
      throw new ExecError('INVARIANT', 'Размер собранного файла не совпал.');
    return originalHash.digest('hex');
  } finally {
    await output.close();
  }
}

async function hasOriginal(
  store: FileStore,
  key: string,
  expectedSize: number,
  sha256: string,
): Promise<boolean> {
  const hash = createHash('sha256');
  try {
    const length = await pipeBounded(
      await within(store.read(key), FINISH_IO_MS, storageStalled),
      expectedSize,
      (bytes) => {
        hash.update(bytes);
      },
    );
    return length === expectedSize && hash.digest('hex') === sha256;
  } catch {
    return false;
  }
}

async function claimFinalization(ctx: FileContext, id: string) {
  return withFileAccess(ctx, 'write', async (tx) => {
    requireFileWrites();
    const { asset, upload } = await lockFinalization(tx, ctx, id);
    if (upload.state === 'ready') {
      if (!asset.publishedAt) rejectClosed(upload);
      return { kind: 'ready' as const, info: fileInfo(asset) };
    }
    rejectClosed(upload);
    if (upload.nextOffset !== upload.declaredSize || asset.state !== 'staging') {
      throw new ExecError('CONFLICT', 'Загрузка ещё не получила все порции.', {
        nextOffset: upload.nextOffset,
      });
    }
    const leases = and(
      eq(fileHolds.graphId, ctx.identity.graph),
      eq(fileHolds.fileId, asset.id),
      eq(fileHolds.sourceKind, 'finish'),
    );
    if (upload.state === 'finishing') {
      const [active] = await tx
        .select({ generation: fileHolds.sourceKey })
        .from(fileHolds)
        .where(
          and(
            leases,
            eq(fileHolds.sourceKey, String(upload.generation)),
            sql`${fileHolds.expiresAt} > clock_timestamp()`,
          ),
        )
        .limit(1);
      if (active) return { kind: 'waiting' as const };
    }
    await tx.delete(fileHolds).where(leases);
    const parts = await tx
      .select()
      .from(fileUploadParts)
      .where(
        and(
          eq(fileUploadParts.graphId, ctx.identity.graph),
          eq(fileUploadParts.uploadId, id),
          eq(fileUploadParts.confirmed, true),
        ),
      )
      .orderBy(asc(fileUploadParts.offset));
    const generation = upload.generation + 1;
    await tx
      .update(fileUploads)
      .set({ state: 'finishing', generation, expiresAt: nextExpiration() })
      .where(and(eq(fileUploads.graphId, ctx.identity.graph), eq(fileUploads.id, id)));
    await tx.insert(fileHolds).values({
      graphId: ctx.identity.graph,
      fileId: asset.id,
      sourceKind: 'finish',
      sourceKey: String(generation),
      expiresAt: finishLeaseExpiry,
    });
    return { kind: 'claimed' as const, asset, upload, parts, generation };
  });
}

type FinishClaim = Extract<Awaited<ReturnType<typeof claimFinalization>>, { kind: 'claimed' }>;

async function assembleClaim(ctx: FileContext, claim: FinishClaim): Promise<FileInfo> {
  const { asset, upload, parts, generation } = claim;
  const id = upload.id;
  const uploadScope = and(eq(fileUploads.graphId, ctx.identity.graph), eq(fileUploads.id, id));
  const lease = and(
    eq(fileHolds.graphId, ctx.identity.graph),
    eq(fileHolds.fileId, asset.id),
    eq(fileHolds.sourceKind, 'finish'),
    eq(fileHolds.sourceKey, String(generation)),
  );
  let lastRenewal = performance.now();
  async function renew() {
    await withFileAccess(ctx, 'write', async (tx) => {
      requireFileWrites();
      const current = await lockFinalization(tx, ctx, id);
      rejectClosed(current.upload);
      if (
        current.asset.state !== 'staging' ||
        current.upload.state !== 'finishing' ||
        current.upload.generation !== generation
      )
        throw new ExecError('CONFLICT', 'Завершение загрузки перешло к другой попытке.');
      const [retained] = await tx
        .update(fileHolds)
        .set({ expiresAt: finishLeaseExpiry })
        .where(and(lease, sql`${fileHolds.expiresAt} > clock_timestamp()`))
        .returning({ id: fileHolds.fileId });
      if (!retained)
        throw new ExecError('CONFLICT', 'Срок сборки файла истёк. Повторите завершение загрузки.');
      await tx.update(fileUploads).set({ expiresAt: nextExpiration() }).where(uploadScope);
    });
    lastRenewal = performance.now();
  }
  let directory: string | undefined;
  let published = false;
  try {
    const store = ctx.store ?? getFileStore();
    directory = await mkdtemp(join(tmpdir(), 'orbis-upload-'));
    const path = join(directory, 'original');
    const sha256 = await assemble(path, store, parts, upload.declaredSize, async () => {
      if (performance.now() - lastRenewal >= 30_000) await renew();
    });
    await renew();
    let mediaType: string;
    try {
      mediaType = await verifyMediaType(path, asset.name, upload.declaredType);
    } catch (error) {
      if (error instanceof ExecError && error.code === 'VALIDATION') {
        await withFileAccess(ctx, 'write', async (tx) => {
          await tx
            .update(fileUploads)
            .set({ state: 'failed' })
            .where(
              and(
                uploadScope,
                eq(fileUploads.generation, generation),
                eq(fileUploads.state, 'finishing'),
              ),
            );
        });
      }
      throw error;
    }

    if (
      upload.state !== 'finishing' ||
      !(await hasOriginal(store, asset.objectKey, upload.declaredSize, sha256))
    ) {
      if (performance.now() - lastRenewal >= 30_000) await renew();
      try {
        await within(
          store.put(asset.objectKey, await openAsBlob(path)),
          FINISH_IO_MS,
          storageStalled,
        );
      } catch {
        // A lost acknowledgement may have arrived after the service stored the full object.
        if (!(await hasOriginal(store, asset.objectKey, upload.declaredSize, sha256))) {
          throw new Error('Не удалось подтвердить сохранение оригинала в хранилище.');
        }
      }
    }

    const info = await withFileAccess(ctx, 'write', async (tx) => {
      requireFileWrites();
      const current = await lockFinalization(tx, ctx, id);
      if (current.upload.state === 'ready') {
        if (!current.asset.publishedAt) rejectClosed(current.upload);
        return fileInfo(current.asset);
      }
      rejectClosed(current.upload);
      if (
        current.upload.generation !== generation ||
        current.upload.state !== 'finishing' ||
        current.asset.state !== 'staging'
      ) {
        throw new ExecError('CONFLICT', 'Завершение загрузки было заменено или отменено.', {
          reason: 'upload_fenced',
        });
      }
      const expiresAt = nextExpiration();
      const [ready] = await tx
        .update(fileAssets)
        .set({
          state: 'ready',
          mediaType,
          byteSize: upload.declaredSize,
          sha256,
        })
        .where(and(eq(fileAssets.graphId, ctx.identity.graph), eq(fileAssets.id, asset.id)))
        .returning();
      if (!ready) throw new ExecError('CONFLICT', 'Не удалось подтвердить оригинал загрузки.');
      await tx.update(fileUploads).set({ state: 'ready', expiresAt }).where(uploadScope);
      await tx.insert(fileHolds).values({
        graphId: ctx.identity.graph,
        fileId: asset.id,
        sourceKind: 'upload',
        sourceKey: id,
        expiresAt,
      });
      await tx.delete(fileHolds).where(lease);
      return fileInfo(ready);
    });
    published = true;
    return info;
  } finally {
    try {
      // Provider failures release this generation immediately. If the process
      // died or lost its grant, expiry permits a later authorised takeover.
      if (!published)
        await withFileAccess(ctx, 'write', async (tx) => {
          await requireAsset(tx, ctx, asset.id, true);
          await tx.delete(fileHolds).where(lease);
        }).catch(() => {});
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}

export async function finishUpload(ctx: FileContext, uploadId: string): Promise<FileInfo> {
  requireFileWrites();
  const id = parseFileId(uploadId);
  const deadline = performance.now() + FINISH_RESPONSE_MS;
  let confirmed = false;
  const pending = () =>
    !confirmed
      ? new Error('Не удалось вовремя проверить состояние сборки файла.')
      : new ExecError('CONFLICT', 'Сборка продолжается. Повторите завершение с тем же uploadId.', {
          reason: 'upload_finishing',
          state: 'finishing',
        });
  async function waitForOriginal() {
    let backoff = 200;
    while (performance.now() < deadline) {
      const claim = await claimFinalization(ctx, id);
      if (claim.kind === 'ready') return claim.info;
      confirmed = true;
      if (claim.kind === 'claimed') return assembleClaim(ctx, claim);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 2000);
    }
    throw pending();
  }
  return within(waitForOriginal(), FINISH_RESPONSE_MS, pending);
}
