import { CLIENT_VERSION_HEADER, READ_WATERMARK_HEADER } from '@orbis/shared';
import { hashKey, QueryClient } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { makeVanillaClient, networkReadReceiptOf, nextNetworkOrder } from '../../trpc';
import { createFreshnessRuntime } from './runtime';
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
      getHistory: () => 0,
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
      getHistory: () => 0,
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
      getHistory: () => 0,
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
      getHistory: () => 0,
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
      getHistory: () => 0,
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

test('an ignored higher complete reset reconnects from the accepted boundary without skipping events', async () => {
  let cursor = '10';
  const opened: string[] = [];
  const received: Array<[string, string]> = [];
  const reset = {
    ...page('25'),
    floor: '20',
    reset: { reason: 'floor', phase: 'complete', token: 'floor:20:complete' },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      opened.push(new Headers(init?.headers).get('Last-Event-ID') ?? '');
      if (opened.length === 1) {
        // Reconcile accepted the same complete token at W21 while this SSE
        // request from 10 was still outstanding.
        cursor = '21';
        return eventStream(`${connected}id: 25\ndata: ${JSON.stringify(reset)}\n\n${frame('26')}`);
      }
      return eventStream(connected + frame('22'));
    }),
  );
  const transport = createFreshnessTransport({ getToken: () => 'bearer' });
  try {
    transport.start({
      scope,
      isCurrent: () => true,
      getCursor: () => cursor,
      getHistory: () => 0,
      acceptChanges: (_, result, from) => {
        received.push([from, result.watermark]);
        if (!result.reset) cursor = result.watermark;
        return true;
      },
    });
    await vi.waitFor(() => expect(cursor).toBe('22'));
    expect(opened).toEqual(['10', '21']);
    expect(received).toEqual([
      ['10', '25'],
      ['21', '22'],
    ]);
  } finally {
    transport.stop();
  }
});

test('overlapping SSE continues from the wire boundary while reconcile is ahead', async () => {
  let cursor = '10';
  const fetch = vi.fn(async () => eventStream(connected + frame('11') + frame('12')));
  vi.stubGlobal('fetch', fetch);
  const received: Array<[string, string]> = [];
  const transport = createFreshnessTransport({ getToken: () => 'bearer' });
  try {
    transport.start({
      scope,
      isCurrent: () => true,
      getCursor: () => cursor,
      getHistory: () => 0,
      acceptChanges: (_, result, from) => {
        received.push([from, result.watermark]);
        cursor = '13';
        return true;
      },
    });
    await vi.waitFor(() =>
      expect(received).toEqual([
        ['10', '11'],
        ['11', '12'],
      ]),
    );
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    transport.stop();
  }
});

test.each([
  { boundary: 'none', reply: 'delete' },
  { boundary: 'overflow', reply: 'delete' },
  { boundary: 'rewind', reply: 'delete' },
  { boundary: 'rewind', reply: 'unauthorized' },
] as const)('B13 late $reply reconcile after $boundary', async ({ boundary, reply }) => {
  const rewind = boundary === 'rewind';
  const client = new QueryClient();
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController;
  let releasePoll!: (reply: Response) => void;
  const holdPoll = new Promise<Response>((resolve) => {
    releasePoll = resolve;
  });
  const fetch = vi.fn(async (url: string) =>
    String(url).includes('changes.watch')
      ? new Response(
          new ReadableStream({
            start(value) {
              controller = value;
              controller.enqueue(encoder.encode(connected));
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      : holdPoll,
  );
  vi.stubGlobal('fetch', fetch);
  const refreshToken = vi.fn(async () => ({ kind: 'retry' as const }));
  const transport = createFreshnessTransport({ getToken: () => 'bearer', refreshToken });
  let acceptedCursor!: () => string;
  const runtime = createFreshnessRuntime({
    queryClient: client,
    scope,
    transport: {
      ...transport,
      start(options) {
        acceptedCursor = options.getCursor;
        transport.start(options);
      },
    },
  });
  const settings = [['user', 'getSettings'], { type: 'query' }];
  client.setQueryData(settings, {});
  expect(
    runtime.acceptRead({
      source: 'network',
      scope,
      key: settings,
      queryHash: hashKey(settings),
      raw: { graphEstablished: true },
      receipt: {
        epoch: scope.epoch,
        watermark: '10',
        receivedAt: Date.now(),
        startedSequence: nextNetworkOrder(),
      },
    }),
  ).toBe(true);
  const entityId = 'same-uuid-in-both-histories';
  const change = (operation: 'delete' | 'insert') => ({
    txId: '32',
    changes: [
      {
        kind: 'entity',
        rowKey: entityId,
        entityIds: [entityId],
        threadId: null,
        operation,
        scope: 'other',
        at: '2026-11-04T00:00:00.000Z',
        graphWide: false,
      },
    ],
  });
  const push = <T extends { watermark: string }>(body: T) => {
    controller.enqueue(encoder.encode(`id: ${body.watermark}\ndata: ${JSON.stringify(body)}\n\n`));
  };
  const removeEntity = vi.fn();
  runtime.setSinks({ removeEntity });
  try {
    const poll = transport.reconcile();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    push(page('31'));
    await vi.waitFor(() => expect(acceptedCursor()).toBe('31'));
    if (rewind) {
      push({
        ...page('20'),
        reset: { reason: 'future-cursor', phase: 'complete', token: 'future-cursor:31:0:20' },
      });
      await vi.waitFor(() => expect(acceptedCursor()).toBe('20'));
    } else if (boundary === 'overflow') {
      const reset = vi.fn();
      runtime.setSinks({ resetResponses: reset });
      push({
        ...page('31'),
        reset: { reason: 'overflow', phase: 'complete', token: 'overflow:31:0:31' },
      });
      await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce());
    }
    releasePoll(
      Response.json(
        reply === 'delete'
          ? [{ result: { data: { ...page('35'), transactions: [change('delete')] } } }]
          : [{ error: { code: -32001, message: 'Unauthorized', data: { code: 'UNAUTHORIZED' } } }],
      ),
    );
    await poll;
    expect(refreshToken).not.toHaveBeenCalled();
    expect.soft(acceptedCursor()).toBe(rewind ? '20' : '35');
    if (rewind) {
      push({ ...page('40'), transactions: [change('insert')] });
      await vi.waitFor(() => expect(acceptedCursor()).toBe('40'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect.soft(removeEntity).not.toHaveBeenCalled();
      expect.soft(runtime.wasDeleted(entityId)).toBe(false);
    } else {
      await vi.waitFor(() => expect(removeEntity).toHaveBeenCalledOnce());
      expect(runtime.wasDeleted(entityId)).toBe(true);
    }
  } finally {
    runtime.dispose();
    client.clear();
  }
});

test('a reconcile-origin rewind aborts the old SSE attempt and reconnects at the lower cursor', async () => {
  let cursor = '10';
  let history = 0;
  const streams: Array<{ from: string | null; signal?: AbortSignal | null }> = [];
  const accepted: Array<[string, string]> = [];
  const encoder = new TextEncoder();
  let oldStream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const rewind = {
    ...page('20'),
    reset: { reason: 'future-cursor', phase: 'complete', token: 'future-cursor:31:0:20' },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).includes('changes.watch'))
        return Response.json([{ result: { data: rewind } }]);
      streams.push({ from: new Headers(init?.headers).get('Last-Event-ID'), signal: init?.signal });
      if (streams.length > 1) return eventStream(connected + frame('21'));
      return new Response(
        new ReadableStream({
          start(controller) {
            oldStream = controller;
            controller.enqueue(encoder.encode(connected + frame('31')));
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }),
  );
  const transport = createFreshnessTransport({ getToken: () => 'bearer' });
  try {
    transport.start({
      scope,
      isCurrent: () => true,
      getCursor: () => cursor,
      getHistory: () => history,
      acceptChanges: (_, result, from) => {
        accepted.push([from, result.watermark]);
        cursor = result.watermark;
        if (result.reset?.reason === 'future-cursor') history += 1;
        return true;
      },
    });
    await vi.waitFor(() => expect(cursor).toBe('31'));
    await transport.reconcile();
    expect(cursor).toBe('20');
    expect(streams[0]?.signal?.aborted).toBe(true);
    expect(oldStream).toBeDefined();
    try {
      // A deliberately late frame from the previous history. Some readers
      // cancel the source immediately; others still have bytes in their buffer.
      oldStream?.enqueue(encoder.encode(frame('35')));
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
    }
    await vi.waitFor(() => expect(cursor).toBe('21'));
    expect(streams.map(({ from }) => from)).toEqual(['10', '20']);
    expect(accepted).toEqual([
      ['10', '31'],
      ['31', '20'],
      ['20', '21'],
    ]);
  } finally {
    transport.stop();
  }
});

test.each([false, true])('B13 late reconcile with authoritative rewind = %s', async (rewind) => {
  const client = new QueryClient();
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController;
  let releasePoll!: (reply: Response) => void;
  const holdPoll = new Promise<Response>((resolve) => { releasePoll = resolve; });
  const fetch = vi.fn(async (url: string) =>
    String(url).includes('changes.watch')
      ? new Response(new ReadableStream({
          start(value) {
            controller = value;
            controller.enqueue(encoder.encode(connected));
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } })
      : holdPoll,
  );
  vi.stubGlobal('fetch', fetch);
  const transport = createFreshnessTransport({ getToken: () => 'bearer' });
  let acceptedCursor!: () => string;
  const runtime = createFreshnessRuntime({
    queryClient: client,
    scope,
    transport: {
      ...transport,
      start(options) {
        acceptedCursor = options.getCursor;
        transport.start(options);
      },
    },
  });
  const settings = [['user', 'getSettings'], { type: 'query' }];
  client.setQueryData(settings, {});
  expect(runtime.acceptRead({
    source: 'network',
    scope,
    key: settings,
    queryHash: hashKey(settings),
    raw: { graphEstablished: true },
    receipt: { epoch: scope.epoch, watermark: '10', receivedAt: Date.now(), startedSequence: nextNetworkOrder() },
  })).toBe(true);
  const entityId = 'same-uuid-in-both-histories';
  const change = (operation: 'delete' | 'insert') => ({
    txId: '32',
    changes: [{
      kind: 'entity',
      rowKey: entityId,
      entityIds: [entityId],
      threadId: null,
      operation,
      scope: 'other',
      at: '2026-11-04T00:00:00.000Z',
      graphWide: false,
    }],
  });
  const push = (body: object & { watermark: string }) => {
    controller.enqueue(encoder.encode(`id: ${body.watermark}\ndata: ${JSON.stringify(body)}\n\n`));
  };
  const removeEntity = vi.fn();
  runtime.setSinks({ removeEntity });
  try {
    const poll = transport.reconcile();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    push(page('31'));
    await vi.waitFor(() => expect(acceptedCursor()).toBe('31'));
    if (rewind) {
      push({
        ...page('20'),
        reset: { reason: 'future-cursor', phase: 'complete', token: 'future-cursor:31:0:20' },
      });
      await vi.waitFor(() => expect(acceptedCursor()).toBe('20'));
    }
    releasePoll(Response.json([{ result: { data: { ...page('35'), transactions: [change('delete')] } } }]));
    await poll;
    expect.soft(acceptedCursor()).toBe(rewind ? '20' : '35');
    if (rewind) {
      push({ ...page('40'), transactions: [change('insert')] });
      await vi.waitFor(() => expect(acceptedCursor()).toBe('40'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect.soft(removeEntity).not.toHaveBeenCalled();
      expect.soft(runtime.wasDeleted(entityId)).toBe(false);
    } else {
      await vi.waitFor(() => expect(removeEntity).toHaveBeenCalledOnce());
      expect(runtime.wasDeleted(entityId)).toBe(true);
    }
  } finally {
    runtime.dispose();
    client.clear();
  }
});
