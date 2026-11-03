import type { Change } from '@orbis/shared';
import type { QueryClient } from '@tanstack/react-query';
import { afterEach } from 'vitest';
import { undoEpoch } from '../features/undo/undo-epoch';
import { bindFreshnessRuntime } from '../lib/freshness/provenance';
import { createFreshnessRuntime } from '../lib/freshness/runtime';

const cleanups = new Set<() => void>();
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
});

type DraftChange = Partial<Change> & Pick<Change, 'kind' | 'rowKey'>;
const instances = new WeakMap<QueryClient, ReturnType<typeof makeTestFreshness>>();

export function makeTestFreshness(client: QueryClient) {
  const scope = { accountId: 'owner', graphId: 'owner', epoch: undoEpoch() };
  const runtime = createFreshnessRuntime({
    queryClient: client,
    scope,
    transport: { start() {}, stop() {}, reconcile: async () => {} },
  });
  const unbind = bindFreshnessRuntime(client, runtime);
  cleanups.add(() => {
    runtime.dispose();
    unbind();
  });
  let watermark = 0;
  const instance = {
    scope,
    runtime,
    watermark: () => String(watermark),
    changes(changes: DraftChange[], txId = watermark) {
      const from = String(watermark);
      watermark = txId + 1;
      if (
        !runtime.acceptChanges(
          scope,
          {
            floor: '0',
            watermark: String(watermark),
            reset: null,
            transactions: [
              {
                txId: String(txId),
                changes: changes.map((change) => ({
                  entityIds: [change.rowKey],
                  threadId: null,
                  operation: 'update',
                  scope: 'other',
                  at: new Date().toISOString(),
                  graphWide: false,
                  ...change,
                })),
              },
            ],
          },
          from,
        )
      )
        throw new Error('Test feed page was rejected');
    },
    reset() {
      const from = String(watermark);
      watermark += 1;
      if (
        !runtime.acceptChanges(
          scope,
          {
            floor: '0',
            watermark: String(watermark),
            transactions: [],
            reset: { reason: 'overflow', phase: 'complete', token: `overflow:${watermark}` },
          },
          from,
        )
      )
        throw new Error('Test reset was rejected');
    },
  };
  instances.set(client, instance);
  return instance;
}

export function fixtureWatermarkOf(client: QueryClient): string {
  return instances.get(client)?.watermark() ?? '0';
}

export function testFreshnessOf(client: QueryClient) {
  const instance = instances.get(client);
  if (!instance) throw new Error('Use renderWithProviders with freshness enabled');
  return instance;
}
