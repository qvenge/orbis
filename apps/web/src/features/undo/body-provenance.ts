import { QueryCache, type QueryClient } from '@tanstack/react-query';
import {
  diskReadOf,
  forgetNetworkObservation,
  freshnessRuntimeOf,
  networkReadReceiptOf,
  nextNetworkOrder,
  observeNetworkRead,
  type ReadPublication,
  recordDiskRead,
  sameFreshnessScope,
  shareProjectedData,
  takeDiskRead,
  takeScalarReadReceipt,
} from '../../lib/freshness/provenance';
import { isUndoEpoch } from './undo-epoch';

/** Applies to the object shown after structural sharing. */
const pendingBodies = new WeakSet<object>();
const confirmedBodies = new WeakMap<object, number>();
export function markBodyPending(doc: unknown): void {
  if (doc !== null && typeof doc === 'object') pendingBodies.add(doc);
}
export function confirmBody(doc: unknown): void {
  if (doc !== null && typeof doc === 'object') {
    pendingBodies.delete(doc);
    confirmedBodies.set(doc, nextNetworkOrder());
  }
}
export function isBodyPending(doc: unknown): boolean {
  return doc !== null && typeof doc === 'object' && pendingBodies.has(doc);
}

export function isBodyConfirmedAfter(doc: object, cutoff: number): boolean {
  return !isBodyPending(doc) && (confirmedBodies.get(doc) ?? 0) > cutoff;
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
      const staged = takeDiskRead(query, raw);
      const disk = staged ?? diskReadOf(raw);
      if (disk) {
        const initial = query.state.data;
        forgetNetworkObservation(initial);
        if (path === 'entity.get') markBodyPending(body());
        if (staged && runtime && sameFreshnessScope(staged.scope, runtime.scope)) {
          if (initial !== null && typeof initial === 'object') recordDiskRead(initial, staged);
          query.setState({ dataUpdatedAt: staged.receivedAt, isInvalidated: true });
        }
        if (runtime) {
          const read: ReadPublication = {
            ...disk,
            key: query.queryKey,
            queryHash: query.queryHash,
            raw,
          };
          runtime.acceptRead(read);
          const publication = runtime.publicationOf(query.queryHash);
          if (publication) {
            // B6 owns the disk body source. An unrelated metadata layer must not
            // mark a live ACK's shared document as pending on behalf of a disk view.
            const projected =
              publication.source === 'disk'
                ? runtime.projectMetadata(publication)
                : runtime.project(publication);
            if (projected !== raw) {
              query.setState({ data: shareProjectedData(query, projected) });
            }
            const shown = query.state.data;
            if (publication.source === 'disk' && shown !== null && typeof shown === 'object')
              recordDiskRead(shown, publication);
            if (publication.source === 'network' && runtime.isAcceptedRead(publication)) {
              observeNetworkRead(shown, publication.receipt);
              if (path === 'entity.get') confirmBody(body());
              return;
            }
          }
        }
        if (path === 'entity.get') markBodyPending(body());
        return;
      }
      if (path === 'chatThread' && query.state.fetchMeta?.fetchMore?.direction) return;
      const scalar = takeScalarReadReceipt(query, raw);
      const receipt = networkReadReceiptOf(path === 'chatThread' ? newest(raw) : raw) ?? scalar;
      if (!receipt || !isUndoEpoch(receipt.epoch)) {
        runtime?.finishOptimisticRead(query.queryHash);
        if (path === 'entity.get') markBodyPending(body());
        return;
      }
      let accepted = true;
      let bodyFromAck = false;
      let shownReceipt = receipt;
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
        const publication = runtime.publicationOf(query.queryHash);
        if (publication !== read) {
          runtime.finishOptimisticRead(query.queryHash);
          if (publication?.source === 'network' && runtime.isAcceptedRead(publication)) {
            accepted = true;
            shownReceipt = publication.receipt;
          }
        }
        const projected = publication
          ? runtime.project(publication)
          : runtime.projectBody(query.queryKey, raw);
        if (projected !== raw) {
          query.setState({ data: shareProjectedData(query, projected) });
        }
        const bodyBase = publication ? publication.raw : raw;
        bodyFromAck =
          path === 'entity.get' && runtime.projectBody(query.queryKey, bodyBase) !== bodyBase;
      }
      if (accepted) observeNetworkRead(query.state.data, shownReceipt);
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
