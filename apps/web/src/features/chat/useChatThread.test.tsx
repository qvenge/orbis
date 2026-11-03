import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { expect, test } from 'vitest';
import { testFreshnessOf } from '../../test/freshness';
import { renderWithProviders } from '../../test/harness';
import { type RouterOutputs, trpc } from '../../trpc';
import { chatThreadKey, useChatThread, useSendMessage } from './useChatThread';

type Msg = RouterOutputs['chat']['listMessages'][number];
const mkMsg = (id: string, createdAt: string, role: Msg['role'] = 'user'): Msg =>
  ({ id, threadId: 't1', role, content: id, metadata: {}, createdAt }) as Msg;

function Thread() {
  const { messages, fetchOlder, hasMore, isLoading } = useChatThread('t1');
  return (
    <div>
      <span data-testid="count">{messages.length}</span>
      <span data-testid="more">{String(hasMore)}</span>
      <span data-testid="loading">{String(isLoading)}</span>
      <button type="button" onClick={() => fetchOlder()}>
        older
      </button>
    </div>
  );
}

test('пагинация вверх по before-курсору (самый старый createdAt)', async () => {
  const page1 = Array.from({ length: 50 }, (_, i) =>
    mkMsg(`a${i}`, `2026-07-05T10:${String(i).padStart(2, '0')}:00.000Z`),
  );
  const page2 = [mkMsg('old1', '2026-07-05T09:00:00.000Z')];
  const seen: unknown[] = [];
  renderWithProviders(<Thread />, (path, input) => {
    if (path === 'chat.listMessages') {
      seen.push(input);
      const before = (input as { before?: string }).before;
      return before ? page2 : page1;
    }
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('50'));
  expect(screen.getByTestId('more')).toHaveTextContent('true'); // ровно 50 → есть ещё
  fireEvent.click(screen.getByText('older'));
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('51'));
  // второй запрос ушёл с составным курсором `"<createdAt>|<id>"` самого старого из page1
  const oldest = page1[page1.length - 1];
  expect((seen[1] as { before?: string }).before).toBe(`${oldest?.createdAt}|${oldest?.id}`);
  expect(screen.getByTestId('more')).toHaveTextContent('false'); // 1 < 50 → конец
});

function Sender() {
  const { messages } = useChatThread('t1');
  const { sendMessage, isSending } = useSendMessage('t1');
  return (
    <div>
      <span data-testid="count">{messages.length}</span>
      <span data-testid="sending">{String(isSending)}</span>
      <button type="button" onClick={() => sendMessage('привет')}>
        send
      </button>
    </div>
  );
}

test('optimistic: user-сообщение появляется сразу; не-replayed добавляет ответ ассистента', async () => {
  const assistant = mkMsg('resp', '2026-07-05T11:00:00.000Z', 'assistant');
  renderWithProviders(<Sender />, (path) => {
    if (path === 'chat.listMessages') return [];
    if (path === 'ai.sendMessage')
      return { assistantMessage: assistant, actions: [], pending: [], replayed: false };
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
  fireEvent.click(screen.getByText('send'));
  // optimistic user-сообщение сразу
  await waitFor(() =>
    expect(Number(screen.getByTestId('count').textContent)).toBeGreaterThanOrEqual(1),
  );
  // затем прилетает ответ ассистента
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
});

test('chat graph events invalidate budget and refetch the authoritative thread', async () => {
  const { queryClient, calls } = renderWithProviders(
    <Sender />,
    (path) => {
      if (path === 'chat.listMessages') return [];
      if (path === 'ai.sendMessage')
        return {
          assistantMessage: mkMsg('resp', '2026-07-05T11:00:00.000Z', 'assistant'),
          actions: [],
          pending: [],
          replayed: false,
        };
      throw new Error(`unexpected ${path}`);
    },
    { freshness: true },
  );
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
  const budgetKey = getQueryKey(trpc.budget.overview, { month: '2026-07' }, 'query');
  queryClient.setQueryData(budgetKey, null);
  fireEvent.click(screen.getByText('send'));
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
  expect(queryClient.getQueryData(chatThreadKey('t1'))).toMatchObject({ pages: [[]] });
  await act(async () =>
    testFreshnessOf(queryClient).changes([
      { kind: 'entity', rowKey: 'purchase' },
      { kind: 'message', rowKey: 'resp', threadId: 't1' },
    ]),
  );
  await waitFor(() =>
    expect(calls.filter(({ path }) => path === 'chat.listMessages')).toHaveLength(2),
  );
  expect(queryClient.getQueryState(budgetKey)?.isInvalidated).toBe(true);
});

test('partial commit and reset retain the same retry UUID and text outside the raw cache', async () => {
  let ui:
    | { send: ReturnType<typeof useSendMessage>; thread: ReturnType<typeof useChatThread> }
    | undefined;
  const probe = () => {
    ui = { send: useSendMessage('t1'), thread: useChatThread('t1') };
    return null;
  };
  const Probe = probe;
  let server: Msg[] = [];
  let refuse: (reason: unknown) => void = () => {};
  const firstSend = new Promise((_resolve, reject) => {
    refuse = reject;
  });
  let sends = 0;
  const { queryClient, calls } = renderWithProviders(
    <Probe />,
    (path) => {
      if (path === 'chat.listMessages') return server;
      if (path === 'ai.sendMessage')
        return ++sends === 1
          ? firstSend
          : {
              assistantMessage: mkMsg('answer', '2026-07-05T11:00:01.000Z', 'assistant'),
              actions: [],
              pending: [],
              replayed: true,
            };
      throw new Error(`unexpected ${path}`);
    },
    { freshness: true },
  );
  await waitFor(() => expect(ui?.thread.isLoading).toBe(false));
  act(() => ui?.send.sendMessage('создай и упади'));
  await waitFor(() =>
    expect(calls.filter(({ path }) => path === 'ai.sendMessage')).toHaveLength(1),
  );
  const input = calls.find(({ path }) => path === 'ai.sendMessage')?.input as {
    id: string;
    content: string;
  };
  server = [{ ...mkMsg(input.id, '2026-07-05T11:00:00.000Z'), content: input.content }];
  const feed = testFreshnessOf(queryClient);
  await act(async () => feed.changes([{ kind: 'message', rowKey: input.id, threadId: 't1' }]));
  await waitFor(() =>
    expect(queryClient.getQueryData(chatThreadKey('t1'))).toMatchObject({ pages: [server] }),
  );
  await act(async () => refuse(new Error('LLM_UNAVAILABLE')));
  const retry = () => ui?.thread.messages.find(({ metadata }) => metadata.retryId === input.id);
  await waitFor(() => expect(retry()?.metadata.retryText).toBe(input.content));
  await act(async () => feed.reset());
  await waitFor(() =>
    expect(calls.filter(({ path }) => path === 'chat.listMessages')).toHaveLength(3),
  );
  expect(retry()).toBeDefined();
  expect(ui?.thread.messages.filter(({ id }) => id === input.id)).toHaveLength(1);
  expect(queryClient.getQueryData(chatThreadKey('t1'))).toMatchObject({ pages: [server] });
  act(() => ui?.send.retryMessage({ ...input, errorMessageId: retry()?.id ?? '' }));
  await waitFor(() => expect(ui?.thread.messages.some(({ id }) => id === 'answer')).toBe(true));
  expect(retry()).toBeUndefined();
  expect(calls.filter(({ path }) => path === 'ai.sendMessage').map(({ input }) => input)).toEqual([
    { ...input, threadId: 't1' },
    { ...input, threadId: 't1' },
  ]);
});

test('processing waits for the thread feed instead of using a timer', async () => {
  const { queryClient, calls } = renderWithProviders(
    <Sender />,
    (path) => {
      if (path === 'chat.listMessages') return [];
      if (path === 'ai.sendMessage') return { status: 'processing' };
      throw new Error(`unexpected ${path}`);
    },
    { freshness: true },
  );
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
  fireEvent.click(screen.getByText('send'));
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
  expect(calls.filter(({ path }) => path === 'chat.listMessages')).toHaveLength(1);
  await act(async () =>
    testFreshnessOf(queryClient).changes([{ kind: 'message', rowKey: 'reply', threadId: 't1' }]),
  );
  await waitFor(() =>
    expect(calls.filter(({ path }) => path === 'chat.listMessages')).toHaveLength(2),
  );
});
