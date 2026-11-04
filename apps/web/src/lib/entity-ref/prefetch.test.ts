import { initialModel } from '@orbis/shared/nav';
import { QueryObserver } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { warmDetailScreen } from '../../app/detail-screen-loader';
import { detailGetInput as observerInput } from '../../features/entity-detail/useEntityDetail';
import { resetUndoSession } from '../../features/undo/undo-epoch';
import { HOST_HOME, useNav } from '../../state/navigation';
import { makeTestFreshness } from '../../test/freshness';
import { makeQueryClient, trpc } from '../../trpc';
import { nextNetworkOrder, recordNetworkReadReceipt } from '../freshness/provenance';
import { claimRecordPrefetch, prefetchRecord, type RecordRead } from './prefetch';

const first = '018cd857-511b-7f25-870e-377777ceca00';
const second = '018cd857-511b-7f25-870e-377777ceca01';
const keyOf = (id: string) => getQueryKey(trpc.entity.get, observerInput(id), 'query');
vi.mock('../../app/detail-screen-loader', () => ({ warmDetailScreen: vi.fn() }));

beforeEach(() => {
  useNav.setState({ model: initialModel(HOST_HOME), overlay: null });
  vi.useFakeTimers();
  vi.mocked(warmDetailScreen).mockClear();
});
afterEach(() => vi.useRealTimers());

function setup() {
  const client = makeQueryClient();
  const { scope, runtime, reset } = makeTestFreshness(client);
  const read = vi.fn<RecordRead>(() => new Promise(() => {}));
  return { client, read, scope, runtime, reset };
}

test('hover waits 100 ms and leaving before intent starts no work', () => {
  const { client, read } = setup();
  const leave = prefetchRecord(client, read, first, 'hover');
  vi.advanceTimersByTime(99);
  leave();
  vi.advanceTimersByTime(100);
  expect(read).not.toHaveBeenCalled();
  expect(warmDetailScreen).not.toHaveBeenCalled();
  prefetchRecord(client, read, first, 'hover');
  vi.advanceTimersByTime(100);
  expect(read.mock.calls[0]?.[0]).toEqual(observerInput(first));
  expect(warmDetailScreen).toHaveBeenCalledTimes(1);
});

test('focus starts immediately and same-target gestures share their fetch', () => {
  const { client, read } = setup();
  const hoverLeave = prefetchRecord(client, read, first, 'hover');
  const blur = prefetchRecord(client, read, first, 'focus');
  expect(read).toHaveBeenCalledTimes(1);
  const signal = read.mock.calls[0]?.[1];
  hoverLeave();
  expect(signal?.aborted).toBe(false);
  blur();
  expect(signal?.aborted).toBe(true);
});

test('new intent cancels old speculative work and its cleanup cannot cancel the new work', () => {
  const { client, read } = setup();
  const leave = prefetchRecord(client, read, first, 'touch');
  const blur = prefetchRecord(client, read, second, 'selection');
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[0]?.[1].aborted).toBe(true);
  leave();
  expect(read.mock.calls[1]?.[1].aborted).toBe(false);
  blur();
  expect(read.mock.calls[1]?.[1].aborted).toBe(true);
});

test('navigation adopts in-flight work before lazy screen creates an observer', () => {
  const { client, read } = setup();
  const leave = prefetchRecord(client, read, first, 'focus');
  useNav.getState().openRecord(first);
  claimRecordPrefetch(client, first);
  useNav.setState({ model: initialModel(HOST_HOME), overlay: null });
  leave();
  prefetchRecord(client, read, second, 'focus');
  expect(read.mock.calls[0]?.[1].aborted).toBe(false);
  expect(client.getQueryState(keyOf(first))?.fetchStatus).toBe('fetching');
});

test('an existing fetch and a mounted observer keep their own work', () => {
  const { client, read } = setup();
  const key = keyOf(first);
  const outside = vi.fn(({ signal }: { signal: AbortSignal }) => {
    expect(signal.aborted).toBe(false);
    return new Promise(() => {});
  });
  void client.fetchQuery({ queryKey: key, queryFn: outside });
  prefetchRecord(client, read, first, 'focus')();
  expect(read).not.toHaveBeenCalled();
  expect(client.getQueryState(key)?.fetchStatus).toBe('fetching');

  const leave = prefetchRecord(client, read, second, 'focus');
  const observer = new QueryObserver(client, {
    queryKey: keyOf(second),
    queryFn: outside,
  });
  const detach = observer.subscribe(() => {});
  leave();
  expect(read.mock.calls[0]?.[1].aborted).toBe(false);
  expect(outside).toHaveBeenCalledTimes(1);
  detach();
});

test('confirmed raw detail is reusable; reset invalidates it for the next intent', async () => {
  const { client, read, scope, runtime, reset } = setup();
  const raw = { entity: { id: first } } as Awaited<ReturnType<RecordRead>>;
  read.mockImplementationOnce(async () => {
    recordNetworkReadReceipt(raw, {
      epoch: scope.epoch,
      receivedAt: Date.now(),
      watermark: '0',
      startedSequence: nextNetworkOrder(),
    });
    return raw;
  });
  prefetchRecord(client, read, first, 'focus');
  await vi.advanceTimersByTimeAsync(0);
  const query = client.getQueryCache().find({ queryKey: keyOf(first), exact: true });
  expect(query).toBeDefined();
  expect(runtime.publicationOf(query?.queryHash ?? '')?.raw).toBe(raw);
  prefetchRecord(client, read, first, 'focus');
  expect(read).toHaveBeenCalledTimes(1);
  reset();
  prefetchRecord(client, read, first, 'focus');
  expect(read).toHaveBeenCalledTimes(2);
});

test('unconfirmed data with a recent cache timestamp still needs a read', () => {
  const { client, read } = setup();
  client.setQueryData(keyOf(first), { entity: { id: first } });
  prefetchRecord(client, read, first, 'selection');
  expect(read).toHaveBeenCalledTimes(1);
});

test('old scope cannot start after a session change during the hover timer', () => {
  const { client, read } = setup();
  prefetchRecord(client, read, first, 'hover');
  resetUndoSession();
  vi.advanceTimersByTime(100);
  expect(read).not.toHaveBeenCalled();
  expect(warmDetailScreen).not.toHaveBeenCalled();
});

test('old scope cannot publish a response that resolves after a session change', async () => {
  const { client, read, scope } = setup();
  const raw = { entity: { id: first } } as Awaited<ReturnType<RecordRead>>;
  let finish: (data: typeof raw) => void = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  prefetchRecord(client, read, first, 'focus');
  resetUndoSession();
  recordNetworkReadReceipt(raw, {
    epoch: scope.epoch,
    receivedAt: Date.now(),
    watermark: '0',
    startedSequence: nextNetworkOrder(),
  });
  finish(raw);
  await vi.advanceTimersByTimeAsync(0);
  expect(client.getQueryData(keyOf(first))).toBeUndefined();
});

test('an offline startup does not start speculative reads before TanStack sees an event', () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  try {
    const { client, read } = setup();
    prefetchRecord(client, read, first, 'focus');
    expect(read).not.toHaveBeenCalled();
    expect(warmDetailScreen).not.toHaveBeenCalled();
  } finally {
    online.mockRestore();
  }
});
