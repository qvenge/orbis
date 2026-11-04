import { hashKey, QueryClientContext } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { useCallback, useContext } from 'react';
import { freshnessRuntimeOf } from '../../lib/freshness/provenance';
import { type RouterOutputs, trpc } from '../../trpc';
import { resetSteps } from '../entity-editor/arrows-stack';
import {
  canObservePresentedTitle,
  observeAcceptedTitle,
  observeTitleValue,
  rememberUnconfirmedTitle,
} from '../entity-editor/title-history';
import { isUndoEpoch } from '../undo/undo-epoch';
import { detailGetInput } from './detail-input';

export function useTitleHistoryBasis(id: string, current: () => boolean) {
  const client = useContext(QueryClientContext);
  const hash = hashKey(getQueryKey(trpc.entity.get, detailGetInput(id), 'query'));
  // The record screen registers this key before rendering its blocks. Standalone
  // fields without a canonical detail query retain their direct value contract.
  const runtime = client?.getQueryCache().get(hash) ? freshnessRuntimeOf(client) : undefined;
  const active = useCallback(
    () =>
      current() &&
      (!runtime ||
        (client !== undefined &&
          freshnessRuntimeOf(client) === runtime &&
          isUndoEpoch(runtime.scope.epoch) &&
          runtime.isCurrentScope())),
    [client, current, runtime],
  );
  const observe = useCallback(
    (title: string) => {
      if (!active() || (runtime && !canObservePresentedTitle(id, title))) return;
      if (observeTitleValue(id, title)) resetSteps(id);
    },
    [active, id, runtime],
  );
  const watch = useCallback(() => {
    if (!runtime || !active()) return;
    const observeRaw = () => {
      if (!active()) return;
      const read = runtime.publicationOf(hash);
      if (!read || read.source === 'optimistic') return;
      if (read.source === 'network' && !runtime.isAcceptedRead(read)) return;
      const row = (read.raw as RouterOutputs['entity']['get'] | undefined)?.entity;
      if (row?.id !== id || typeof row.title !== 'string') return;
      if (read.source === 'disk') rememberUnconfirmedTitle(id, row.title);
      else if (observeAcceptedTitle(id, row.title, read.receipt.startedSequence)) resetSteps(id);
    };
    // Subscribe after the record is pinned and its owner bound. Consume the
    // accepted raw synchronously, even if projection leaves the UI unchanged.
    const unsubscribe = runtime.subscribePublication(hash, observeRaw);
    observeRaw();
    return unsubscribe;
  }, [active, hash, id, runtime]);
  return { observe, watch };
}
