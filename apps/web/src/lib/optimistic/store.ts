import { changeXidInput } from '@orbis/shared';
import type { QueryKey } from '@tanstack/react-query';
import {
  nextNetworkOrder,
  type ReadPublication,
  sameFreshnessScope,
} from '../freshness/provenance';
import type { FreshnessScope } from '../freshness/transport';
import {
  canContainEntity,
  type EntityCardFields,
  type EntityPatch,
  entityPatchFields,
  type FieldChange,
  fieldKey,
  isEntityResponseKey,
  liveCardFields,
  projectEntityResponse,
  responseEntityRows,
  rowContainsField,
} from './adapters';

export type OptimisticToken = Readonly<{
  mutationId: string;
  entityIds: readonly string[];
  startedSequence: number;
}>;
export type OptimisticOutcome =
  | { kind: 'confirmed'; ackSequence?: number; txId?: string; suppressTitle?: boolean }
  | { kind: 'failed'; recheck?: boolean }
  | { kind: 'unknown' };

type Confirmation = { ackSequence: number; txId?: bigint };
type Layer = {
  token: OptimisticToken;
  changes: Map<string, Map<string, FieldChange>>;
  confirmed?: Confirmation;
};

type TrackedRead = {
  read: ReadPublication;
  rows: ReturnType<typeof responseEntityRows>;
  accepted: boolean;
  watermark?: bigint;
  priorAuthority?: TrackedRead;
};

type CardObservers = { revision: number; listeners: Set<() => void> };

function covers(read: TrackedRead | undefined, confirmation: Confirmation): boolean {
  if (!read?.accepted || read.read.source !== 'network') return false;
  return (
    read.read.receipt.startedSequence > confirmation.ackSequence ||
    (confirmation.txId !== undefined &&
      read.watermark !== undefined &&
      read.watermark > confirmation.txId)
  );
}

function authorityOf(read: TrackedRead | undefined): TrackedRead | undefined {
  return read?.accepted && read.read.source === 'network' ? read : read?.priorAuthority;
}

export function createOptimisticStore(scope: FreshnessScope) {
  const layers = new Map<string, Layer>();
  const byEntity = new Map<string, Set<Layer>>();
  const reads = new Map<string, TrackedRead>();
  const reading = new Map<string, QueryKey>();
  const sources = new Map<string, Set<TrackedRead>>();
  const cardObservers = new Map<string, CardObservers>();
  let resetCutoff = 0;
  let cardSequence = 0;

  function notifyCards(ids: Iterable<string>) {
    for (const id of new Set(ids)) {
      const observers = cardObservers.get(id) ?? { revision: 0, listeners: new Set<() => void>() };
      if (observers.listeners.size === 0 && !sources.has(id) && !byEntity.has(id)) {
        cardObservers.delete(id);
        continue;
      }
      observers.revision = ++cardSequence;
      cardObservers.set(id, observers);
      for (const listener of observers.listeners) listener();
    }
  }

  function removeLayer(layer: Layer) {
    layers.delete(layer.token.mutationId);
    for (const id of layer.token.entityIds) {
      const related = byEntity.get(id);
      related?.delete(layer);
      if (related?.size === 0) byEntity.delete(id);
    }
  }

  function readObligations(ids: readonly string[], layer?: Layer): Map<string, QueryKey> {
    const affected = new Map<string, QueryKey>();
    for (const [hash, tracked] of reads) {
      if (layer?.confirmed && covers(tracked, layer.confirmed)) continue;
      const relevant = ids.some((id) => {
        const row = tracked.rows.get(id);
        if (!row) return false;
        const changes = layer?.changes.get(id);
        return !changes || [...changes.values()].some((change) => rowContainsField(row, change));
      });
      if (relevant) affected.set(hash, tracked.read.key);
    }
    for (const [hash, key] of reading) {
      if (
        ids.some((id) => {
          const changes = layer?.changes.get(id);
          return changes?.size !== 0 && canContainEntity(key, id, changes);
        })
      )
        affected.set(hash, key);
    }
    return affected;
  }

  function hidesEarlierChange(layer: Layer): boolean {
    for (const [id, fields] of layer.changes) {
      for (const earlier of byEntity.get(id) ?? []) {
        if (earlier === layer) break;
        const previous = earlier.changes.get(id);
        if (previous && [...fields.keys()].some((field) => previous.has(field))) return true;
      }
    }
    return false;
  }

  function prune(): string[] {
    const changed: string[] = [];
    // Oldest first. A covered B still shields a same-field A while A has an obligation.
    for (const layer of layers.values()) {
      if (
        layer.confirmed &&
        !hidesEarlierChange(layer) &&
        readObligations(layer.token.entityIds, layer).size === 0
      ) {
        removeLayer(layer);
        changed.push(...layer.token.entityIds);
      }
    }
    return changed;
  }

  function selectFields(
    id: string,
    covered: (confirmation: Confirmation, field: FieldChange) => boolean,
  ): FieldChange[] {
    const winners = new Map<string, { field: FieldChange; confirmation?: Confirmation }>();
    for (const layer of byEntity.get(id) ?? []) {
      for (const [key, field] of layer.changes.get(id) ?? []) {
        winners.delete(key);
        winners.set(key, {
          field,
          ...(layer.confirmed ? { confirmation: layer.confirmed } : {}),
        });
      }
    }
    return [...winners.values()].flatMap(({ field, confirmation }) =>
      confirmation && covered(confirmation, field) ? [] : [field],
    );
  }

  function unindex(tracked: TrackedRead | undefined) {
    if (!tracked) return;
    for (const id of tracked.rows.keys()) {
      const references = sources.get(id);
      references?.delete(tracked);
      if (references?.size === 0) sources.delete(id);
    }
  }

  function index(tracked: TrackedRead) {
    if (!tracked.accepted || tracked.read.source !== 'network') return;
    for (const id of tracked.rows.keys()) {
      const references = sources.get(id) ?? new Set<TrackedRead>();
      references.add(tracked);
      sources.set(id, references);
    }
  }

  function usable(read: ReadPublication): boolean {
    return (
      sameFreshnessScope(scope, read.scope) &&
      (read.source !== 'network' ||
        (read.receipt.epoch === scope.epoch && read.receipt.startedSequence > resetCutoff))
    );
  }

  return {
    beginOptimistic(
      operationScope: FreshnessScope,
      mutationId: string,
      patches: readonly EntityPatch[],
      startedSequence = nextNetworkOrder(),
    ): OptimisticToken | undefined {
      if (!sameFreshnessScope(scope, operationScope) || layers.has(mutationId)) return;
      const changes = new Map<string, Map<string, FieldChange>>();
      for (const patch of patches) {
        const fields = entityPatchFields(patch);
        if (!fields.length) continue;
        const target = changes.get(patch.id) ?? new Map<string, FieldChange>();
        for (const field of fields) {
          const key = fieldKey(field);
          target.delete(key);
          target.set(key, field);
        }
        changes.set(patch.id, target);
      }
      if (changes.size === 0) return;
      const token: OptimisticToken = Object.freeze({
        mutationId,
        startedSequence,
        entityIds: Object.freeze([...changes.keys()]),
      });
      const layer = { token, changes };
      layers.set(mutationId, layer);
      for (const id of changes.keys()) {
        const related = byEntity.get(id) ?? new Set<Layer>();
        related.add(layer);
        byEntity.set(id, related);
      }
      notifyCards(token.entityIds);
      return token;
    },

    /** Returns the keys that still need a confirmed read, for the existing freshness scheduler. */
    settleOptimistic(token: OptimisticToken | undefined, outcome: OptimisticOutcome): QueryKey[] {
      if (!token) return [];
      const layer = layers.get(token.mutationId);
      if (layer?.token !== token || layer.confirmed) return [];
      let refresh: QueryKey[] = [];
      if (outcome.kind === 'confirmed') {
        const tx = changeXidInput.safeParse(outcome.txId);
        layer.confirmed = {
          ackSequence: outcome.ackSequence ?? nextNetworkOrder(),
          ...(tx.success ? { txId: BigInt(tx.data) } : {}),
        };
        refresh = [...readObligations(token.entityIds, layer).values()];
        if (outcome.suppressTitle) {
          for (const fields of layer.changes.values()) fields.delete('title');
          if ([...layer.changes.values()].every((fields) => fields.size === 0)) removeLayer(layer);
        }
      } else {
        if (outcome.kind === 'unknown' || outcome.recheck)
          refresh = [...readObligations(token.entityIds, layer).values()];
        removeLayer(layer);
      }
      notifyCards([...token.entityIds, ...prune()]);
      return refresh;
    },

    /** Explicitly accepting a newly read title retires only prior local title intents. */
    acceptTitle(id: string, beforeSequence: number): void {
      for (const layer of byEntity.get(id) ?? []) {
        if (layer.token.startedSequence >= beforeSequence) continue;
        layer.changes.get(id)?.delete('title');
        if ([...layer.changes.values()].every((fields) => fields.size === 0)) removeLayer(layer);
      }
      notifyCards([id, ...prune()]);
    },

    /** Raw only. A stale publication can be projected, but cannot rebase layers or supply live card data. */
    acceptResponse(read: ReadPublication, accepted = true): void {
      if (!usable(read) || read.source === 'optimistic') return;
      const old = reads.get(read.queryHash);
      if (old?.read === read && old.accepted === accepted) return;
      if (
        old?.read.source === 'network' &&
        (read.source === 'disk' || old.read.receipt.startedSequence > read.receipt.startedSequence)
      )
        return;
      const watermark = changeXidInput.safeParse(
        read.source === 'network' ? read.receipt.watermark : null,
      );
      const previousAuthority = authorityOf(old);
      const priorAuthority = !accepted ? previousAuthority : undefined;
      const tracked: TrackedRead = {
        read,
        rows: responseEntityRows(read.key, read.raw),
        accepted,
        ...(watermark.success ? { watermark: BigInt(watermark.data) } : {}),
        ...(priorAuthority ? { priorAuthority } : {}),
      };
      const wasReading = reading.delete(read.queryHash);
      if (!old && !wasReading && tracked.rows.size === 0) return;
      if (accepted) {
        unindex(previousAuthority);
        index(tracked);
      }
      if (tracked.rows.size > 0 || priorAuthority) reads.set(read.queryHash, tracked);
      else reads.delete(read.queryHash);
      notifyCards([...(previousAuthority?.rows.keys() ?? []), ...tracked.rows.keys(), ...prune()]);
    },

    /** Dynamic results can first include a record even when this key already has a base. */
    watchResponse(queryHash: string, key: QueryKey): boolean {
      if (!isEntityResponseKey(key)) return false;
      reading.set(queryHash, key);
      return true;
    },

    finishRead(queryHash: string): void {
      if (reading.delete(queryHash)) notifyCards(prune());
    },

    needsRebase(hash: string): boolean {
      const tracked = reads.get(hash);
      if (!tracked) return false;
      for (const [id, row] of tracked.rows) {
        for (const layer of byEntity.get(id) ?? []) {
          if (!layer.confirmed || covers(tracked, layer.confirmed)) continue;
          if (
            [...(layer.changes.get(id)?.values() ?? [])].some((field) =>
              rowContainsField(row, field),
            )
          )
            return true;
        }
      }
      return false;
    },

    affectedResponses(ids: readonly string[]): ReadonlyMap<string, QueryKey> {
      return readObligations(ids);
    },

    forgetResponse(queryHash: string): void {
      reading.delete(queryHash);
      const tracked = reads.get(queryHash);
      reads.delete(queryHash);
      const authority = authorityOf(tracked);
      unindex(authority);
      notifyCards([...(authority?.rows.keys() ?? []), ...prune()]);
    },

    projectResponse(read: ReadPublication, shown = read.raw): unknown {
      if (layers.size === 0) return shown;
      const tracked = reads.get(read.queryHash);
      const basis = tracked?.read === read ? tracked : undefined;
      if (!basis && !usable(read)) return shown;
      return projectEntityResponse(read.key, shown, (id) =>
        selectFields(id, (confirmation) => covers(basis, confirmation)),
      );
    },

    /** Chat payloads are historical. Only the card renderer consumes this separate view. */
    projectCard<T extends EntityCardFields>(card: T, actionSummary = false): T {
      if (actionSummary) return card;
      const references = [...(sources.get(card.entityId) ?? [])].sort((a, b) => {
        const aStart = a.read.source === 'network' ? a.read.receipt.startedSequence : 0;
        const bStart = b.read.source === 'network' ? b.read.receipt.startedSequence : 0;
        return bStart - aStart;
      });
      const source: { title?: unknown; aspects?: unknown; props?: unknown } = {};
      const evidence = new Map<string, TrackedRead>();
      for (const tracked of references) {
        const row = tracked.rows.get(card.entityId);
        if (!row) continue;
        for (const field of ['title', 'aspects', 'props'] as const) {
          if (!evidence.has(field) && Object.hasOwn(row, field)) {
            source[field] = row[field];
            evidence.set(field, tracked);
          }
        }
      }
      return liveCardFields(
        card,
        source,
        selectFields(card.entityId, (confirmation, change) => {
          const field =
            change.kind === 'prop' ? 'props' : change.kind === 'aspect' ? 'aspects' : change.kind;
          return covers(evidence.get(field), confirmation);
        }),
      );
    },

    subscribeCard(id: string, listener: () => void): () => void {
      const observers = cardObservers.get(id) ?? { revision: 0, listeners: new Set<() => void>() };
      observers.listeners.add(listener);
      cardObservers.set(id, observers);
      return () => {
        observers.listeners.delete(listener);
        if (observers.listeners.size === 0 && !sources.has(id) && !byEntity.has(id))
          cardObservers.delete(id);
      };
    },

    cardRevision: (id: string) => cardObservers.get(id)?.revision ?? 0,

    reset(startedSequenceCutoff = resetCutoff, retainBases = false): Iterable<string> {
      const affected = readObligations([...byEntity.keys()]);
      resetCutoff = Math.max(startedSequenceCutoff, resetCutoff);
      layers.clear();
      byEntity.clear();
      if (retainBases) {
        // Visible cache can keep its old rows while it reconciles. They are display bases
        // only, without the evidence or card authority of the retired feed generation.
        for (const [hash, { read, rows }] of reads)
          reads.set(hash, { read, rows, accepted: false });
      } else {
        reads.clear();
      }
      reading.clear();
      sources.clear();
      notifyCards(cardObservers.keys());
      return affected.keys();
    },
  };
}
