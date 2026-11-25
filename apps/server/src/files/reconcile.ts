import type { GraphId } from '@orbis/shared';
import { type BodyDoc, bodyDocError, collectFileIds, upgradeBodyDoc } from '@orbis/shared/doc';
import { fileFieldEditSchema, fileIdSchema } from '@orbis/shared/files';
import { eq, sql } from 'drizzle-orm';
import {
  actionJournal,
  entities,
  entityVersions,
  type fileAssets,
  fileHolds,
  type fileUploads,
} from '../db/schema';
import type { Tx } from '../db/with-identity';
import { parsePendingRecord, rawOperations } from '../policy/pending';
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import { fileProperties, filesOfBody } from './holds';

type BodySource = { body?: unknown; bodyDoc?: unknown; bodyFormat?: unknown };
type Asset = typeof fileAssets.$inferSelect;
type Upload = typeof fileUploads.$inferSelect;
export type Hold = Pick<
  typeof fileHolds.$inferSelect,
  'fileId' | 'sourceKind' | 'sourceKey' | 'expiresAt'
>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('повреждён объект');
  return value as Record<string, unknown>;
}

function knownFormat(format: unknown) {
  if (format != null && (typeof format !== 'number' || ![1, 2, 3, 4].includes(format)))
    throw Error('неизвестная версия тела');
}

export function canonicalBodyFiles(source: BodySource): string[] {
  knownFormat(source.bodyFormat);
  if (source.bodyDoc != null) {
    const raw = object(source.bodyDoc);
    const current = upgradeBodyDoc(raw as unknown as BodyDoc);
    if (!current || bodyDocError(current)) throw Error('неизвестный или повреждённый документ');
    return collectFileIds(current);
  }
  if (source.body != null && typeof source.body !== 'string') throw Error('повреждено тело');
  return filesOfBody({ body: source.body, bodyFormat: source.bodyFormat === 4 ? 4 : null });
}

// Undo/rollback replay the inverse. Unknown operation families may restore file
// values in a representation this version cannot recognise.
const withoutFileValues = new Set([
  'relation_create',
  'relation_delete',
  'entity_origin_create',
  'entity_origin_delete',
  'entity_version_pin',
  'entity_version_delete',
  'property_create',
  'property_update',
  'property_merge',
  'aspect_delta_set',
  'aspect_delta_remove',
  'aspect_create',
  'aspect_implements_set',
  'aspect_implements_remove',
  'subscription_set',
  'subscription_remove',
  'contract_sets_delta_set',
  'contract_sets_delta_remove',
  'action_set',
  'action_remove',
  'rule_set',
  'rule_remove',
  'aspect_row_restore',
  'rule_delta_restore',
  'module_set',
  'settings_set',
  'property_row_restore',
]);

type HistoricalProperties = {
  fileKeys: Map<string, Set<string>>;
  assetIds: ReadonlySet<string>;
};

// The current registry can legitimately lose a formerly unused proposed field.
// Its creation or an inverse restoring its declaration remains in the journal.
function pastFileKeys(history: { operations: unknown; inverse: unknown }[]) {
  const keys = new Map<string, Set<string>>();
  for (const row of history)
    for (const ops of [row.operations, row.inverse]) {
      if (!Array.isArray(ops)) continue;
      for (const item of ops) {
        if (item?.op !== 'property_create' && item?.op !== 'property_row_restore') continue;
        const def = item.op === 'property_create' ? item.payload : item.payload?.row;
        if (def?.type?.kind !== 'file' || typeof def.id !== 'string') continue;
        for (const key of [def.id, def.key]) {
          if (typeof key !== 'string') continue;
          const ids = keys.get(key) ?? new Set<string>();
          ids.add(def.id);
          keys.set(key, ids);
        }
      }
    }
  return keys;
}

function propertiesOf(reg: RegistrySnapshot, props: unknown, history?: HistoricalProperties) {
  const source = object(props);
  const found = fileProperties(reg, source);
  if (!history) return found;
  for (const [key, value] of Object.entries(source)) {
    const current =
      reg.properties.get(key) ?? [...reg.properties.values()].find((def) => def.key === key);
    const past = history.fileKeys.get(key);
    if (current?.type.kind === 'file') continue;
    const values = Array.isArray(value) ? value : [value];
    if (!current && past?.size === 1) {
      const [id] = past;
      if (id)
        found.set(
          id,
          values.map((v) => fileIdSchema.parse(v)),
        );
    } else if (
      (!current || past) &&
      values.some((v) => typeof v === 'string' && history.assetIds.has(v.toLowerCase()))
    ) {
      throw Error('неоднозначное историческое свойство');
    }
  }
  return found;
}

export function canonicalOperationFiles(
  reg: RegistrySnapshot,
  value: unknown,
  format: number | null,
  history?: HistoricalProperties,
): string[] {
  knownFormat(format);
  if (!Array.isArray(value)) throw Error('повреждены операции');
  const result = new Set<string>();
  for (const row of value) {
    const { op, payload } = object(row);
    if (typeof op !== 'string') throw Error('не указана операция');
    const p = object(payload);
    if (withoutFileValues.has(op)) continue;
    if (op === 'file_field_edit') {
      const edit = fileFieldEditSchema.parse(p.edit);
      if (edit.kind === 'add' || edit.kind === 'set') result.add(edit.fileId);
      if (edit.kind === 'reorder') for (const id of edit.value) result.add(id);
    } else if (
      op === 'entity_create' ||
      op === 'entity_update' ||
      op.startsWith('attach_') ||
      op === 'entity_version_restore'
    ) {
      const props = op.startsWith('attach_') ? p.data : p.props;
      if (props != null)
        for (const ids of propertiesOf(reg, props, history).values())
          for (const id of ids) result.add(id);
      for (const id of canonicalBodyFiles({ ...p, bodyFormat: p.bodyFormatVersion ?? format }))
        result.add(id);
    } else if (op === 'property_merge_undo') {
      if (
        !Array.isArray(p.bodies) ||
        !Array.isArray(p.values) ||
        typeof p.source !== 'string' ||
        typeof p.into !== 'string'
      )
        throw Error('повреждены снимки слияния');
      for (const value of p.values) {
        const fields = { [p.source]: value.source, ...(value.hadInto && { [p.into]: value.into }) };
        for (const ids of propertiesOf(reg, fields, history).values())
          for (const id of ids) result.add(id);
      }
      for (const body of p.bodies)
        for (const id of canonicalBodyFiles(object(body))) result.add(id);
    } else if (op === 'batch_execute') {
      if (!Array.isArray(p.operations)) throw Error('повреждена пачка');
      const operations = p.operations.map((item) => ({
        op: object(item).tool,
        payload: object(item).input,
      }));
      for (const id of canonicalOperationFiles(reg, operations, format, history)) result.add(id);
    } else throw Error('неизвестная операция');
  }
  return [...result].sort();
}

const keyOf = (h: Hold) => JSON.stringify([h.sourceKind, h.sourceKey, h.fileId]);

export async function reconcileFiles(
  tx: Tx,
  graph: GraphId,
  assets: Asset[],
  uploads: Upload[],
  now: Date,
) {
  const expected = new Map<string, Hold>();
  const blocked: string[] = [];
  const protectedIds = new Set<string>();
  const byId = new Map(assets.map((row) => [row.id, row]));
  const remember = (kind: string, key: string, ids: string[], expiry: Date | null = null) => {
    for (const id of ids) {
      const fileId = fileIdSchema.parse(id);
      if (byId.get(fileId)?.state !== 'ready') throw Error('недоступная цель');
      const hold = { fileId, sourceKind: kind, sourceKey: key, expiresAt: expiry };
      expected.set(keyOf(hold), hold);
      protectedIds.add(fileId);
    }
  };
  function inspect(kind: string, id: string, read: () => void) {
    try {
      read();
    } catch {
      blocked.push(`${kind}/${id}`);
    }
  }

  const registry = await effectiveRegistry(tx, graph);
  const history = await tx
    .select({
      id: actionJournal.id,
      operations: actionJournal.operations,
      inverse: actionJournal.inverse,
      undoes: actionJournal.undoes,
      bodyFormat: actionJournal.bodyFormat,
    })
    .from(actionJournal)
    .where(eq(actionJournal.graphId, graph));
  const historic = { fileKeys: pastFileKeys(history), assetIds: new Set(byId.keys()) };
  const records = await tx
    .select({
      id: entities.id,
      props: entities.props,
      body: entities.body,
      bodyDoc: entities.bodyDoc,
      bodyFormat: entities.bodyFormat,
    })
    .from(entities)
    .where(eq(entities.graphId, graph));
  for (const row of records)
    inspect('entity', row.id, () => {
      for (const [property, ids] of propertiesOf(registry, row.props, historic))
        remember('property', `${row.id}:${property}`, ids);
      remember('body', row.id, canonicalBodyFiles(row));
    });
  const versions = await tx.select().from(entityVersions).where(eq(entityVersions.graphId, graph));
  for (const row of versions)
    inspect('version', row.id, () => remember('version', row.id, canonicalBodyFiles(row)));
  const closed = new Set(history.map((row) => row.undoes));
  for (const row of history) {
    if (row.undoes || closed.has(row.id)) continue;
    inspect('inverse', row.id, () => {
      knownFormat(row.bodyFormat);
      // New journals stamp the envelope v4 even for a v3 body restored by Undo.
      // The inverse payload marks each Markdown value written with v4 grammar.
      remember('inverse', row.id, canonicalOperationFiles(registry, row.inverse, null, historic));
    });
  }
  const pendingRows = await tx.execute<{ id: string; pending: unknown }>(sql`
    SELECT m.id, m.metadata->'pending' AS pending FROM chat_messages m
    JOIN chat_threads t ON t.id=m.thread_id AND t.graph_id=${graph}
    WHERE m.metadata ? 'pending'
      AND NOT EXISTS (SELECT 1 FROM action_journal j WHERE j.graph_id=t.graph_id AND j.id=m.id)
      AND NOT EXISTS (SELECT 1 FROM file_commands c WHERE c.graph_id=t.graph_id
        AND c.request @> jsonb_build_object('kind','unchanged_file_batch','batchId',m.id))
      AND NOT EXISTS (SELECT 1 FROM chat_messages r JOIN chat_threads rt ON rt.id=r.thread_id
        WHERE rt.graph_id=t.graph_id AND r.metadata @> jsonb_build_object('type','confirmation_rejected','rejects',m.id))
  `);
  for (const row of pendingRows)
    inspect('pending', row.id, () => {
      const pending = parsePendingRecord(row.id, row.pending);
      if (pending.id !== row.id) throw Error('не совпадает адрес карточки');
      // An Undo proposal replays the target action, already held by its inverse.
      if (pending.kind === 'question' || pending.undo_of) return;
      remember(
        'pending',
        row.id,
        canonicalOperationFiles(
          registry,
          rawOperations(pending).map((item) => ({ op: item.tool, payload: item.input })),
          pending.bodyFormatVersion ?? null,
          historic,
        ),
      );
    });

  for (const row of uploads) {
    if (row.expiresAt <= now) continue;
    if (row.state === 'open' || row.state === 'finishing') protectedIds.add(row.fileId);
    if (row.state === 'ready' && byId.get(row.fileId)?.publishedAt === null)
      inspect('upload', row.id, () => remember('upload', row.id, [row.fileId], row.expiresAt));
  }
  const actual = await tx.select().from(fileHolds).where(eq(fileHolds.graphId, graph));
  const known = new Set(['body', 'property', 'version', 'inverse', 'pending', 'upload']);
  const missing = new Map(expected);
  const surplus: Hold[] = [],
    expired: Hold[] = [];
  for (const receipt of actual) {
    const key = keyOf(receipt),
      want = expected.get(key);
    if (
      receipt.sourceKind === 'finish' &&
      (!receipt.expiresAt || !/^\d+$/.test(receipt.sourceKey))
    ) {
      blocked.push(`hold/finish/${receipt.fileId}`);
    } else if (
      receipt.sourceKind === 'read' ||
      receipt.sourceKind === 'export' ||
      receipt.sourceKind === 'finish'
    ) {
      // Lease receipts are the primary durable record of in-flight reads, exports and assemblies.
      if (receipt.expiresAt && receipt.expiresAt > now) protectedIds.add(receipt.fileId);
      else expired.push(receipt);
    } else if (!known.has(receipt.sourceKind))
      blocked.push(`hold/${receipt.sourceKind}/${receipt.sourceKey}`);
    else if (want && want.expiresAt?.getTime() === receipt.expiresAt?.getTime())
      missing.delete(key);
    else if (
      !want &&
      receipt.sourceKind === 'upload' &&
      receipt.expiresAt &&
      receipt.expiresAt <= now
    )
      expired.push(receipt);
    else surplus.push(receipt);
  }
  return { missing: [...missing.values()], surplus, blocked, expired, protectedIds };
}
