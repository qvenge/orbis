import type { BodyDoc } from '@orbis/shared/doc';
import { collectFileIds, parseBody } from '@orbis/shared/doc';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { fileAssets, fileHolds, fileUploads } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import type { RegistrySnapshot } from '../registry/load';

type BodySource = { body?: unknown; bodyDoc?: unknown; bodyFormat?: number | null };
type Access = { graphId: string; grantId?: string; approvedPendingId?: string };
export function filesOfBody(row: BodySource): string[] {
  const stored = row.bodyDoc as BodyDoc | null | undefined;
  if (stored?.v === 4 && stored.doc) return collectFileIds(stored);
  if (row.bodyFormat !== 4 || typeof row.body !== 'string' || !row.body.includes('orbis-file:'))
    return [];
  return collectFileIds(parseBody(row.body, 4));
}

export function fileProperties(
  reg: Pick<RegistrySnapshot, 'properties'>,
  props: unknown,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!props || typeof props !== 'object') return result;
  for (const [key, value] of Object.entries(props)) {
    const def = reg.properties.get(key) ?? [...reg.properties.values()].find((d) => d.key === key);
    if (def?.type.kind !== 'file') continue;
    const ids = Array.isArray(value) ? value : [value];
    if (!ids.every((id) => typeof id === 'string'))
      throw new ExecError('VALIDATION', 'Ожидался идентификатор файла.');
    result.set(
      def.id,
      ids.map((id) => id.toLowerCase()),
    );
  }
  return result;
}

export function filesOfOperations(
  reg: RegistrySnapshot,
  ops: ReadonlyArray<{ op: string; payload: unknown }>,
  format: number | null,
): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    const p = op.payload as Record<string, unknown> | null;
    if (!p) continue;
    if (op.op === 'batch_execute' && Array.isArray(p.operations)) {
      for (const id of filesOfOperations(
        reg,
        p.operations.map((x) => ({ op: x.tool, payload: x.input })),
        format,
      ))
        ids.add(id);
    } else if (op.op === 'property_merge_undo') {
      if (
        typeof p.source !== 'string' ||
        typeof p.into !== 'string' ||
        !Array.isArray(p.values) ||
        !Array.isArray(p.bodies)
      )
        throw new ExecError('VALIDATION', 'Повреждён снимок слияния свойств.');
      for (const value of p.values) {
        const previous = {
          [p.source]: value.source,
          ...(value.hadInto && { [p.into]: value.into }),
        };
        for (const files of fileProperties(reg, previous).values())
          for (const id of files) ids.add(id);
      }
      for (const body of p.bodies) for (const id of filesOfBody(body)) ids.add(id);
    } else if (op.op === 'file_field_edit') {
      const edit = p.edit as { kind?: string; fileId?: string; value?: string[] } | undefined;
      if (edit?.fileId && (edit.kind === 'add' || edit.kind === 'set')) ids.add(edit.fileId);
      if (edit?.kind === 'reorder') for (const id of edit.value ?? []) ids.add(id);
    } else if (
      op.op === 'entity_create' ||
      op.op === 'entity_update' ||
      op.op.startsWith('attach_') ||
      op.op === 'entity_version_restore'
    ) {
      for (const files of fileProperties(
        reg,
        op.op.startsWith('attach_') ? p.data : p.props,
      ).values())
        for (const id of files) ids.add(id);
      for (const id of filesOfBody({ ...p, bodyFormat: p.bodyFormatVersion === 4 ? 4 : format }))
        ids.add(id);
    }
  }
  return [...ids].sort();
}

export async function replaceFileHolds(
  tx: Tx,
  access: Access,
  sourceKind: string,
  sourceKey: string,
  oldIds: readonly string[],
  newIds: readonly string[],
  publish = false,
): Promise<void> {
  const previous = new Set(oldIds),
    next = new Set(newIds);
  const removed = [...previous].filter((id) => !next.has(id));
  const added = [...next].filter((id) => !previous.has(id));
  const locks = [...new Set([...removed, ...added])].sort();
  if (!locks.length) return;
  const assets = await tx
    .select()
    .from(fileAssets)
    .where(and(eq(fileAssets.graphId, access.graphId), inArray(fileAssets.id, locks)))
    .orderBy(fileAssets.id)
    .for('update');
  for (const id of added) {
    const asset = assets.find((row) => row.id === id);
    const unavailable = () =>
      new ExecError('NOT_FOUND', 'Файл недоступен в этом графе.', { fileId: id });
    if (asset?.state !== 'ready') throw unavailable();
    if (asset.publishedAt === null) {
      const [owned] = await tx
        .select({ id: fileUploads.id })
        .from(fileUploads)
        .innerJoin(
          fileHolds,
          and(eq(fileHolds.graphId, fileUploads.graphId), eq(fileHolds.fileId, fileUploads.fileId)),
        )
        .where(
          and(
            eq(fileUploads.graphId, access.graphId),
            eq(fileUploads.fileId, id),
            eq(fileUploads.ownerActor, sql`auth.uid()`),
            access.grantId
              ? eq(fileUploads.ownerGrantId, access.grantId)
              : isNull(fileUploads.ownerGrantId),
            eq(fileHolds.sourceKind, 'upload'),
            eq(fileHolds.sourceKey, sql`${fileUploads.id}::text`),
            sql`${fileHolds.expiresAt} > clock_timestamp()`,
          ),
        )
        .limit(1);
      if (!owned) {
        const pending =
          access.approvedPendingId &&
          (await tx
            .select()
            .from(fileHolds)
            .where(
              and(
                eq(fileHolds.graphId, access.graphId),
                eq(fileHolds.fileId, id),
                eq(fileHolds.sourceKind, 'pending'),
                eq(fileHolds.sourceKey, access.approvedPendingId),
              ),
            ));
        if (!pending || pending.length === 0) throw unavailable();
      }
      if (publish) {
        await tx
          .update(fileAssets)
          .set({ publishedAt: sql`clock_timestamp()` })
          .where(and(eq(fileAssets.graphId, access.graphId), eq(fileAssets.id, id)));
        await tx
          .delete(fileHolds)
          .where(
            and(
              eq(fileHolds.graphId, access.graphId),
              eq(fileHolds.fileId, id),
              eq(fileHolds.sourceKind, 'upload'),
            ),
          );
      }
    }
  }
  if (removed.length)
    await tx
      .delete(fileHolds)
      .where(
        and(
          eq(fileHolds.graphId, access.graphId),
          eq(fileHolds.sourceKind, sourceKind),
          eq(fileHolds.sourceKey, sourceKey),
          inArray(fileHolds.fileId, removed),
        ),
      );
  if (added.length)
    await tx
      .insert(fileHolds)
      .values(added.map((fileId) => ({ graphId: access.graphId, fileId, sourceKind, sourceKey })))
      .onConflictDoNothing();
}

async function sourceIds(tx: Tx, graph: string, kind: string, key: string) {
  const rows = await tx
    .select({ id: fileHolds.fileId })
    .from(fileHolds)
    .where(
      and(
        eq(fileHolds.graphId, graph),
        eq(fileHolds.sourceKind, kind),
        eq(fileHolds.sourceKey, key),
      ),
    );
  return rows.map((row) => row.id);
}

export async function releaseFileSource(tx: Tx, graphId: string, kind: string, key: string) {
  await replaceFileHolds(tx, { graphId }, kind, key, await sourceIds(tx, graphId, kind, key), []);
}

type HoldChange = {
  kind: string;
  key: string;
  oldIds?: readonly string[];
  newIds: readonly string[];
  publish: boolean;
};

/** All asset locks for one graph mutation are taken in UUID order, including
 * previous values, version and journal references from other operations in its batch. */
export class FileHoldChanges {
  private readonly changes: HoldChange[] = [];
  replace(
    kind: string,
    key: string,
    oldIds: readonly string[],
    newIds: readonly string[],
    publish = false,
  ) {
    if (oldIds.length || newIds.length) this.changes.push({ kind, key, oldIds, newIds, publish });
  }
  release(kind: string, key: string) {
    this.changes.push({ kind, key, newIds: [], publish: false });
  }
  async flush(tx: Tx, access: Access) {
    const locks = new Set<string>();
    for (const change of this.changes) {
      change.oldIds ??= await sourceIds(tx, access.graphId, change.kind, change.key);
      for (const id of [...change.oldIds, ...change.newIds]) locks.add(id);
    }
    if (locks.size === 0) return;
    await tx
      .select({ id: fileAssets.id })
      .from(fileAssets)
      .where(and(eq(fileAssets.graphId, access.graphId), inArray(fileAssets.id, [...locks])))
      .orderBy(fileAssets.id)
      .for('update');
    for (const change of this.changes)
      await replaceFileHolds(
        tx,
        access,
        change.kind,
        change.key,
        change.oldIds ?? [],
        change.newIds,
        change.publish,
      );
  }
}

export function mayAddressFileProperty(op: { tool: string; input: unknown }): boolean {
  const p = op.input as Record<string, unknown> | null;
  if (!p) return false;
  if (op.tool === 'batch_execute' && Array.isArray(p.operations))
    return p.operations.some(mayAddressFileProperty);
  return (
    op.tool === 'file_field_edit' ||
    op.tool.startsWith('attach_') ||
    (['entity_create', 'entity_update'].includes(op.tool) &&
      (p.props !== undefined || p.unset !== undefined))
  );
}

export async function lockFilePropertyDefinitions(tx: Tx, graphId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${graphId + ':registry'},0))`,
  );
}

/** A stored inverse or proposal can need a definition even when its last
 * value has been cleared. Only operation addresses count, not arbitrary text. */
export interface PropertyRetentionContext {
  operations?: ReadonlyArray<{ tool: string; input: unknown }>;
  undoingId?: string;
}
export async function retainedFileProperty(
  tx: Tx,
  graphId: string,
  id: string,
  key: string,
  context: PropertyRetentionContext,
) {
  type Operation = { op: string; payload: Record<string, unknown> };
  const names = [id, key];
  function uses(op: Operation): boolean {
    const p = op.payload;
    if (!p) return false;
    if (op.op === 'batch_execute' && Array.isArray(p.operations))
      return p.operations.some((inner) => uses({ op: inner.tool, payload: inner.input }));
    if (op.op === 'file_field_edit') return names.includes(String(p.propertyId));
    if (op.op === 'property_merge' || op.op === 'property_merge_undo')
      return names.includes(String(p.source)) || names.includes(String(p.into));
    if (!['entity_create', 'entity_update'].includes(op.op) && !op.op.startsWith('attach_'))
      return false;
    const values = op.op.startsWith('attach_') ? p.data : p.props;
    return names.some(
      (name) =>
        (values != null && Object.hasOwn(values, name)) ||
        (Array.isArray(p.unset) && p.unset.includes(name)),
    );
  }
  if (
    context.operations?.some(({ tool, input }) =>
      uses({ op: tool, payload: input as Record<string, unknown> }),
    )
  )
    return true;
  const rows = await tx.execute<{ ops: Operation[] }>(sql`
    SELECT j.inverse AS ops FROM action_journal j
    WHERE j.graph_id=${graphId} AND j.undoes IS NULL
      ${context.undoingId ? sql`AND j.id <> ${context.undoingId}::uuid` : sql``}
      AND (strpos(j.inverse::text,${id})>0 OR strpos(j.inverse::text,${key})>0)
      AND NOT EXISTS (SELECT 1 FROM action_journal u WHERE u.graph_id=j.graph_id AND u.undoes=j.id)
    UNION ALL
    SELECT jsonb_build_array(jsonb_build_object('op',p->'tool','payload',p->'input'))
    FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id
    CROSS JOIN LATERAL (SELECT m.metadata->'pending' AS p) candidate
    WHERE t.graph_id=${graphId} AND p ? 'input' AND NOT p ? 'undo_of'
      AND (strpos((p->'input')::text,${id})>0 OR strpos((p->'input')::text,${key})>0)
      AND NOT EXISTS (SELECT 1 FROM action_journal j WHERE j.graph_id=t.graph_id AND j.id=m.id)
      AND NOT EXISTS (SELECT 1 FROM file_commands c WHERE c.graph_id=t.graph_id
        AND c.request @> jsonb_build_object('kind','unchanged_file_batch','batchId',m.id))
      AND NOT EXISTS (SELECT 1 FROM chat_messages r JOIN chat_threads rt ON rt.id=r.thread_id
        WHERE rt.graph_id=t.graph_id AND r.metadata @> jsonb_build_object('type','confirmation_rejected','rejects',m.id))
  `);
  return rows.some((row) => row.ops.some(uses));
}
