
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
