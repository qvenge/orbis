import { useQueryClient } from '@tanstack/react-query';
import { isUndoEpoch, undoEpoch } from '../../features/undo/undo-epoch';
import { trpc } from '../../trpc';
import { useToast } from '../../ui/toast-store';
import { captureCommandScope, freshnessRuntimeOf } from '../freshness/provenance';
import { GRAPH_OFFLINE, graphFailure, graphOnline } from '../graph-command';

/** Metadata actions outside the detail/editor use the default journal Undo policy. */
export function useEntityMetadataUpdate() {
  const client = useQueryClient();
  const { show } = useToast();
  return trpc.entity.update.useMutation({
    networkMode: 'always',
    onMutate(input) {
      if (!graphOnline()) throw new Error(GRAPH_OFFLINE);
      const runtime = freshnessRuntimeOf(client);
      return {
        epoch: undoEpoch(),
        runtime,
        token: runtime?.beginOptimistic([input]),
        isCurrent: captureCommandScope(client),
      };
    },
    onSuccess(data, _input, context) {
      if (context && isUndoEpoch(context.epoch) && context.isCurrent())
        context.runtime?.settleOptimistic(context.token, { kind: 'confirmed', txId: data.txId });
    },
    onError(error, _input, context) {
      if (context && (!isUndoEpoch(context.epoch) || !context.isCurrent())) return;
      const failure = graphFailure(error);
      context?.runtime?.settleOptimistic(context.token, {
        kind: failure.kind === 'unknown' ? 'unknown' : 'failed',
      });
      show(failure.message, 'danger');
    },
  });
}
