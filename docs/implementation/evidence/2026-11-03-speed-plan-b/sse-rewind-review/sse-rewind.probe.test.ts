import type { ChangePage } from '@orbis/shared';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChangeWake } from '../../../../server/src/freshness/listener';
import { streamChanges } from '../../../../server/src/freshness/stream';

function page(watermark: string, floor = '0', reset: ChangePage['reset'] = null): ChangePage {
  return { watermark, floor, reset, transactions: [] };
}

const floorReset = (floor: string, phase: 'provisional' | 'complete') =>
  ({ reason: 'floor', phase, token: `floor:${floor}:${phase}` }) as const;

const startAt = 1_000_000;
afterEach(() => vi.useRealTimers());

describe('B13 active SSE reader across an authoritative strict lowering', () => {
  for (const holdFloor of [false, true])
    test(`returns to idle safety cadence after strict lowering (old provisional floor=${holdFloor})`, async () => {
      vi.useFakeTimers({ now: startAt });
      const stop = new AbortController();
      const reads: { at: number; from: string }[] = [];
      let old = true;
      let wake: (notice: ChangeWake) => void = () => {};
      let newCommitAt: number | undefined;
      const initial = holdFloor ? page('101', '140', floorReset('140', 'provisional')) : page('101');
      const stream = streamChanges({
        from: '100',
        expiresAt: startAt + 120_000,
        signal: stop.signal,
        subscribe(callback) {
          wake = callback;
          return () => {};
        },
        async read(from) {
          reads.push({ at: Date.now() - startAt, from });
          if (old) return { page: initial, targetXid: holdFloor ? '180' : '100' };
          if (from === '101')
            return {
              page: page('20', '0', { reason: 'future-cursor', phase: 'complete', token: 'future-cursor:101:0:20' }),
              targetXid: '19',
            };
          if (newCommitAt !== undefined) {
            const observed = page('21');
            observed.transactions.push({
              txId: '20',
              changes: [{
                kind: 'entity',
                rowKey: 'synthetic-record',
                entityIds: ['synthetic-record'],
                threadId: null,
                operation: 'update',
                scope: 'other',
                at: new Date().toISOString(),
                graphWide: false,
              }],
            });
            return { page: observed, targetXid: '20' };
          }
          return { page: page('20'), targetXid: '19' };
        },
      });
      let afterReset: ReturnType<typeof stream.next> | undefined;
      try {
        expect((await stream.next()).value).toMatchObject({ watermark: '101' });
        old = false;
        // On reconnect only the new snapshot can describe current activity.
        wake({ recovered: true });
        const rewind = stream.next();
        await vi.advanceTimersByTimeAsync(100);
        expect((await rewind).value).toMatchObject({ watermark: '20', reset: { reason: 'future-cursor' } });
        const afterRewindReadCount = reads.length;
        afterReset = stream.next();
        await vi.advanceTimersByTimeAsync(10_000);
        const idle = reads.slice(afterRewindReadCount);
        newCommitAt = Date.now() - startAt;
        wake({ txId: 20n });
        await vi.advanceTimersByTimeAsync(2_500);
        const next = await afterReset;
        const newCommitLatency = reads.at(-1)!.at - newCommitAt;
        process.stdout.write(JSON.stringify({ holdFloor, reads, idle, newCommitAt, newCommitLatency }) + '\n');
        expect(next.value).toMatchObject({ watermark: '21', transactions: [{ txId: '20' }] });
        expect.soft(idle).toEqual([]);
        expect.soft(newCommitLatency).toBe(50);
      } finally {
        stop.abort();
        await afterReset;
        await stream.return(undefined);
      }
    });
});

test('B13 ordinary provisional to complete retains held-xmin retry then becomes idle', async () => {
  vi.useFakeTimers({ now: startAt });
  const stop = new AbortController();
  const reads: { at: number; from: string }[] = [];
  const stream = streamChanges({
    from: '10',
    expiresAt: startAt + 120_000,
    signal: stop.signal,
    subscribe: () => () => {},
    async read(from) {
      reads.push({ at: Date.now() - startAt, from });
      if (reads.length <= 2)
        return { page: page('10', '15', floorReset('15', 'provisional')), targetXid: '15' };
      if (reads.length === 3)
        return { page: page('16', '15', floorReset('15', 'complete')), targetXid: '15' };
      return { page: page('16', '15'), targetXid: '15' };
    },
  });
  let idle: ReturnType<typeof stream.next> | undefined;
  try {
    expect((await stream.next()).value).toMatchObject({ reset: { phase: 'provisional' } });
    const complete = stream.next();
    await vi.advanceTimersByTimeAsync(300);
    expect((await complete).value).toMatchObject({ reset: { phase: 'complete' }, watermark: '16' });
    idle = stream.next();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toEqual([{ at: 0, from: '10' }, { at: 100, from: '10' }, { at: 300, from: '10' }]);
  } finally {
    stop.abort();
    await idle;
    await stream.return(undefined);
  }
});
