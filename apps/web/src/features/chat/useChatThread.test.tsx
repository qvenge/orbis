import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import type { RouterOutputs } from '../../trpc';
import { useChatThread, useSendMessage } from './useChatThread';

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
  // второй запрос ушёл с before = createdAt самого старого из page1
  expect((seen[1] as { before?: string }).before).toBe(page1[page1.length - 1]?.createdAt);
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

test('replayed:true → рефетч треда, без локального аппенда ответа', async () => {
  let listCalls = 0;
  const replayedList = [
    mkMsg('u', '2026-07-05T11:00:00.000Z', 'user'),
    mkMsg('r', '2026-07-05T11:00:01.000Z', 'assistant'),
  ];
  const { calls } = renderWithProviders(<Sender />, (path) => {
    if (path === 'chat.listMessages') {
      listCalls += 1;
      return listCalls === 1 ? [] : replayedList;
    }
    if (path === 'ai.sendMessage')
      return {
        assistantMessage: mkMsg('ignored', 'x', 'assistant'),
        actions: [],
        pending: [],
        replayed: true,
      };
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
  fireEvent.click(screen.getByText('send'));
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'chat.listMessages').length).toBeGreaterThanOrEqual(2),
  );
});
