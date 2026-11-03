import { expect, test } from 'bun:test';
import type { ChangePage } from '@orbis/shared';
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
