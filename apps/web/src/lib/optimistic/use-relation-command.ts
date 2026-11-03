import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { useCallback } from 'react';
import { detailGetInput } from '../../features/entity-detail/useEntityDetail';
import { isUndoEpoch, undoEpoch } from '../../features/undo/undo-epoch';
import { trpc } from '../../trpc';
import { captureCommandScope, freshnessRuntimeOf, nextNetworkOrder } from '../freshness/provenance';
import { graphOnline, runGraphCommand } from '../graph-command';
import { networkOnlyResponse } from '../local-data/query-responses';
import type { RelationKey, RelationRow } from './adapters';
import type { OptimisticToken } from './store';

export type RelationOperation = 'create' | 'delete';

export function useRelationCommand() {
  const utils = trpc.useUtils();
  const client = useQueryClient();

  const run = useCallback(
    async (operation: RelationOperation, key: RelationKey) => {
      const epoch = undoEpoch();
      const isCurrent = captureCommandScope(client);
      const runtime = freshnessRuntimeOf(client);
      let token: OptimisticToken | undefined;
      let created: RelationRow | undefined;
      const outcome = await runGraphCommand(async () => {
        token = runtime?.beginRelation(operation, key);
        if (operation === 'delete') return utils.client.relation.delete.mutate(key);
        const result = await utils.client.relation.create.mutate(key);
        if (
          result?.sourceId === key.source_id.toLowerCase() &&
          result.targetId === key.target_id.toLowerCase() &&
          result.role === key.role
        ) {
          const { actionId: _actionId, consequences: _consequences, ...row } = result;
          created = row;
        }
        return result;
      });
      if (!isUndoEpoch(epoch) || !isCurrent()) return;
      runtime?.settleOptimistic(
        token,
        outcome.kind === 'confirmed'
          ? { kind: 'confirmed', relation: created }
          : outcome.kind === 'unknown'
            ? { kind: 'unknown' }
            : { kind: 'failed', recheck: true },
      );
      return outcome;
    },
    [client, utils],
  );

  const reconcile = useCallback(
    async (id: string, operation: RelationOperation, key: RelationKey) => {
      if (!graphOnline()) return 'unavailable';
      const epoch = undoEpoch();
      const isCurrent = captureCommandScope(client);
      const runtime = freshnessRuntimeOf(client);
      try {
        const input = detailGetInput(id);
        await utils.entity.get.cancel(input);
        if (!isUndoEpoch(epoch) || !isCurrent()) return 'unavailable';
        const started = nextNetworkOrder();
        const raw = await utils.entity.get.fetch(input, {
          staleTime: 0,
          meta: networkOnlyResponse,
        });
        if (!isUndoEpoch(epoch) || !isCurrent()) return 'unavailable';
        if (
          runtime &&
          !runtime.hasAcceptedResult(getQueryKey(trpc.entity.get, input, 'query'), raw, started)
        )
          return 'unavailable';
        if (raw?.entity?.id !== id || !Array.isArray(raw.relations)) return 'unavailable';
        const present = raw.relations.some(
          (edge) =>
            edge.sourceId === key.source_id.toLowerCase() &&
            edge.targetId === key.target_id.toLowerCase() &&
            edge.role === key.role,
        );
        return present === (operation === 'create') ? 'matches' : 'differs';
      } catch {
        return 'unavailable';
      }
    },
    [client, utils],
  );

  return { run, reconcile };
}
