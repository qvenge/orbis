import { CLIENT_VERSION_HEADER, READ_WATERMARK_HEADER } from '@orbis/shared';
import { afterEach, expect, test, vi } from 'vitest';
import { makeVanillaClient, networkReadReceiptOf, nextNetworkOrder } from '../../trpc';
import { createFreshnessTransport } from './transport';

const scope = { accountId: 'owner', graphId: 'graph', epoch: 1 };
const connected = 'event: connected\ndata: {}\n\n';
const page = (watermark: string) => ({
  watermark,
  floor: '0',
  reset: null,
  transactions: [],
});
const frame = (watermark: string) =>
  `id: ${watermark}\ndata: ${JSON.stringify(page(watermark))}\n\n`;
const control = 'data: {"kind":"refresh-token"}\n\nevent: return\ndata:\n\n';

function eventStream(events: string) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(events));
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => vi.unstubAllGlobals());

test('rejection discards the wire id, while a refresh sends the new bearer on a fresh request', async () => {
  let cursor = '10';
  const calls: { url: URL; headers: Headers }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: new URL(url, location.href), headers: new Headers(init?.headers) });
      switch (calls.length) {
        case 1:
          return eventStream(connected + frame('11') + frame('12'));
        case 2:
          return eventStream(connected + frame('12') + control);
        default:
          return eventStream(connected);
      }
    }),
  );
  const refreshToken = vi.fn(async () => ({ kind: 'refreshed' as const, token: 'next-secret' }));
  const transport = createFreshnessTransport({ getToken: () => 'old-secret', refreshToken });
  const accepted: [string, string][] = [];
  let rejectFirstTwelve = true;
  try {
    transport.start({
      scope,
      isCurrent: () => true,
      getCursor: () => cursor,
      acceptChanges: (_, result, from) => {
        if (result.watermark === '12' && rejectFirstTwelve) {
          rejectFirstTwelve = false;
          return false;
        }
        accepted.push([from, result.watermark]);
        cursor = result.watermark;
        return true;
      },
    });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(accepted).toEqual([
      ['10', '11'],
      ['11', '12'],
    ]);
    expect(calls.map(({ url }) => JSON.parse(url.searchParams.get('input') ?? '{}').from)).toEqual([
      '10',
      '11',
      '12',
    ]);
    expect(calls.map(({ headers }) => headers.get('Authorization'))).toEqual([
      'Bearer old-secret',
      'Bearer old-secret',
      'Bearer next-secret',
    ]);
    expect(calls.every(({ headers }) => headers.has(CLIENT_VERSION_HEADER))).toBe(true);
    expect(calls.every(({ url }) => !url.href.includes('secret'))).toBe(true);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  } finally {
    transport.stop();
  }
});

test('SSE and reconcile 401 share refresh and keep the session on network failure', async () => {
  let finishRefresh!: (result: { kind: 'retry' }) => void;
  const refreshToken = vi.fn(
    () =>
      new Promise<{ kind: 'retry' }>((resolve) => {
        finishRefresh = resolve;
      }),
  );
  const onUnauthorized = vi.fn();
  const fetch = vi.fn(async (url: string) => {
    if (String(url).includes('changes.watch')) return new Response(null, { status: 401 });
    return Response.json([
      { error: { code: -32001, message: 'Unauthorized', data: { code: 'UNAUTHORIZED' } } },
    ]);
  });
  vi.stubGlobal('fetch', fetch);
  const transport = createFreshnessTransport({
    getToken: () => 'expired',
    refreshToken,
    onUnauthorized,
  });
  try {
    transport.start({
      scope,
      getCursor: () => '10',
      isCurrent: () => true,
      acceptChanges: () => true,
    });
    const reconcile = transport.reconcile();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(refreshToken).toHaveBeenCalledTimes(1);
    finishRefresh({ kind: 'retry' });
    await reconcile;
    expect(onUnauthorized).not.toHaveBeenCalled();
  } finally {
    transport.stop();
  }
});

test('each raw result keeps its own response watermark, including absence', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn(async (url: string) => {
    const hasWatermark = url.includes('user.getSettings');
    if (hasWatermark) await held;
    const result = { source: hasWatermark ? 'settings' : 'ping' };
    return Response.json([{ result: { data: result } }], {
      headers: hasWatermark ? { [READ_WATERMARK_HEADER]: '18446744073709551615' } : {},
    });
  });
  vi.stubGlobal('fetch', fetch);
  const client = makeVanillaClient(() => null);
  const slowSettings = client.user.getSettings.query();
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const ack = nextNetworkOrder();
    const ping = await client.ping.query();
    release();
    const settings = await slowSettings;
    const receipt = networkReadReceiptOf(settings);
    expect(receipt?.watermark).toBe('18446744073709551615');
    expect(receipt?.startedSequence).toBeLessThan(ack);
    expect(networkReadReceiptOf(ping)?.watermark).toBeNull();
    expect(networkReadReceiptOf(ping)?.startedSequence).toBeGreaterThan(ack);
  } finally {
    release();
  }
});

test('a refresh refusal affects its current owner once, even when both channels receive 401', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).includes('changes.watch')
        ? new Response(null, { status: 401 })
        : Response.json([
            { error: { code: -32001, message: 'Unauthorized', data: { code: 'UNAUTHORIZED' } } },
          ]),
    ),
  );
  const onUnauthorized = vi.fn();
  const refreshToken = vi.fn(async () => ({ kind: 'unauthorized' as const }));
  const transport = createFreshnessTransport({
    getToken: () => 'expired',
    refreshToken,
    onUnauthorized,
  });
  try {
    transport.start({
      scope,
      getCursor: () => '10',
      isCurrent: () => true,
      acceptChanges: () => true,
    });
    await transport.reconcile();
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(refreshToken).toHaveBeenCalledTimes(1);
  } finally {
    transport.stop();
  }
});

test('stopping and restarting keeps runtime-owned queued work and cursor until owner changes', async () => {
  const epochOne = { cursor: '10', queued: [] as string[] };
  const epochTwo = { cursor: '20', queued: [] as string[] };
  const opened: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      opened.push(new Headers(init?.headers).get('Last-Event-ID') ?? '');
      if (opened.length === 1) return eventStream(connected + frame('11'));
      if (opened.length === 2) return eventStream(connected + frame('12'));
      return eventStream(connected + frame('21'));
    }),
  );
  const transport = createFreshnessTransport({ getToken: () => 'bearer' });
  function start(epoch: number, state: typeof epochOne) {
    transport.start({
      scope: { ...scope, epoch },
      isCurrent: () => true,
      getCursor: () => state.cursor,
      acceptChanges: (_, result) => {
        state.cursor = result.watermark;
        state.queued.push(result.watermark);
        return true;
      },
    });
  }
  try {
    start(1, epochOne);
    await vi.waitFor(() => expect(epochOne.queued).toEqual(['11']));
    // The first item has been accepted but its owner has not applied it.
    transport.stop();
    start(1, epochOne);
    await vi.waitFor(() => expect(epochOne.queued).toEqual(['11', '12']));
    transport.stop();
    epochOne.queued.length = 0;
    start(2, epochTwo);
    await vi.waitFor(() => expect(epochTwo.queued).toEqual(['21']));
    expect(opened).toEqual(['10', '11', '20']);
    expect(epochOne.queued).toEqual([]);
  } finally {
    transport.stop();
  }
});

test('a disabled stream stays unavailable while the same session reconciles', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(String(url));
      if (String(url).includes('changes.watch')) return new Response(null, { status: 503 });
      return Response.json([{ result: { data: page('11') } }]);
    }),
  );
  const transport = createFreshnessTransport({ getToken: () => 'bearer' });
  const accepted: [string, string][] = [];
  const availability = vi.fn();
  try {
    transport.start({
      scope,
      getCursor: () => '10',
      isCurrent: () => true,
      acceptChanges: (_, result, from) => {
        accepted.push([from, result.watermark]);
        return true;
      },
      onConnectionStateChange: availability,
    });
    await transport.reconcile();
    expect(accepted).toEqual([['10', '11']]);
    expect(availability).not.toHaveBeenCalledWith(true);
    expect(requests.filter((url) => String(url).includes('changes.watch'))).toHaveLength(1);
  } finally {
    transport.stop();
  }
});
