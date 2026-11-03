import { QueryCache, type QueryClient } from '@tanstack/react-query';
import {
  diskReadOf,
  forgetNetworkObservation,
  freshnessRuntimeOf,
  networkReadReceiptOf,
  observeNetworkRead,
  type ReadPublication,
  takeScalarReadReceipt,
} from '../../lib/freshness/provenance';
import { isUndoEpoch } from './undo-epoch';

/** Applies to the object shown after structural sharing. */
const pendingBodies = new WeakSet<object>();
export function markBodyPending(doc: unknown): void {
  if (doc !== null && typeof doc === 'object') pendingBodies.add(doc);
}
export function confirmBody(doc: unknown): void {
  if (doc !== null && typeof doc === 'object') pendingBodies.delete(doc);
}
export function isBodyPending(doc: unknown): boolean {
  return doc !== null && typeof doc === 'object' && pendingBodies.has(doc);
}

function newest(raw: unknown): unknown {
  return (raw as { pages?: unknown[] } | null)?.pages?.[0];
}

export function makeBodyQueryCache(clientOf: () => QueryClient): QueryCache {
  return new QueryCache({
    onSuccess(raw, query) {
      const client = clientOf();
      const runtime = freshnessRuntimeOf(client);
      const [prefix] = query.queryKey;
      const path = Array.isArray(prefix) ? prefix.join('.') : prefix;
      const body = () =>
        (query.state.data as { entity?: { bodyDoc?: unknown } } | undefined)?.entity?.bodyDoc;
      const disk = diskReadOf(raw);
      if (disk) {
        forgetNetworkObservation(query.state.data);
        if (path === 'entity.get') markBodyPending(body());
        runtime?.acceptRead({ ...disk, key: query.queryKey, queryHash: query.queryHash, raw });
        return;
      }
      const scalar = takeScalarReadReceipt(query, raw);
      const receipt = networkReadReceiptOf(path === 'chatThread' ? newest(raw) : raw) ?? scalar;
      if (!receipt || !isUndoEpoch(receipt.epoch)) {
        if (path === 'entity.get') markBodyPending(body());
        return;
      }
      let accepted = true;
      let bodyFromAck = false;
      if (runtime) {
        const previous = runtime.publicationOf(query.queryHash);
        // Fetching older chat pages reuses the existing newest page and its time.
        if (
          path === 'chatThread' &&
          previous?.source === 'network' &&
          receipt.startedSequence === previous.receipt.startedSequence
        )
          return;
        const read: ReadPublication = {
          key: query.queryKey,
          queryHash: query.queryHash,
          scope: runtime.scope,
          raw,
          source: 'network',
          receipt,
        };
        accepted = runtime.acceptRead(read);
        const projected = accepted
          ? runtime.project(read)
          : runtime.projectBody(query.queryKey, raw);
        if (projected !== raw) {
          const stale = query.state.isInvalidated;
          query.setData(projected, { updatedAt: query.state.dataUpdatedAt, manual: true });
          if (stale) query.invalidate();
        }
        bodyFromAck = path === 'entity.get' && runtime.projectBody(query.queryKey, raw) !== raw;
      }
      if (accepted) observeNetworkRead(query.state.data, receipt);
      else forgetNetworkObservation(query.state.data);
      if (path === 'entity.get') {
        if (accepted || bodyFromAck) confirmBody(body());
        else markBodyPending(body());
      }
    },
    onError(error, query) {
      const [prefix, params] = query.queryKey;
      if (!Array.isArray(prefix) || prefix.join('.') !== 'entity.get') return;
      const id = (params as { input?: { id?: string } } | undefined)?.input?.id;
      const code = (error as { data?: { code?: string } })?.data?.code;
      const runtime = freshnessRuntimeOf(clientOf());
      if (runtime && id && code === 'NOT_FOUND') runtime.confirmedMissing(id, error);
    },
  });
}
