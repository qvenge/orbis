import type { GraphId } from '@orbis/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { fileAssets, fileHolds, fileUploadParts, fileUploads } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { identitiesForScheduler } from '../identity';
import type { FileContext } from './access';
import { type Hold, reconcileFiles } from './reconcile';
import { type FileStoreEntry, getFileStore } from './store';

type Mode = 'audit' | 'repair' | 'delete';
export function fileGcMode(): 'off' | 'audit' | 'delete' {
  const value = process.env.ORBIS_FILE_GC ?? 'off';
  if (value === 'off' || value === 'audit' || value === 'delete') return value;
  throw Error('Некорректный ORBIS_FILE_GC. Ожидается off, audit или delete.');
}

type Claim = { id: string; key: string; generation: number };
type Part = typeof fileUploadParts.$inferSelect;
const NETWORK_GRACE_MS = 60 * 60 * 1000;

async function removeReceipt(tx: Tx, graph: GraphId, hold: Hold) {
  await tx
    .delete(fileHolds)
    .where(
      and(
        eq(fileHolds.graphId, graph),
        eq(fileHolds.fileId, hold.fileId),
        eq(fileHolds.sourceKind, hold.sourceKind),
        eq(fileHolds.sourceKey, hold.sourceKey),
      ),
    );
}

async function prepare(tx: Tx, graph: GraphId, mode: Mode, objects: FileStoreEntry[]) {
  const change = mode !== 'audit';
  if (change) {
    // Block new reservations while collecting the rows we can fence. Writers
    // take the registry lock before changing definitions and hold asset locks
    // until their source and its index have both committed.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`${graph}:registry`},0))`,
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${graph}:file-uploads`},0))`,
    );
  }
  const assetQuery = tx
    .select()
    .from(fileAssets)
    .where(eq(fileAssets.graphId, graph))
    .orderBy(fileAssets.id);
  const assets = await (change ? assetQuery.for('update') : assetQuery);
  const uploadQuery = tx
    .select()
    .from(fileUploads)
    .where(eq(fileUploads.graphId, graph))
    .orderBy(fileUploads.id);
  const uploads = await (change ? uploadQuery.for('update') : uploadQuery);
  const [clock] = await tx.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`);
  if (!clock) throw Error('Недоступны часы БД.');
  const now = new Date(clock.now);
  const snapshot = await reconcileFiles(tx, graph, assets, uploads, now);
  const { missing, surplus, blocked, expired, protectedIds } = snapshot;
  const parts = await tx.select().from(fileUploadParts).where(eq(fileUploadParts.graphId, graph));
  const byOriginal = new Map(assets.map((r) => [r.objectKey, r]));
  const byUpload = new Map(uploads.map((r) => [r.id, r]));
  const byPart = new Map(parts.map((r) => [r.objectKey, r]));
  const listed = new Set(objects.map((r) => r.key));
  for (const asset of assets)
    if (asset.objectKey !== `originals/${graph}/${asset.id}`)
      blocked.push(`ключ оригинала/${asset.id}`);
  for (const part of parts)
    if (part.objectKey !== `parts/${graph}/${part.uploadId}/${part.offset}`)
      blocked.push(`ключ части/${part.uploadId}`);

  const leftovers: string[] = [],
    unowned: string[] = [];
  for (const obj of objects) {
    if ('unexpectedDirectory' in obj) {
      unowned.push(obj.key);
      continue;
    }
    if (obj.modifiedAt.getTime() + NETWORK_GRACE_MS > now.getTime()) continue;
    const asset = byOriginal.get(obj.key);
    if (asset?.state === 'deleted') {
      leftovers.push(obj.key);
      continue;
    }
    if (asset || byPart.has(obj.key)) continue;
    const path = obj.key.split('/');
    const upload =
      path[0] === 'parts' && path[1] === graph && path.length === 4 && /^\d+$/.test(path[3] ?? '')
        ? byUpload.get(path[2] ?? '')
        : undefined;
    if (upload && ['ready', 'expired', 'failed'].includes(upload.state)) leftovers.push(obj.key);
    else unowned.push(obj.key);
  }
  const claims: Claim[] = [],
    cleanParts: Part[] = [];
  const result = {
    missing,
    surplus,
    blocked,
    expired: expired.length,
    unowned,
    leftovers,
    claims,
    cleanParts,
    now,
  };
  if (mode === 'audit' || blocked.length || unowned.length) return result;
  if (mode === 'repair') {
    for (const hold of surplus) await removeReceipt(tx, graph, hold);
    for (const hold of missing) await tx.insert(fileHolds).values({ graphId: graph, ...hold });
    return result;
  }
  // Drift is visible to the operator; automatic deletion never repairs it or
  // assumes an extra index entry is safe to discard.
  if (missing.length || surplus.length) return result;
  for (const hold of expired) await removeReceipt(tx, graph, hold);
  const closing = uploads.filter(
    (r) => (r.state === 'open' || r.state === 'finishing') && r.expiresAt <= now,
  );
  if (closing.length)
    await tx
      .update(fileUploads)
      .set({ state: 'expired', generation: sql`${fileUploads.generation}+1` })
      .where(
        and(
          eq(fileUploads.graphId, graph),
          inArray(
            fileUploads.id,
            closing.map((r) => r.id),
          ),
        ),
      );
  for (const asset of assets) {
    if (asset.state === 'deleted' || protectedIds.has(asset.id)) continue;
    const closed = asset.state === 'deleting';
    const generation = closed ? asset.deleteGeneration : asset.deleteGeneration + 1;
    if (!closed)
      await tx
        .update(fileAssets)
        .set({ state: 'deleting', deleteGeneration: generation })
        .where(and(eq(fileAssets.graphId, graph), eq(fileAssets.id, asset.id)));
    claims.push({ id: asset.id, key: asset.objectKey, generation });
  }
  for (const part of parts) {
    const upload = byUpload.get(part.uploadId);
    if (!upload) throw Error('Повреждена резервация части.');
    if (upload.state === 'open' || upload.state === 'finishing') {
      if (upload.expiresAt > now) continue;
    }
    // Retain receipts until expiry so a replay of a confirmed part returns
    // the original status even after the assembled original has been published.
    if (listed.has(part.objectKey) || upload.expiresAt <= now) cleanParts.push(part);
  }
  return result;
}

// Internal maintenance only. No router, public tool or user-supplied storage key.
export async function maintainFiles(
  ctx: Pick<FileContext, 'db' | 'identity' | 'store'>,
  mode: Mode,
) {
  const graph = ctx.identity.graph;
  const store = ctx.store ?? getFileStore();
  // Listing is observational and can race writes. A key is removed only after
  // a durable, irreversible DB claim (or under an already terminal upload).
  const objects = (await store.listGraph?.(graph)) ?? [];
  const work = await withIdentity(ctx.db, ctx.identity, (tx) => prepare(tx, graph, mode, objects), {
    isolationLevel: mode === 'audit' ? 'repeatable read' : 'read committed',
  });
  const { missing, surplus, blocked, unowned, expired } = work;
  const result = {
    missing,
    surplus,
    blocked,
    unowned,
    expired,
    leftovers: work.leftovers,
    deleted: 0,
    partsRemoved: 0,
  };
  if (mode !== 'delete' || missing.length || surplus.length || blocked.length || unowned.length)
    return result;
  for (const part of work.cleanParts) {
    await store.remove(part.objectKey);
    await withIdentity(ctx.db, ctx.identity, async (tx) => {
      await tx.delete(fileUploadParts).where(
        and(
          eq(fileUploadParts.graphId, graph),
          eq(fileUploadParts.uploadId, part.uploadId),
          eq(fileUploadParts.offset, part.offset),
          eq(fileUploadParts.objectKey, part.objectKey),
          sql`EXISTS (SELECT 1 FROM file_uploads u WHERE u.graph_id=${graph} AND u.id=${part.uploadId}
        AND u.expires_at<=${work.now.toISOString()}::timestamptz AND u.state IN ('ready','expired','failed'))`,
        ),
      );
    });
    result.partsRemoved++;
  }
  for (const claim of work.claims) {
    await store.remove(claim.key);
    const updated = await withIdentity(ctx.db, ctx.identity, (tx) =>
      tx
        .update(fileAssets)
        .set({ state: 'deleted' })
        .where(
          and(
            eq(fileAssets.graphId, graph),
            eq(fileAssets.id, claim.id),
            eq(fileAssets.state, 'deleting'),
            eq(fileAssets.deleteGeneration, claim.generation),
          ),
        )
        .returning({ id: fileAssets.id }),
    );
    result.deleted += updated.length;
  }
  for (const key of work.leftovers) await store.remove(key);
  return result;
}

export async function fileMaintenanceTick(db: Db, mode: Mode, signal?: AbortSignal) {
  let failures = 0;
  for (const identity of await identitiesForScheduler(db)) {
    if (signal?.aborted) break;
    try {
      const report = await maintainFiles({ db, identity }, mode);
      const incomplete =
        report.blocked.length +
          report.unowned.length +
          report.missing.length +
          report.surplus.length >
        0;
      if (incomplete) failures++;
      if (incomplete || mode !== 'audit' || report.leftovers.length) {
        console[incomplete ? 'warn' : 'info'](
          '[files]',
          mode,
          identity.graph,
          JSON.stringify(report),
        );
      }
    } catch (error) {
      failures++;
      console.error('[files] сбой обслуживания графа', identity.graph, error);
    }
  }
  return failures;
}

export function startFileMaintenance(db: Db, mode: 'audit' | 'delete') {
  let running: Promise<unknown> | undefined;
  const controller = new AbortController();
  function tick() {
    if (running) return;
    running = fileMaintenanceTick(db, mode, controller.signal)
      .catch((error) => console.error('[files] сбой обслуживания', error))
      .finally(() => {
        running = undefined;
      });
  }
  const timer = setInterval(tick, 60 * 60 * 1000);
  tick();
  return async () => {
    clearInterval(timer);
    controller.abort();
    await running;
  };
}
