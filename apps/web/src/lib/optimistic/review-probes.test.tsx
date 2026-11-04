import { QueryObserver } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageList } from '../../features/chat/MessageList';
import { detailGetInput, useEntityUpdate } from '../../features/entity-detail/useEntityDetail';
import { useDetailedUpdateBatch } from '../../features/page/useUpdateBatch';
import { Inbox } from '../../features/planning/Inbox';
import { testFreshnessOf } from '../../test/freshness';
import { queryReply, renderWithProviders, trpcError } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { trpc } from '../../trpc';

const entityId = 'record';
const listInput = { query: 'aspect=orbis/task' };
const row = { id: entityId, title: 'Сервер', props: { first: 0 }, aspects: [], bodyRevision: 1 };

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function View() {
  const detail = trpc.entity.get.useQuery(detailGetInput(entityId));
  const list = trpc.entity.query.useQuery(listInput);
  const { mutation } = useEntityUpdate(entityId);
  const batch = useDetailedUpdateBatch();
  const first = detail.data?.entity;
  return (
    <>
      <output aria-label="detail">
        {first?.title}:{String(first?.props.first)}:{first?.bodyRevision}
      </output>
      <output aria-label="list">{list.data?.rows[0]?.title}</output>
      <button
        type="button"
        onClick={() => mutation.mutate({ id: entityId, title: 'A', props: { first: 1 } })}
      >
        A
      </button>
      <button type="button" onClick={() => mutation.mutate({ id: entityId, title: 'B' })}>
        B
      </button>
      <button
        type="button"
        onClick={() =>
          void batch([{ tool: 'entity_update', input: { id: entityId, title: 'Пакет' } }])
        }
      >
        Batch
      </button>
    </>
  );
}

afterEach(() => vi.restoreAllMocks());

it('review: protects an already-cached list whose in-flight result first contains the edited entity', async () => {
  const precommitList = deferred<unknown>();
  const postcommitList = deferred<unknown>();
  const write = deferred<unknown>();
  let listCalls = 0;
  let current = row;
  const view = renderWithProviders(
    <View />,
    (path) => {
      if (path === 'entity.get') return { entity: current };
      if (path === 'entity.query') {
        listCalls++;
        if (listCalls === 1) return queryReply([{ ...row, id: 'neighbor', title: 'Neighbor' }]);
        if (listCalls === 2) return precommitList.promise;
        return postcommitList.promise;
      }
      if (path === 'entity.update') return write.promise;
      return {};
    },
    { freshness: true },
  );
  await screen.findByText('Сервер:0:1');
  await screen.findByText('Neighbor');
  const listKey = getQueryKey(trpc.entity.query, listInput, 'query');
  let listResult: Promise<void> | undefined;
  act(() => {
    listResult = view.queryClient.refetchQueries({ queryKey: listKey });
  });
  await waitFor(() => expect(listCalls).toBe(2));
  fireEvent.click(screen.getByRole('button', { name: 'B' }));
  await screen.findByText('B:0:1');
  current = { ...row, title: 'B канон' };
  await act(async () => write.resolve({ ...current, txId: '3' }));
  await screen.findByText('B канон:0:1');
  await act(async () => {
    precommitList.resolve(queryReply([row]));
    await listResult;
  });
  try {
    expect(
      view.queryClient.getQueryData<{ rows: { title: string }[] }>(listKey)?.rows[0]?.title,
    ).toBe('B');
  } finally {
    await act(async () => postcommitList.resolve(queryReply([current])));
  }
});

it('review: reprojection preserves the first observer notification after a background list read failure', async () => {
  const write = deferred<unknown>();
  let failRead = false;
  const view = renderWithProviders(
    <View />,
    (path) => {
      if (path === 'entity.get') return { entity: row };
      if (path === 'entity.query') {
        if (failRead) throw trpcError('INTERNAL_SERVER_ERROR', 'server read failed');
        return queryReply([row]);
      }
      if (path === 'entity.update') return write.promise;
      return {};
    },
    { freshness: true },
  );
  await screen.findByText('Сервер:0:1');
  const listKey = getQueryKey(trpc.entity.query, listInput, 'query');
  failRead = true;
  await act(async () => {
    await view.queryClient.refetchQueries({ queryKey: listKey });
  });
  const before = view.queryClient.getQueryState(listKey);
  expect(before?.status).toBe('error');
  expect(before?.isInvalidated).toBe(true);
  const observer = new QueryObserver(view.queryClient, { queryKey: listKey, enabled: false });
  const notices: unknown[] = [];
  const off = observer.subscribe((state) => {
    notices.push({
      status: state.status,
      error: state.error,
      isInvalidated: view.queryClient.getQueryState(listKey)?.isInvalidated,
      dataUpdatedAt: state.dataUpdatedAt,
    });
  });
  try {
    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    await screen.findByText('B:0:1');
    expect(screen.getByLabelText('list')).toHaveTextContent('B');
    expect(notices[0]).toEqual({
      status: 'error',
      error: before?.error,
      isInvalidated: true,
      dataUpdatedAt: before?.dataUpdatedAt,
    });
  } finally {
    off();
  }
});

it('review: keeps historical assistant text visible when the live title no longer duplicates it', async () => {
  const archivedMessage = {
    id: 'message',
    threadId: 'thread',
    role: 'assistant' as const,
    content: 'Историческое имя',
    createdAt: '2026-11-01T00:00:00Z',
    metadata: {
      cards: [
        { kind: 'entity_card', entityId, title: 'Историческое имя', aspects: [], keyFields: {} },
      ],
    },
  };
  renderWithProviders(
    <>
      <View />
      <MessageList messages={[archivedMessage]} isTyping={false} />
    </>,
    (path) => {
      if (path === 'entity.get') return { entity: row };
      if (path === 'entity.query') return queryReply([row]);
      return {};
    },
    { freshness: true },
  );
  const message = within(screen.getByTestId('message-list'));
  await message.findByRole('link', { name: row.title });
  expect(message.getByText('Историческое имя')).toBeInTheDocument();
});

it('review: lets the server decide Inbox query membership while archive is pending', async () => {
  const batch = deferred<unknown>();
  const inboxRow = { ...row, title: 'Pending Inbox item', tags: [], archived: false };
  const view = renderWithProviders(
    <Inbox onOpen={() => {}} />,
    (path) => {
      if (path === 'entity.query') return queryReply([inboxRow]);
      if (path === 'entity.updateBatch') return batch.promise;
      return registryReply(path) ?? [];
    },
    { freshness: true },
  );
  const article = await screen.findByRole('article', { name: inboxRow.title });
  fireEvent.click(within(article).getByRole('button', { name: 'В архив' }));
  await waitFor(() =>
    expect(view.calls.some(({ path }) => path === 'entity.updateBatch')).toBe(true),
  );
  expect(screen.getByRole('article', { name: inboxRow.title })).toBeInTheDocument();
});

it('review: preserves explicit journal ACK across a same-scope overflow reset', async () => {
  const write = deferred<unknown>();
  function BatchView() {
    const batch = useDetailedUpdateBatch();
    const [result, setResult] = useState('');
    return (
      <>
        <View />
        <button
          type="button"
          onClick={() =>
            void batch([{ tool: 'entity_update', input: { id: entityId, archived: true } }]).then(
              ({ kind }) => setResult(kind),
            )
          }
        >
          Archive
        </button>
        <output aria-label="outcome">{result}</output>
      </>
    );
  }
  const view = renderWithProviders(
    <BatchView />,
    (path) => {
      if (path === 'entity.get') return { entity: row };
      if (path === 'entity.query') return queryReply([row]);
      if (path === 'entity.updateBatch') return write.promise;
      return {};
    },
    { freshness: true },
  );
  await screen.findByText('Сервер:0:1');
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  await waitFor(() =>
    expect(view.calls.some(({ path }) => path === 'entity.updateBatch')).toBe(true),
  );
  act(() => testFreshnessOf(view.queryClient).reset());
  await act(async () =>
    write.resolve({ actionId: 'archive-action', consequences: true, results: [] }),
  );
  await waitFor(() => expect(screen.getByLabelText('outcome').textContent).not.toBe(''));
  expect(screen.getByLabelText('outcome')).toHaveTextContent('confirmed');
});
