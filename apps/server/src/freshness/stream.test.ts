import { expect, test } from 'bun:test';
import type { ChangePage } from '@orbis/shared';
import type { ChangeWake } from './listener';
import { streamChanges } from './stream';

const empty = (watermark: string): ChangePage => ({
  watermark,
  floor: '0',
  reset: null,
  transactions: [],
});

test('a pre-connect commit behind xmin catches up without another notification', async () => {
  const stop = new AbortController();
  const froms: string[] = [];
  const stream = streamChanges({
    from: '10',
    expiresAt: Date.now() + 120_000,
    signal: stop.signal,
    subscribe: () => () => {},
    read: async (from) => {
      froms.push(from);
      if (froms.length === 1) return { page: empty('10'), targetXid: '12' };
      return {
        page: {
          ...empty('13'),
          reset: { reason: 'overflow', phase: 'complete', token: 'overflow:10:0:13' },
          transactions: [],
        },
        targetXid: '12',
      };
    },
  });
  try {
    const next = await stream.next();
    expect(next.done).toBe(false);
    expect(next.value).toMatchObject({ watermark: '13' });
    expect(froms).toEqual(['10', '10']);
  } finally {
    stop.abort();
    await stream.return(undefined);
  }
});

test('verified expiry interrupts a blocked read and discards its late result', async () => {
  let release!: (value: { page: ChangePage; targetXid: string }) => void;
  const blocked = new Promise<{ page: ChangePage; targetXid: string }>((resolve) => {
    release = resolve;
  });
  let unsubscribed = false;
  const stream = streamChanges({
    from: '10',
    expiresAt: Date.now() + 60_030,
    signal: new AbortController().signal,
    subscribe: () => () => {
      unsubscribed = true;
    },
    read: () => blocked,
  });
  try {
    expect(await stream.next()).toEqual({ done: false, value: { kind: 'refresh-token' } });
    expect((await stream.next()).done).toBe(true);
    expect(unsubscribed).toBe(true);
  } finally {
    release({ page: empty('11'), targetXid: '10' });
    await stream.return(undefined);
  }
});

test('two different floor resets at one watermark and the complete reset all reach the stream', async () => {
  const stop = new AbortController();
  const tokens = ['floor:14:provisional', 'floor:15:provisional', 'floor:15:complete'] as const;
  const pages = [
    {
      watermark: '10',
      floor: '14',
      reset: { reason: 'floor', token: tokens[0], phase: 'provisional' },
      transactions: [],
    },
    {
      watermark: '10',
      floor: '15',
      reset: { reason: 'floor', token: tokens[1], phase: 'provisional' },
      transactions: [],
    },
    {
      watermark: '15',
      floor: '15',
      reset: { reason: 'floor', token: tokens[2], phase: 'complete' },
      transactions: [],
    },
  ] satisfies ChangePage[];
  const stream = streamChanges({
    from: '10',
    expiresAt: Date.now() + 120_000,
    signal: stop.signal,
    subscribe: () => () => {},
    read: async () => {
      const page = pages.shift();
      if (!page) throw new Error('unexpected read');
      return { page, targetXid: '13' };
    },
  });
  try {
    for (const token of tokens)
      expect((await stream.next()).value).toMatchObject({ reset: { token } });
  } finally {
    stop.abort();
    await stream.return(undefined);
  }
});

function futureCursorReset(): ChangePage {
  return {
    watermark: '20',
    floor: '0',
    reset: { reason: 'future-cursor', phase: 'complete', token: 'future-cursor:101:0:20' },
    transactions: [],
  };
}

function newHistoryCommit(): ChangePage {
  return {
    watermark: '21',
    floor: '0',
    reset: null,
    transactions: [
      {
        txId: '20',
        changes: [
          {
            kind: 'entity',
            rowKey: 'new-history-record',
            entityIds: ['new-history-record'],
            threadId: null,
            operation: 'update',
            scope: 'other',
            at: '2026-11-04T00:00:00Z',
            graphWide: false,
          },
        ],
      },
    ],
  };
}

test.each([
  false,
  true,
])('strict rewind idles until a new wake (old floor: %s)', async (oldFloor) => {
  const stop = new AbortController();
  const froms: string[] = [];
  let committed = false;
  let wake: (notice: ChangeWake) => void = () => {};
  const initial: ChangePage = oldFloor
    ? {
        watermark: '101',
        floor: '140',
        reset: { reason: 'floor', phase: 'provisional', token: 'floor:140:provisional' },
        transactions: [],
      }
    : empty('101');
  const stream = streamChanges({
    from: '100',
    expiresAt: Date.now() + 120_000,
    signal: stop.signal,
    subscribe(callback) {
      wake = callback;
      return () => {};
    },
    async read(from) {
      froms.push(from);
      if (from === '100') return { page: initial, targetXid: '100' };
      if (from === '101') return { page: futureCursorReset(), targetXid: '19' };
      return committed
        ? { page: newHistoryCommit(), targetXid: '20' }
        : { page: empty('20'), targetXid: '19' };
    },
  });
  let pending: ReturnType<typeof stream.next> | undefined;
  try {
    expect((await stream.next()).value).toMatchObject({ watermark: '101' });
    wake({ recovered: true });
    expect((await stream.next()).value).toEqual(futureCursorReset());

    pending = stream.next();
    // Long enough for the old retry to fire, far before the idle safety tick.
    await Bun.sleep(350);
    expect(froms).toEqual(['100', '101']);

    committed = true;
    wake({ txId: 20n });
    expect((await pending).value).toEqual(newHistoryCommit());
    expect(froms).toEqual(['100', '101', '20']);
  } finally {
    stop.abort();
    await pending;
    await stream.return(undefined);
  }
});

test('a wake during rewind reseeds the next snapshot and retries a held commit', async () => {
  const stop = new AbortController();
  const rewindStarted = Promise.withResolvers<void>();
  const finishRewind = Promise.withResolvers<{ page: ChangePage; targetXid: string }>();
  const heldSnapshotRead = Promise.withResolvers<void>();
  const froms: string[] = [];
  let held = true;
  let wake: (notice: ChangeWake) => void = () => {};
  const stream = streamChanges({
    from: '100',
    expiresAt: Date.now() + 120_000,
    signal: stop.signal,
    subscribe(callback) {
      wake = callback;
      return () => {};
    },
    async read(from) {
      froms.push(from);
      if (from === '100') return { page: empty('101'), targetXid: '100' };
      if (from === '101') {
        rewindStarted.resolve();
        return finishRewind.promise;
      }
      if (held) {
        heldSnapshotRead.resolve();
        return { page: empty('20'), targetXid: '20' };
      }
      if (from === '20') return { page: newHistoryCommit(), targetXid: '20' };
      return { page: empty('21'), targetXid: '20' };
    },
  });
  let pending: ReturnType<typeof stream.next> | undefined;
  try {
    expect((await stream.next()).value).toMatchObject({ watermark: '101' });
    wake({ recovered: true });
    pending = stream.next();
    await rewindStarted.promise;
    wake({ txId: 20n });
    wake({ txId: 180n });
    finishRewind.resolve({ page: futureCursorReset(), targetXid: '19' });
    expect((await pending).value).toEqual(futureCursorReset());

    pending = stream.next();
    await heldSnapshotRead.promise;
    held = false;
    expect((await pending).value).toEqual(newHistoryCommit());
    expect(froms).toEqual(['100', '101', '20', '20']);

    pending = stream.next();
    await Bun.sleep(500);
    expect(froms).toEqual(['100', '101', '20', '20']);
  } finally {
    stop.abort();
    finishRewind.resolve({ page: futureCursorReset(), targetXid: '19' });
    await pending;
    await stream.return(undefined);
  }
});
