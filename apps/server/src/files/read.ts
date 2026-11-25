import { FILE_LIST_LIMIT, type FileInfo } from '@orbis/shared/files';
import { and, eq, exists, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { fileAssets, fileHolds, fileUploads } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { type FileContext, ownedAttempt, parseFileId, withFileAccess } from './access';
import { getFileStore } from './store';

const READ_LEASE_REFRESH_MS = 30_000;
const READ_IDLE_LIMIT_MS = 120_000;
const readLeaseExpiry = sql`clock_timestamp() + interval '2 minutes'`;

function readableFiles(tx: Tx, ctx: FileContext, ids: string[]) {
  const owner = tx
    .select({ id: fileUploads.id })
    .from(fileUploads)
    .where(
      and(
        ownedAttempt(ctx),
        eq(fileUploads.fileId, fileAssets.id),
        eq(fileUploads.state, 'ready'),
        sql`${fileUploads.expiresAt} > clock_timestamp()`,
      ),
    );
  return and(
    eq(fileAssets.graphId, ctx.identity.graph),
    inArray(fileAssets.id, ids),
    eq(fileAssets.state, 'ready'),
    or(isNotNull(fileAssets.publishedAt), exists(owner)),
  );
}

function asInfo(asset: typeof fileAssets.$inferSelect): FileInfo {
  if (asset.mediaType === null || asset.byteSize === null || asset.sha256 === null) {
    throw new ExecError('INVARIANT', 'Оригинал файла не имеет подтверждённых атрибутов.');
  }
  return {
    id: asset.id,
    name: asset.name,
    mediaType: asset.mediaType,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
  };
}

export function describeFiles(ctx: FileContext, ids: readonly string[]): Promise<FileInfo[]> {
  if (ids.length > FILE_LIST_LIMIT)
    throw new ExecError('LIMIT', 'Слишком много запрошенных файлов.');
  const requested = ids.map(parseFileId);
  if (new Set(requested).size !== requested.length) {
    throw new ExecError('VALIDATION', 'Повторяющийся ID файла.');
  }

  return withFileAccess(ctx, 'read', async (tx) => {
    if (requested.length === 0) return [];
    const assets = await tx
      .select()
      .from(fileAssets)
      .where(readableFiles(tx, ctx, requested));
    const infos = new Map(assets.map((asset) => [asset.id, asInfo(asset)]));
    return requested.flatMap((id) => {
      const info = infos.get(id);
      return info ? [info] : [];
    });
  });
}

async function leasedStream(
  ctx: FileContext,
  fileId: string,
  sourceKey: string,
  expected: number,
  open: () => Promise<ReadableStream<Uint8Array>>,
): Promise<ReadableStream<Uint8Array>> {
  const lease = and(
    eq(fileHolds.graphId, ctx.identity.graph),
    eq(fileHolds.fileId, fileId),
    eq(fileHolds.sourceKind, 'read'),
    eq(fileHolds.sourceKey, sourceKey),
  );
  let lastProgress = Date.now();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed: Promise<unknown> | undefined;
  let failure: Error | undefined;
  let renewing = false;
  const release = () => {
    clearInterval(heartbeat);
    // If the connection or graph access disappeared, the database lease will expire on its own.
    closed ??= withIdentity(ctx.db, ctx.identity, async (tx) => {
      await tx
        .select({ id: fileAssets.id })
        .from(fileAssets)
        .where(and(eq(fileAssets.graphId, ctx.identity.graph), eq(fileAssets.id, fileId)))
        .for('update');
      await tx.delete(fileHolds).where(lease);
    }).catch(() => {});
    return closed;
  };
  const stop = (error: Error) => {
    if (closed) return;
    failure = error;
    output?.error(error);
    void reader?.cancel(error).catch(() => {});
    void release();
  };
  const renew = () =>
    withFileAccess(ctx, 'read', async (tx) => {
      const [asset] = await tx
        .select({ id: fileAssets.id })
        .from(fileAssets)
        .where(
          and(
            eq(fileAssets.graphId, ctx.identity.graph),
            eq(fileAssets.id, fileId),
            eq(fileAssets.state, 'ready'),
          ),
        )
        .for('update');
      if (!asset) return false;
      const [retained] = await tx
        .update(fileHolds)
        .set({ expiresAt: readLeaseExpiry })
        .where(and(lease, sql`${fileHolds.expiresAt} > clock_timestamp()`))
        .returning({ fileId: fileHolds.fileId });
      return retained !== undefined;
    });
  const heartbeat = setInterval(() => {
    if (Date.now() - lastProgress >= READ_IDLE_LIMIT_MS) {
      stop(new Error('Время ожидания чтения файла истекло.'));
      return;
    }
    if (renewing) return;
    renewing = true;
    void renew()
      .then((active) => {
        if (!active) stop(new Error('Удержание для чтения файла истекло.'));
      })
      .catch(() => stop(new Error('Не удалось продлить удержание для чтения файла.')))
      .finally(() => {
        renewing = false;
      });
  }, READ_LEASE_REFRESH_MS);
  heartbeat.unref();

  try {
    reader = (await open()).getReader();
    if (failure) {
      await reader.cancel(failure).catch(() => {});
      throw failure;
    }
    const upstream = reader;
    let bytes = 0;
    return new ReadableStream(
      {
        start(controller) {
          output = controller;
        },
        async pull(controller) {
          try {
            const chunk = await upstream.read();
            if (closed) return;
            if (chunk.done) {
              if (bytes !== expected) throw new Error('Хранилище вернуло неполный файл.');
              await release();
              controller.close();
              return;
            }
            bytes += chunk.value.byteLength;
            if (bytes > expected) throw new Error('Хранилище вернуло лишние байты.');
            lastProgress = Date.now();
            controller.enqueue(chunk.value);
          } catch {
            stop(new Error('Не удалось прочитать файл из хранилища.'));
            await release();
          }
        },
        async cancel(reason) {
          // Start upstream cancellation before releasing the hold, which can allow GC to delete the object.
          const cancelled = upstream.cancel(reason);
          await release();
          await cancelled;
        },
      },
      { highWaterMark: 0 },
    );
  } catch {
    await release();
    throw failure ?? new Error('Не удалось открыть файл в хранилище.');
  }
}

export async function readRange(
  ctx: FileContext,
  fileId: string,
  offset?: number,
  length?: number,
): Promise<{ info: FileInfo; stream: ReadableStream<Uint8Array>; length: number }> {
  const id = parseFileId(fileId);
  const start = offset ?? 0;
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    (length !== undefined && (!Number.isSafeInteger(length) || length < 1))
  ) {
    throw new ExecError('VALIDATION', 'Некорректный диапазон файла.');
  }

  const sourceKey = crypto.randomUUID();
  const { info, key, count } = await withFileAccess(ctx, 'read', async (tx) => {
    const [asset] = await tx
      .select()
      .from(fileAssets)
      .where(readableFiles(tx, ctx, [id]))
      .for('update');
    if (!asset) throw new ExecError('NOT_FOUND', 'Оригинал файла недоступен.');
    const info = asInfo(asset);
    if (start > info.byteSize) {
      throw new ExecError('VALIDATION', 'Диапазон находится за пределами файла.', {
        reason: 'range_not_satisfiable',
        byteSize: info.byteSize,
      });
    }
    const remaining = info.byteSize - start;
    const count = Math.min(remaining, length ?? remaining);
    if (count > 0) {
      await tx.insert(fileHolds).values({
        graphId: ctx.identity.graph,
        fileId: id,
        sourceKind: 'read',
        sourceKey,
        expiresAt: readLeaseExpiry,
      });
    }
    return { info, key: asset.objectKey, count };
  });

  const stream =
    count === 0
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        })
      : await leasedStream(ctx, id, sourceKey, count, () => {
          const store = ctx.store ?? getFileStore();
          const range =
            offset === undefined && length === undefined
              ? undefined
              : { offset: start, length: count };
          return store.read(key, range);
        });
  return { info, stream, length: count };
}
