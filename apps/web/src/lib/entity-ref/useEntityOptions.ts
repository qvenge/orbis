import { bindingIndexOf, type QueryAst } from '@orbis/shared';
import { useCallback, useEffect, useState } from 'react';
import { trpc } from '../../trpc';
import type { EffectiveRegistry } from '../registry/labels';
import { refQueryAst } from './RefField';

/** Shared search for the panel; disabled with no target must never mean all records. */
export function useEntityOptions({
  target,
  term,
  exclude = [],
  enabled,
  limit = 20,
}: {
  target?: QueryAst | QueryAst[];
  term: string;
  exclude?: readonly string[];
  enabled: boolean;
  limit?: number;
}) {
  const [settled, setSettled] = useState(term.trim());
  useEffect(() => {
    const timer = setTimeout(() => setSettled(term.trim()), 200);
    return () => clearTimeout(timer);
  }, [term]);
  const ast = refQueryAst(target, settled, limit);
  const query = trpc.entity.query.useQuery({ ast }, { enabled, trpc: { abortOnUnmount: true } });
  const raw = Array.isArray(query.data) ? query.data : [];
  const waiting = term.trim() !== settled;
  const retry = useCallback(() => {
    if (enabled) void query.refetch();
  }, [enabled, query.refetch]);
  return {
    rows: enabled && !waiting ? raw.filter((row) => !exclude.includes(row.id)) : [],
    isPending: enabled && (waiting || (query.isPending && !query.isError)),
    isError: enabled && !waiting && query.isError,
    mayHaveMore: enabled && !waiting && raw.length >= limit,
    retry,
  };
}

function bindings(registry: EffectiveRegistry) {
  return bindingIndexOf({
    aspects: new Map(registry.aspects.map((a) => [a.id, a])),
    contracts: new Map(registry.contracts.map((c) => [c.id, c])),
  });
}

/** null means no implementations; callers keep the query disabled, unlike undefined/all. */
export function contractTarget(registry: EffectiveRegistry, contractId: string): QueryAst | null {
  const implementing = bindings(registry).byContract(contractId);
  return implementing.length === 0
    ? null
    : { filter: { or: implementing.map((binding) => ({ aspect: binding.aspectId })) } };
}
export function implementsContract(
  registry: EffectiveRegistry,
  aspects: readonly string[],
  contractId: string,
): boolean {
  return bindings(registry)
    .byContract(contractId)
    .some((binding) => aspects.includes(binding.aspectId));
}
