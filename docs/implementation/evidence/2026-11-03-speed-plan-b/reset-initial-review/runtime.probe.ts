
function resetProbe(
  floor: string,
  watermark: string,
  reason: 'floor' | 'future-cursor',
  phase: 'provisional' | 'complete',
  from: string,
): ChangePage {
  return {
    floor,
    watermark,
    reset: {
      reason,
      phase,
      token: reason === 'floor' ? `floor:${floor}:${phase}` : `future-cursor:${from}:${floor}:${watermark}`,
    },
    transactions: [],
  };
}

function observeProbeCursor(
  queryClient: QueryClient,
  runtime: ReturnType<typeof createFreshnessRuntime>,
  transport: ReturnType<typeof setup>['transport'],
) {
  const settingsKey = [['user', 'getSettings'], { type: 'query' }];
  queryClient.setQueryData(settingsKey, {});
  publish(runtime, queryClient, settingsKey, { graphEstablished: true }, {
    watermark: '10',
    receivedAt: Date.now(),
  });
  expect(transport.start).toHaveBeenCalledOnce();
  return transport.start.mock.calls[0][0].getCursor;
}

it('B13 probe: repeated provisional reset can advance W2 without another refresh', () => {
  const { queryClient, runtime, transport } = setup();
  const cursor = observeProbeCursor(queryClient, runtime, transport);
  const reset = vi.fn();
  runtime.setSinks({ resetResponses: reset });
  expect(runtime.acceptChanges(scope, resetProbe('20', '10', 'floor', 'provisional', '10'), '10')).toBe(true);
  expect(runtime.acceptChanges(scope, resetProbe('20', '15', 'floor', 'provisional', '10'), '10')).toBe(true);
  expect(reset).toHaveBeenCalledTimes(1);
  expect.soft(cursor()).toBe('15');
  expect.soft(runtime.acceptChanges(scope, resetProbe('20', '21', 'floor', 'complete', '15'), '15')).toBe(true);
  expect.soft(cursor()).toBe('21');
  expect.soft(reset).toHaveBeenCalledTimes(2);
});

it('B13 probe: same floor token can validly recur after a database rollback', () => {
  const { queryClient, runtime, transport } = setup();
  const cursor = observeProbeCursor(queryClient, runtime, transport);
  const reset = vi.fn();
  runtime.setSinks({ resetResponses: reset });
  const floor = resetProbe('20', '21', 'floor', 'complete', '11');
  expect(runtime.acceptChanges(scope, event(10), '10')).toBe(true);
  expect(runtime.acceptChanges(scope, floor, '11')).toBe(true);
  expect(cursor()).toBe('21');
  expect(runtime.acceptChanges(scope, resetProbe('0', '11', 'future-cursor', 'complete', '21'), '21')).toBe(true);
  expect(cursor()).toBe('11');
  expect(runtime.acceptChanges(scope, floor, '11')).toBe(true);
  expect.soft(cursor()).toBe('21');
  expect.soft(reset).toHaveBeenCalledTimes(3);
  expect.soft(runtime.acceptChanges(scope, { ...event(21), floor: '20' }, '21')).toBe(true);
});

it('B13 probe: identical future reset can validly recur after a second rollback', () => {
  const { queryClient, runtime, transport } = setup();
  const cursor = observeProbeCursor(queryClient, runtime, transport);
  const reset = vi.fn();
  runtime.setSinks({ resetResponses: reset });
  const rollback = resetProbe('0', '11', 'future-cursor', 'complete', '21');
  expect(runtime.acceptChanges(scope, event(20), '10')).toBe(true);
  expect(runtime.acceptChanges(scope, rollback, '21')).toBe(true);
  expect(cursor()).toBe('11');
  expect(runtime.acceptChanges(scope, event(20), '11')).toBe(true);
  expect(cursor()).toBe('21');
  expect(runtime.acceptChanges(scope, rollback, '21')).toBe(true);
  expect.soft(cursor()).toBe('11');
  expect.soft(reset).toHaveBeenCalledTimes(2);
});

it('B13 control: ordinary duplicate provisional and complete tokens are idempotent', () => {
  const { queryClient, runtime, transport } = setup();
  const cursor = observeProbeCursor(queryClient, runtime, transport);
  const reset = vi.fn();
  runtime.setSinks({ resetResponses: reset });
  const provisional = resetProbe('20', '10', 'floor', 'provisional', '10');
  const complete = resetProbe('20', '21', 'floor', 'complete', '10');
  expect(runtime.acceptChanges(scope, provisional, '10')).toBe(true);
  expect(runtime.acceptChanges(scope, provisional, '10')).toBe(true);
  expect(reset).toHaveBeenCalledTimes(1);
  expect(runtime.acceptChanges(scope, complete, '10')).toBe(true);
  expect(runtime.acceptChanges(scope, complete, '10')).toBe(true);
  expect(reset).toHaveBeenCalledTimes(2);
  expect(cursor()).toBe('21');
});

it('B13 control: delayed same-token complete reset must not skip ordinary events', () => {
  const { queryClient, runtime, transport } = setup();
  const cursor = observeProbeCursor(queryClient, runtime, transport);
  const reset = vi.fn();
  runtime.setSinks({ resetResponses: reset });
  expect(runtime.acceptChanges(scope, resetProbe('20', '21', 'floor', 'complete', '10'), '10')).toBe(true);
  expect(runtime.acceptChanges(scope, resetProbe('20', '25', 'floor', 'complete', '10'), '10')).toBe(true);
  expect(cursor()).toBe('21');
  expect(reset).toHaveBeenCalledTimes(1);
  expect(runtime.acceptChanges(scope, { ...event(21), floor: '20' }, '21')).toBe(true);
  expect(cursor()).toBe('22');
});
