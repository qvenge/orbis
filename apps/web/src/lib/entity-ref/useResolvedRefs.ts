import { ENTITY_RESOLVE_REFS_MAX } from '@orbis/shared';
import { useCallback, useMemo, useRef } from 'react';
import { type RouterOutputs, trpc } from '../../trpc';

export type RefTitle = RouterOutputs['entity']['resolveRefs'][number];
type Result = { data?: RefTitle[]; isPending: boolean; isError: boolean; isFetching: boolean };

/** Resolve all selected IDs in bounded batches, retaining cached names through read failures. */
export function useResolvedRefs(ids: readonly string[]) {
  const utils = trpc.useUtils();
  const key = [...new Set(ids)].sort().join(',');
  const batches = useMemo(() => {
    const unique = key === '' ? [] : key.split(',');
    const result: string[][] = [];
    for (let i = 0; i < unique.length; i += ENTITY_RESOLVE_REFS_MAX)
      result.push(unique.slice(i, i + ENTITY_RESOLVE_REFS_MAX));
    return result;
  }, [key]);
  const previous = useRef<ReadonlyMap<string, RefTitle>>(new Map());
  const combine = useCallback(
    (results: Result[]) => {
      const byId = new Map<string, RefTitle>();
      const pendingIds = new Set<string>();
      const failedIds = new Set<string>();
      results.forEach((result, at) => {
        const batch = batches[at] ?? [];
        for (const row of result.data ?? []) byId.set(row.id, row);
        for (const id of batch) {
          if (result.isPending || result.isFetching) pendingIds.add(id);
          if (result.isError) failedIds.add(id);
          // New batch keys can still contain old selected IDs. Keep their last known labels
          // until a successful answer says they are absent; never infer missing from error.
          if (!byId.has(id) && (result.isPending || result.isFetching || result.isError)) {
            const old = previous.current.get(id);
            if (old) byId.set(id, old);
          }
        }
      });
      const unchanged =
        byId.size === previous.current.size &&
        [...byId].every(([id, row]) => previous.current.get(id) === row);
      if (!unchanged) previous.current = byId;
      return { byId: previous.current, pendingIds, failedIds };
    },
    [batches],
  );
  const resolved = trpc.useQueries(
    (t) => batches.map((ids) => t.entity.resolveRefs({ ids }, { staleTime: 30_000 })),
    { combine },
  );
  const retry = useCallback(() => {
    for (const ids of batches) void utils.entity.resolveRefs.invalidate({ ids });
  }, [batches, utils]);
  return { ...resolved, retry };
}
