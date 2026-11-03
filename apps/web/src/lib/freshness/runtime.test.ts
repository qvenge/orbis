import type { ChangePage } from '@orbis/shared';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { nextNetworkOrder } from './provenance';
import { createFreshnessRuntime } from './runtime';
import type { createFreshnessTransport } from './transport';

const scope = { accountId: 'account', graphId: 'graph', epoch: 1 };
const detail = (id: string) => [['entity', 'get'], { input: { id }, type: 'query' }] as const;
const event = (xid: number, scope: 'body' | 'other' = 'other', id = 'record'): ChangePage => ({
  watermark: String(xid + 1),
  floor: '0',
  reset: null,
  transactions: [
    {
      txId: String(xid),
      changes: [
        {
          kind: 'entity',
          rowKey: id,
          entityIds: [id],
          threadId: null,
          operation: 'update',
          scope,
          at: '2026-11-03T00:00:00.000Z',
          graphWide: false,
        },
      ],
    },
  ],
});

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const release of cleanup.splice(0)) release();
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const transport = {
    start: vi.fn<ReturnType<typeof createFreshnessTransport>['start']>(),
    stop: vi.fn(),
    reconcile: vi.fn(async () => {}),
  };
  const runtime = createFreshnessRuntime({ queryClient, transport, scope });
  cleanup.push(() => {
    runtime.dispose();
    queryClient.clear();
  });
  const watch = (key: readonly unknown[] = detail('record'), raw: unknown = {}) => {
    const queryFn = vi.fn(async () => ({}));
    queryClient.setQueryData(key, raw);
    const unsubscribe = new QueryObserver(queryClient, { queryKey: key, queryFn }).subscribe(
      () => {},
    );
    cleanup.unshift(unsubscribe);
    return queryFn;
  };
  return { runtime, queryClient, transport, watch };
}

it('coalesces in 100 ms and trails a burst at the 500 ms key limit', async () => {
  const { runtime, watch } = setup();
  const fetch = watch();
  expect(runtime.acceptChanges(scope, event(10), '10')).toBe(true);
  await vi.advanceTimersByTimeAsync(99);
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  runtime.acceptChanges(scope, event(11), '11');
  await vi.advanceTimersByTimeAsync(200);
  runtime.acceptChanges(scope, event(12), '12');
  await vi.advanceTimersByTimeAsync(299);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('holds an early body event for ACK and suppresses the exact advanced transaction', async () => {
  const { runtime, watch } = setup();
  const fetch = watch();
  const token = runtime.beginBodySave({ entityId: 'record', expectedBodyRevision: 4 });
  runtime.acceptChanges(scope, event(10, 'body'), '10');
  await vi.advanceTimersByTimeAsync(150);
  expect(fetch).not.toHaveBeenCalled();
  runtime.settleBodySave(token, { txId: '10', result: { bodyRevision: 5 } });
  await vi.advanceTimersByTimeAsync(2200);
  expect(fetch).not.toHaveBeenCalled();
  runtime.acceptChanges(scope, event(11, 'body'), '11');
  await vi.advanceTimersByTimeAsync(100);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('releases an unconfirmed candidate even if a save is still in flight', async () => {
  const { runtime, watch } = setup();
  const fetch = watch();
  runtime.beginBodySave({ entityId: 'record', expectedBodyRevision: 4 });
  runtime.acceptChanges(scope, event(10, 'body'), '10');
  await vi.advanceTimersByTimeAsync(2100);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('applies provisional and complete reset tokens independently at the same cursor', async () => {
  const { runtime, watch, queryClient } = setup();
  const fetch = watch();
  const hidden = detail('hidden');
  queryClient.setQueryData(hidden, {});
  const reset = (floor: string, phase: 'provisional' | 'complete'): ChangePage => ({
    watermark: phase === 'provisional' ? '10' : floor,
    floor,
    reset: { reason: 'floor', token: `floor:${floor}:${phase}`, phase },
    transactions: [],
  });
  runtime.acceptChanges(scope, reset('20', 'provisional'), '10');
  expect(queryClient.getQueryState(hidden)?.isInvalidated).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(fetch).toHaveBeenCalledTimes(1);
  runtime.acceptChanges(scope, reset('20', 'provisional'), '10');
  await vi.advanceTimersByTimeAsync(500);
  expect(fetch).toHaveBeenCalledTimes(1);
  runtime.acceptChanges(scope, reset('21', 'provisional'), '10');
  await vi.advanceTimersByTimeAsync(500);
  runtime.acceptChanges(scope, reset('21', 'complete'), '10');
  await vi.advanceTimersByTimeAsync(500);
  expect(fetch).toHaveBeenCalledTimes(3);
});

function publish(
  runtime: ReturnType<typeof createFreshnessRuntime>,
  queryClient: QueryClient,
  key: readonly unknown[],
  raw: unknown,
  receipt: { watermark: string; receivedAt: number },
) {
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
  if (!query) throw new Error('Missing test query');
  return runtime.acceptRead({
    key,
    queryHash: query.queryHash,
    scope,
    raw,
    source: 'network',
    receipt: { ...receipt, epoch: scope.epoch, startedSequence: nextNetworkOrder() },
  });
}

it('uses the oldest visible receipt and fires a server deadline with no feed traffic', async () => {
  const { runtime, queryClient, watch } = setup();
  const now = Date.now();
  const key = [['entity', 'query'], { input: { query: 'today' }, type: 'query' }] as const;
  const fetch = watch(key);
  const other = detail('another');
  watch(other);
  publish(
    runtime,
    queryClient,
    key,
    {
      rows: [],
      freshness: {
        entityIds: [],
        graph: true,
        bodyOrStamp: false,
        threadIds: [],
        registry: false,
        settings: false,
        expiresAt: new Date(now + 1000).toISOString(),
      },
    },
    { watermark: '10', receivedAt: now - 100 },
  );
  publish(runtime, queryClient, other, {}, { watermark: '11', receivedAt: now - 200 });
  expect(runtime.getScreen().receivedAt).toBe(now - 200);
  expect(runtime.getScreen().hasCopy).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledOnce();
});

it('invalidates a disabled observer without fetching and refreshes when shown', async () => {
  const { runtime, queryClient } = setup();
  const key = detail('record');
  queryClient.setQueryData(key, {});
  const queryFn = vi.fn(async () => ({}));
  const observer = new QueryObserver(queryClient, { queryKey: key, queryFn, enabled: false });
  cleanup.unshift(observer.subscribe(() => {}));
  runtime.acceptChanges(scope, event(10), '10');
  await vi.advanceTimersByTimeAsync(200);
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  expect(queryFn).not.toHaveBeenCalled();
  observer.setOptions({ queryKey: key, queryFn, enabled: true, staleTime: Infinity });
  await vi.advanceTimersByTimeAsync(100);
  expect(queryFn).toHaveBeenCalledOnce();
});

it('starts from confirmed settings and stops fallback when hidden, retaining accepted work', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  cleanup.push(() => visibility.mockRestore());
  const { runtime, queryClient, transport, watch } = setup();
  const settings = [['user', 'getSettings'], { type: 'query' }] as const;
  const fetch = watch();
  queryClient.setQueryData(settings, { graphEstablished: true });
  expect(transport.start).not.toHaveBeenCalled();
  publish(runtime, queryClient, detail('record'), {}, { watermark: '9', receivedAt: Date.now() });
  publish(
    runtime,
    queryClient,
    settings,
    { graphEstablished: true },
    { watermark: '10', receivedAt: Date.now() },
  );
  expect(transport.start).toHaveBeenCalledOnce();
  expect(transport.start.mock.calls[0]?.[0].getCursor()).toBe('9');
  runtime.acceptChanges(scope, event(10), '9');
  visibility.mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(6000);
  expect(transport.stop).toHaveBeenCalledOnce();
  expect(transport.reconcile).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  visibility.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(100);
  expect(fetch).toHaveBeenCalledOnce();
  expect(transport.reconcile).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5000);
  expect(transport.reconcile).toHaveBeenCalledTimes(2);
});

it('ignores a delayed future-cursor response and only lowers the current input cursor', () => {
  const { runtime } = setup();
  runtime.acceptChanges(scope, event(20), '20');
  const reset: ChangePage = {
    watermark: '10',
    floor: '0',
    transactions: [],
    reset: { reason: 'future-cursor', phase: 'complete', token: 'future-cursor:20:0:10' },
  };
  expect(runtime.acceptChanges(scope, reset, '20')).toBe(true);
  expect(runtime.acceptChanges(scope, event(21), '21')).toBe(true);
  expect(
    runtime.acceptChanges(
      scope,
      { ...reset, reset: { reason: 'future-cursor', phase: 'complete', token: 'new-token' } },
      '22',
    ),
  ).toBe(true);
  expect(runtime.acceptChanges(scope, event(10), '10')).toBe(true);
});

it('does not suppress a no-op receipt or a different event in the same transaction', async () => {
  const { runtime, watch } = setup();
  const fetch = watch();
  const noop = runtime.beginBodySave({ entityId: 'record', expectedBodyRevision: 4 });
  runtime.settleBodySave(noop, { txId: '10', result: { bodyRevision: 4 } });
  runtime.acceptChanges(scope, event(10, 'body'), '10');
  await vi.advanceTimersByTimeAsync(101);
  expect(fetch).toHaveBeenCalledTimes(1);
  const actual = runtime.beginBodySave({ entityId: 'record', expectedBodyRevision: 4 });
  runtime.settleBodySave(actual, { txId: '11', result: { bodyRevision: 5 } });
  const mixed = event(11, 'body');
  const changed = event(11).transactions[0]?.changes[0];
  if (!changed) throw new Error('Missing mixed event fixture');
  mixed.transactions[0]?.changes.push(changed);
  runtime.acceptChanges(scope, mixed, '11');
  await vi.advanceTimersByTimeAsync(510);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('failed parallel saves release only their own candidates', async () => {
  const { runtime, watch } = setup();
  const fetchA = watch();
  const fetchB = watch(detail('second'), {
    freshness: {
      entityIds: ['second'],
      graph: false,
      bodyOrStamp: false,
      threadIds: [],
      settings: false,
      registry: false,
      expiresAt: null,
    },
  });
  const a = runtime.beginBodySave({ entityId: 'record', expectedBodyRevision: 4 });
  const b = runtime.beginBodySave({ entityId: 'second', expectedBodyRevision: 2 });
  runtime.acceptChanges(scope, event(10, 'body'), '10');
  runtime.acceptChanges(scope, event(11, 'body', 'second'), '11');
  await vi.advanceTimersByTimeAsync(200);
  runtime.settleBodySave(a, { error: new Error('unknown') });
  runtime.settleBodySave(b, { txId: '11', result: { bodyRevision: 3 } });
  await vi.advanceTimersByTimeAsync(100);
  expect(fetchA).toHaveBeenCalledTimes(1);
  expect(fetchB).not.toHaveBeenCalled();
});

it('a reset fences a late body ACK from the preceding response generation', async () => {
  const { runtime, watch } = setup();
  watch();
  const saved = vi.fn();
  const resetResponses = vi.fn();
  runtime.setSinks({ acceptBody: saved, resetResponses });
  const token = runtime.beginBodySave({ entityId: 'record', expectedBodyRevision: 4 });
  runtime.acceptChanges(
    scope,
    {
      watermark: '12',
      floor: '0',
      transactions: [],
      reset: { reason: 'overflow', token: 'overflow:0:0:12', phase: 'complete' },
    },
    '0',
  );
  expect(resetResponses).toHaveBeenCalledOnce();
  runtime.settleBodySave(token, { txId: '11', result: { bodyRevision: 5 } });
  expect(saved).not.toHaveBeenCalled();
});

it('a receipt after the 30 s give-up can publish an ACK but cannot suppress later delivery', async () => {
  const { runtime, watch } = setup();
  const fetch = watch();
  const saved = vi.fn();
  runtime.setSinks({ acceptBody: saved });
  const token = runtime.beginBodySave({ entityId: 'record', expectedBodyRevision: 4 });
  await vi.advanceTimersByTimeAsync(30_000);
  runtime.settleBodySave(token, { txId: '10', result: { bodyRevision: 5 } });
  expect(saved).toHaveBeenCalledOnce();
  runtime.acceptChanges(scope, event(10, 'body'), '10');
  await vi.advanceTimersByTimeAsync(101);
  expect(fetch).toHaveBeenCalledOnce();
});

it('keeps reset and overflow cache scans bounded while marking every key synchronously', async () => {
  const { runtime, queryClient } = setup();
  const cache = queryClient.getQueryCache();
  const keys = Array.from({ length: 100 }, (_, i) => detail(`record-${i}`));
  for (const key of keys) queryClient.setQueryData(key, {});
  const getAll = vi.spyOn(cache, 'getAll');

  expect(
    runtime.acceptChanges(
      scope,
      {
        floor: '0',
        watermark: '10',
        transactions: [],
        reset: { reason: 'overflow', phase: 'complete', token: 'overflow:10' },
      },
      '0',
    ),
  ).toBe(true);
  expect(getAll).toHaveBeenCalledTimes(3);
  expect(keys.every((key) => queryClient.getQueryState(key)?.isInvalidated)).toBe(true);

  queryClient.clear();
  const fetch = vi.fn(() => new Promise(() => {}));
  for (const [index, key] of keys.entries()) {
    queryClient.setQueryData(key, {});
    if (index < 25) {
      const unsubscribe = new QueryObserver(queryClient, {
        queryKey: key,
        queryFn: fetch,
      }).subscribe(() => {});
      cleanup.unshift(unsubscribe);
    }
  }
  getAll.mockClear();
  const change = event(10).transactions[0]?.changes[0];
  if (!change) throw new Error('Expected a change fixture');
  expect(
    runtime.acceptChanges(
      scope,
      {
        floor: '0',
        watermark: '11',
        transactions: [{ txId: '10', changes: Array.from({ length: 201 }, () => change) }],
        reset: null,
      },
      '10',
    ),
  ).toBe(true);
  await vi.advanceTimersByTimeAsync(101);
  expect(getAll).toHaveBeenCalledTimes(6);
  expect(fetch).toHaveBeenCalledTimes(25);
  expect(keys.every((key) => queryClient.getQueryState(key)?.isInvalidated)).toBe(true);
  getAll.mockRestore();
});

it('retries an actual revert cancellation at the key limit and stops after a request failure', async () => {
  const { runtime, queryClient } = setup();
  const key = detail('record');
  const fetch = vi
    .fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockRejectedValueOnce(new Error('server unavailable'));
  queryClient.setQueryData(key, {});
  const unsubscribe = new QueryObserver(queryClient, { queryKey: key, queryFn: fetch }).subscribe(
    () => {},
  );
  cleanup.unshift(unsubscribe);
  runtime.acceptChanges(scope, event(10), '10');
  await vi.advanceTimersByTimeAsync(100);
  expect(fetch).toHaveBeenCalledTimes(1);
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  await vi.advanceTimersByTimeAsync(499);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('keeps an owed read if its silent replacement is then canceled with revert', async () => {
  const { runtime, queryClient } = setup();
  const key = detail('record');
  const fetch = vi
    .fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce({});
  queryClient.setQueryData(key, {});
  const unsubscribe = new QueryObserver(queryClient, { queryKey: key, queryFn: fetch }).subscribe(
    () => {},
  );
  cleanup.unshift(unsubscribe);
  runtime.acceptChanges(scope, event(10), '10');
  await vi.advanceTimersByTimeAsync(100);
  expect(fetch).toHaveBeenCalledTimes(1);
  const replacement = queryClient.refetchQueries({ queryKey: key, exact: true });
  expect(fetch).toHaveBeenCalledTimes(2);
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  await replacement;
  await vi.advanceTimersByTimeAsync(499);
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fetch).toHaveBeenCalledTimes(3);
});
