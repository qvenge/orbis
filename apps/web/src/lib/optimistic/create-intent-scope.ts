import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { isUndoEpoch, undoEpoch } from '../../features/undo/undo-epoch';
import { freshnessRuntimeOf } from '../freshness/provenance';
import { createCreateIntentRegistry } from './create-intents';

const local = new WeakMap<
  QueryClient,
  { epoch: number; registry: ReturnType<typeof createCreateIntentRegistry> }
>();

export function createIntentsOf(client: QueryClient) {
  const runtime = freshnessRuntimeOf(client);
  if (runtime) return runtime.createIntents;
  // Isolated mounts without a freshness runtime have no graph identity or feed.
  const epoch = undoEpoch();
  const previous = local.get(client);
  if (previous?.epoch === epoch) return previous.registry;
  const scope = { accountId: '', graphId: '', epoch };
  const registry = createCreateIntentRegistry(scope, () =>
    isUndoEpoch(epoch) && !freshnessRuntimeOf(client) ? scope : undefined,
  );
  local.set(client, { epoch, registry });
  return registry;
}

export function useCreateIntents() {
  const registry = createIntentsOf(useQueryClient());
  const intents = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  return { registry, intents };
}

export function localCreateTarget(registry: ReturnType<typeof createIntentsOf>, id: string) {
  const view = registry.lookup(id);
  return view && view.status !== 'ack' ? view : undefined;
}

export function useLocalCreateTarget(id: string) {
  const registry = createIntentsOf(useQueryClient());
  return useSyncExternalStore(registry.subscribe, () => localCreateTarget(registry, id));
}

export function useReadableRecordIds(ids: readonly string[]) {
  const registry = createIntentsOf(useQueryClient());
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  return ids.filter((id) => !localCreateTarget(registry, id));
}
