import { hashKey } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderCardBodies } from '../../features/chat/cards/renderCards';
import { MessageList } from '../../features/chat/MessageList';
import { usePanelCommands } from '../../features/entity-detail/properties-relations/useCommands';
import { detailGetInput, useEntityUpdate } from '../../features/entity-detail/useEntityDetail';
import { useDetailedUpdateBatch, useUpdateBatch } from '../../features/page/useUpdateBatch';
import { Inbox } from '../../features/planning/Inbox';
import { runUndo } from '../../features/undo/undo-action';
import { peekUndoable } from '../../features/undo/undo-stack';
import { testFreshnessOf } from '../../test/freshness';
import { queryReply, renderWithProviders, trpcError } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { trpc } from '../../trpc';
import { Toaster } from '../../ui/Toast';
import { useToastStore } from '../../ui/toast-store';

import { useEntityMetadataUpdate } from './useEntityMetadataUpdate';

const entityId = 'record';
const listInput = { query: 'aspect=orbis/task' };
const row = { id: entityId, title: 'Сервер', props: { first: 0 }, aspects: [], bodyRevision: 1 };
const detailKey = getQueryKey(trpc.entity.get, detailGetInput(entityId), 'query');

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

it('projects a single edit across detail and list, then rolls back only the failed older edit', async () => {
  const a = deferred<unknown>();
  const b = deferred<unknown>();
  let current = row;
  let oldDetail: ReturnType<typeof deferred<unknown>> | undefined;
  const view = renderWithProviders(
    <View />,
    (path, input) => {
      if (path === 'entity.get') return oldDetail?.promise ?? { entity: current };
      if (path === 'entity.query') return queryReply([current]);
      if (path === 'entity.update')
        return (input as { title: string }).title === 'A' ? a.promise : b.promise;
      return {};
    },
    { freshness: true },
  );
  await screen.findByText('Сервер:0:1');
  const runtime = testFreshnessOf(view.queryClient).runtime;
  const rawBefore = runtime.publicationOf(hashKey(detailKey))?.raw;
  const age = view.queryClient.getQueryState(detailKey)?.dataUpdatedAt;
  fireEvent.click(screen.getByRole('button', { name: 'A' }));
  await screen.findByText('A:1:1');
  expect(screen.getByLabelText('list')).toHaveTextContent('A');
  expect(rawBefore).toEqual({ entity: row });
  expect(runtime.publicationOf(hashKey(detailKey))?.raw).toBe(rawBefore);
  expect(view.queryClient.getQueryState(detailKey)?.dataUpdatedAt).toBe(age);

  oldDetail = deferred();
  const oldRead = oldDetail;
  act(() => {
    void view.queryClient.refetchQueries({ queryKey: detailKey });
  });
  await waitFor(() =>
    expect(view.calls.filter(({ path }) => path === 'entity.get')).toHaveLength(2),
  );
  fireEvent.click(screen.getByRole('button', { name: 'B' }));
  await screen.findByText('B:1:1');
  await act(async () => {
    current = { ...row, title: 'B канон', bodyRevision: 2 };
    b.resolve({ ...current, txId: '3' });
    oldRead.resolve({ entity: row });
    oldDetail = undefined;
  });
  await screen.findByText('B канон:1:2');
  await act(async () => a.reject(trpcError('FORBIDDEN', 'Причина отказа A')));
  await screen.findByText('B канон:0:2');
  expect(screen.getByLabelText('list')).toHaveTextContent('B канон');
  expect(useToastStore.getState().toasts.some(({ title }) => title === 'Причина отказа A')).toBe(
    true,
  );
});

it('shows a batch immediately and restores both consumers after a structured refusal', async () => {
  const pending = deferred<unknown>();
  const view = renderWithProviders(
    <View />,
    (path) => {
      if (path === 'entity.get') return { entity: row };
      if (path === 'entity.query') return queryReply([row]);
      if (path === 'entity.updateBatch') return pending.promise;
      return {};
    },
    { freshness: true },
  );
  await screen.findByText('Сервер:0:1');
  fireEvent.click(screen.getByRole('button', { name: 'Batch' }));
  await screen.findByText('Пакет:0:1');
  expect(screen.getByLabelText('list')).toHaveTextContent('Пакет');
  await act(async () => pending.reject(trpcError('FORBIDDEN', 'Недоступно')));
  await screen.findByText('Сервер:0:1');
  expect(screen.getByLabelText('list')).toHaveTextContent('Сервер');
  expect(view.calls.filter(({ path }) => path === 'entity.updateBatch')).toHaveLength(1);
});

it('refuses ordinary offline single and batch edits immediately without queueing or projecting', async () => {
  const view = renderWithProviders(
    <View />,
    (path) => {
      if (path === 'entity.get') return { entity: row };
      if (path === 'entity.query') return queryReply([row]);
      return {};
    },
    { freshness: true },
  );
  await screen.findByText('Сервер:0:1');
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'A' }));
  fireEvent.click(screen.getByRole('button', { name: 'Batch' }));
  await waitFor(() =>
    expect(view.queryClient.getMutationCache().getAll()[0]?.state.status).toBe('error'),
  );
  expect(view.calls.some(({ path }) => path.startsWith('entity.update'))).toBe(false);
  expect(screen.getByLabelText('detail')).toHaveTextContent('Сервер:0:1');
});

it('renders live record fields in chat without changing historical card payload or action labels', async () => {
  const pending = deferred<unknown>();
  const card = {
    kind: 'entity_card',
    entityId,
    title: 'История карточки',
    aspects: [],
    keyFields: { first: -1 },
  };
  const first = {
    id: 'message',
    threadId: 'thread',
    content: 'Исходный текст',
    role: 'assistant',
    createdAt: '2026-11-01T00:00:00Z',
    metadata: { cards: [card] },
  };
  const journal = {
    ...first,
    id: 'journal',
    metadata: {
      cards: [{ ...card, title: 'История действия' }],
      journal: { title: 'История действия' },
    },
  };
  const messages = [first, journal];
  function Chat() {
    const query = trpc.chat.listMessages.useQuery({ threadId: 'thread' });
    return (
      <>
        <View />
        <section aria-label="chat">
          {query.data?.map((message) => (
            <div key={message.id}>{renderCardBodies(message)}</div>
          ))}
        </section>
      </>
    );
  }
  const view = renderWithProviders(
    <Chat />,
    (path) => {
      if (path === 'entity.get') return { entity: row };
      if (path === 'entity.query') return queryReply([row]);
      if (path === 'chat.listMessages') return messages;
      if (path === 'entity.update') return pending.promise;
      return {};
    },
    { freshness: true },
  );
  const chat = within(await screen.findByLabelText('chat'));
  await chat.findByRole('button', { name: 'Сервер' });
  expect(chat.getByRole('button', { name: 'История действия' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'A' }));
  await chat.findByRole('button', { name: 'A' });
  expect(chat.getByRole('button', { name: 'История действия' })).toBeInTheDocument();
  const key = hashKey(getQueryKey(trpc.chat.listMessages, { threadId: 'thread' }, 'query'));
  expect(testFreshnessOf(view.queryClient).runtime.publicationOf(key)?.raw).toBe(messages);
  expect(first.metadata.cards[0]).toEqual(card);
  expect(first.content).toBe('Исходный текст');
  await act(async () => pending.reject(trpcError('BAD_REQUEST', 'Отклонено')));
  await chat.findByRole('button', { name: 'Сервер' });
});

it('takes Undo from a new server read while keeping an unrelated edit in flight', async () => {
  const pending = deferred<unknown>();
  let current = row;
  function WithUndo() {
    const update = useEntityUpdate(entityId).mutation;
    return (
      <>
        <View />
        <button type="button" onClick={() => update.mutate({ id: entityId, props: { first: 1 } })}>
          Свойство
        </button>
        <button type="button" onClick={() => void runUndo('batch-action', { entityIds: [] })}>
          Undo
        </button>
      </>
    );
  }
  const view = renderWithProviders(
    <WithUndo />,
    (path) => {
      if (path === 'entity.get') return { entity: current };
      if (path === 'entity.query') return queryReply([current]);
      if (path === 'entity.update') return pending.promise;
      if (path === 'entity.updateBatch') {
        current = { ...row, title: 'Пакет' };
        return { actionId: 'batch-action', consequences: true, results: [] };
      }
      if (path === 'ai.undo') {
        current = row;
        return {
          actionId: 'undo',
          undone: { id: 'batch-action', title: 'Пакет' },
          pinnedVersions: [],
          bodyRevisions: [],
        };
      }
      return {};
    },
    { freshness: true },
  );
  await screen.findByText('Сервер:0:1');
  fireEvent.click(screen.getByRole('button', { name: 'Batch' }));
  await screen.findByText('Пакет:0:1');
  fireEvent.click(screen.getByRole('button', { name: 'Свойство' }));
  await screen.findByText('Пакет:1:1');
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(view.calls.filter(({ path }) => path === 'ai.undo')).toHaveLength(1));
  act(() => testFreshnessOf(view.queryClient).changes([{ kind: 'entity', rowKey: entityId }]));
  await screen.findByText('Сервер:1:1');
  await act(async () => pending.reject(trpcError('BAD_REQUEST', 'Отклонено')));
  await screen.findByText('Сервер:0:1');
});

it('keeps the active layer when cancellation reverts TanStack to the pre-fetch display', async () => {
  const pending = deferred<unknown>();
  const heldRead = deferred<unknown>();
  let hold = false;
  const view = renderWithProviders(
    <View />,
    (path) => {
      if (path === 'entity.get') return hold ? heldRead.promise : { entity: row };
      if (path === 'entity.query') return queryReply([row]);
      if (path === 'entity.update') return pending.promise;
      return {};
    },
    { freshness: true },
  );
  await screen.findByText('Сервер:0:1');
  hold = true;
  act(() => {
    void view.queryClient.refetchQueries({ queryKey: detailKey });
  });
  await waitFor(() =>
    expect(view.calls.filter(({ path }) => path === 'entity.get')).toHaveLength(2),
  );
  fireEvent.click(screen.getByRole('button', { name: 'A' }));
  await screen.findByText('A:1:1');
  await act(async () => view.queryClient.cancelQueries({ queryKey: detailKey }));
  expect(screen.getByLabelText('detail')).toHaveTextContent('A:1:1');
  hold = false;
  heldRead.resolve({ entity: row });
  await act(async () => pending.reject(trpcError('BAD_REQUEST', 'Отклонено')));
  await screen.findByText('Сервер:0:1');
});

it.each([
  'after reset',
  'in the reset turn',
  'before reset',
] as const)('keeps the server base when a pending refetch is cancelled %s', async (order) => {
  const heldRead = deferred<unknown>();
  const pendingEdit = deferred<unknown>();
  const bodyDoc = { type: 'doc', content: [] };
  const base = { entity: { ...row, bodyDoc, bodyRevision: 2 } };
  let detailCalls = 0;
  const view = renderWithProviders(
    <View />,
    (path) => {
      if (path === 'entity.get') return ++detailCalls === 1 ? base : heldRead.promise;
      if (path === 'entity.query') return queryReply([row]);
      if (path === 'entity.update') return pendingEdit.promise;
      return {};
    },
    { freshness: true },
  );
  const { queryClient } = view;
  const { reset, runtime } = testFreshnessOf(queryClient);
  const state = () => queryClient.getQueryState<typeof base>(detailKey);
  const cancel = () => queryClient.cancelQueries({ queryKey: detailKey, exact: true });
  const read = () => {
    void queryClient.refetchQueries({ queryKey: detailKey, exact: true });
  };

  await screen.findByText('Сервер:0:2');
  const original = runtime.publicationOf(hashKey(detailKey));
  if (original?.source !== 'network') throw new Error('Expected a network publication');
  const age = state()?.dataUpdatedAt;
  const shownBody = state()?.data?.entity.bodyDoc;
  fireEvent.click(screen.getByRole('button', { name: 'B' }));
  await screen.findByText('B:0:2');
  if (order === 'in the reset turn') {
    await act(async () => {
      read();
      expect(state()?.fetchStatus).toBe('fetching');
      reset();
      await cancel();
    });
  } else {
    act(read);
    await waitFor(() => expect(detailCalls).toBe(2));
    if (order === 'before reset') {
      await act(cancel);
      expect(state()?.data?.entity.title).toBe('B');
      act(reset);
    } else {
      act(reset);
      expect(state()?.data?.entity.title).toBe(row.title);
      await act(cancel);
    }
  }

  expect(state()).toMatchObject({
    data: base,
    dataUpdatedAt: age,
    status: 'success',
    error: null,
    isInvalidated: true,
  });
  expect(state()?.data?.entity.bodyDoc).toBe(shownBody);
  expect(runtime.publicationOf(hashKey(detailKey))).toBe(original);
  expect(runtime.isAcceptedRead(original)).toBe(false);
});

it.each([
  'removed query',
  'disposed runtime',
] as const)('does not publish a cancelled read from a %s', async (retired) => {
  const heldRead = deferred<unknown>();
  let detailCalls = 0;
  const view = renderWithProviders(
    <View />,
    (path) => {
      if (path === 'entity.get') return ++detailCalls === 1 ? { entity: row } : heldRead.promise;
      if (path === 'entity.query') return queryReply([row]);
      return {};
    },
    { freshness: true },
  );
  const { queryClient } = view;
  const { reset, runtime } = testFreshnessOf(queryClient);
  const key = { queryKey: detailKey, exact: true };
  const hash = hashKey(detailKey);
  await screen.findByText('Сервер:0:1');
  let refetch: Promise<void> | undefined;
  act(() => {
    refetch = queryClient.refetchQueries(key);
  });
  await waitFor(() => expect(detailCalls).toBe(2));
  act(reset);
  await act(async () => {
    if (retired === 'removed query') queryClient.removeQueries(key);
    else runtime.dispose();
    await queryClient.cancelQueries(key);
    const replacement = { entity: { ...row, title: 'Другой снимок' } };
    queryClient.setQueryData(detailKey, replacement);
    heldRead.resolve({ entity: { ...row, title: 'Старый ответ' } });
    await refetch;
    expect(queryClient.getQueryData(detailKey)).toEqual(replacement);
  });
  expect(runtime.publicationOf(hash)).toBeUndefined();
});

it('reconciles a panel against the targeted raw read while another edit is visible', async () => {
  const pending = deferred<unknown>();
  function WithPanel() {
    const panel = usePanelCommands();
    const [result, setResult] = useState('');
    return (
      <>
        <View />
        <button
          type="button"
          onClick={() =>
            void panel
              .reconcile({
                kind: 'values',
                entityId,
                patch: { props: { first: 1 } },
              })
              .then(setResult)
          }
        >
          Проверить состояние
        </button>
        <output aria-label="reconcile">{result}</output>
      </>
    );
  }
  renderWithProviders(
    <WithPanel />,
    (path) => {
      if (path === 'entity.get') return { entity: row };
      if (path === 'entity.query') return queryReply([row]);
      if (path === 'entity.update') return pending.promise;
      return {};
    },
    { freshness: true },
  );
  await screen.findByText('Сервер:0:1');
  fireEvent.click(screen.getByRole('button', { name: 'A' }));
  await screen.findByText('A:1:1');
  fireEvent.click(screen.getByRole('button', { name: 'Проверить состояние' }));
  await screen.findByText('differs');
  expect(screen.getByLabelText('detail')).toHaveTextContent('A:1:1');
  await act(async () => pending.reject(trpcError('BAD_REQUEST', 'Отклонено')));
});

it('keeps the batch Undo and single journal acknowledgment after a same-scope overflow', async () => {
  const batchAck = deferred<unknown>();
  const singleAck = deferred<unknown>();
  const directAck = deferred<unknown>();
  function Commands() {
    const single = useEntityUpdate(entityId).mutation;
    const direct = useEntityMetadataUpdate();
    const run = useUpdateBatch();
    return (
      <>
        <button type="button" onClick={() => single.mutate({ id: entityId, props: { first: 1 } })}>
          Свойство
        </button>
        <button type="button" onClick={() => direct.mutate({ id: entityId, archived: false })}>
          Возврат
        </button>
        <button
          type="button"
          onClick={() =>
            void run(
              [{ tool: 'entity_update', input: { id: entityId, archived: true } }],
              'Пачка записана',
            )
          }
        >
          Архив
        </button>
        <Toaster />
      </>
    );
  }
  const view = renderWithProviders(
    <Commands />,
    (path, input) => {
      if (path === 'entity.update')
        return Object.hasOwn(input as object, 'archived') ? directAck.promise : singleAck.promise;
      if (path === 'entity.updateBatch') return batchAck.promise;
      if (path === 'ai.undo')
        return {
          actionId: 'undo',
          undone: { id: 'batch-action', title: 'Архив' },
          pinnedVersions: [],
          bodyRevisions: [],
        };
      return {};
    },
    { freshness: true },
  );

  fireEvent.click(screen.getByRole('button', { name: 'Свойство' }));
  fireEvent.click(screen.getByRole('button', { name: 'Возврат' }));
  fireEvent.click(screen.getByRole('button', { name: 'Архив' }));
  await waitFor(() =>
    expect(view.calls.filter(({ path }) => path.startsWith('entity.update'))).toHaveLength(3),
  );
  act(() => testFreshnessOf(view.queryClient).reset());
  await act(async () => {
    singleAck.resolve({ ...row, actionId: 'single-action', consequences: false, txId: '3' });
  });
  await waitFor(() => expect(peekUndoable()?.actionId).toBe('single-action'));
  await act(async () => {
    batchAck.resolve({ actionId: 'batch-action', consequences: true, results: [] });
    directAck.reject(trpcError('BAD_REQUEST', 'Отказ после переподключения'));
  });
  expect(await screen.findByText('Отказ после переподключения')).toBeInTheDocument();
  const undo = await screen.findByRole('button', { name: 'Отменить' });
  fireEvent.click(undo);
  await waitFor(() =>
    expect(view.calls.find(({ path }) => path === 'ai.undo')?.input).toEqual({
      actionId: 'batch-action',
    }),
  );
});

it('keeps a visible Inbox row until server classification changes', async () => {
  const ack = deferred<unknown>();
  let server = { ...row, title: 'Входящая запись', tags: [], archived: false };
  const view = renderWithProviders(
    <Inbox onOpen={() => {}} />,
    (path) => {
      if (path === 'entity.query') return queryReply([server]);
      if (path === 'entity.updateBatch') return ack.promise;
      return registryReply(path) ?? [];
    },
    { freshness: true },
  );
  const article = await screen.findByRole('article', { name: server.title });
  fireEvent.click(within(article).getByRole('button', { name: 'В архив' }));
  await waitFor(() =>
    expect(view.calls.some(({ path }) => path === 'entity.updateBatch')).toBe(true),
  );
  expect(article).toBeInTheDocument();
  await act(async () => {
    server = { ...server, archived: true };
    ack.resolve({ actionId: 'archived', consequences: false, results: [] });
  });
  await waitFor(() => expect(article).not.toBeInTheDocument());
});

it('adds and removes the historical assistant echo as the same live card changes', async () => {
  const pending = deferred<unknown>();
  const message = {
    id: 'message',
    threadId: 'thread',
    content: row.title,
    role: 'assistant' as const,
    createdAt: '2026-11-01T00:00:00Z',
    metadata: {
      cards: [{ kind: 'entity_card', entityId, title: row.title, aspects: [], keyFields: {} }],
    },
  };
  renderWithProviders(
    <>
      <View />
      <MessageList messages={[message]} isTyping={false} />
    </>,
    (path) => {
      if (path === 'entity.get') return { entity: row };
      if (path === 'entity.query') return queryReply([row]);
      if (path === 'entity.update') return pending.promise;
      return {};
    },
    { freshness: true },
  );
  const thread = within(screen.getByTestId('message-list'));
  await thread.findByRole('button', { name: row.title });
  expect(thread.getAllByText(row.title)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'A' }));
  await thread.findByRole('button', { name: 'A' });
  expect(thread.getByText(row.title)).toBeInTheDocument();
  await act(async () => pending.reject(trpcError('BAD_REQUEST', 'Отказ')));
  await thread.findByRole('button', { name: row.title });
  expect(thread.getAllByText(row.title)).toHaveLength(1);
});

it('starts a trailing refresh after a pre-ACK list attempt first introduces the edited record', async () => {
  const earlier = deferred<unknown>();
  const trailing = deferred<unknown>();
  const ack = deferred<unknown>();
  const listKey = getQueryKey(trpc.entity.query, listInput, 'query');
  const canonical = { ...row, title: 'Канон' };
  let current = row;
  let listCalls = 0;
  const view = renderWithProviders(
    <View />,
    (path) => {
      if (path === 'entity.get') return { entity: current };
      if (path === 'entity.query') {
        listCalls += 1;
        if (listCalls === 1) return queryReply([{ ...row, id: 'neighbor', title: 'Сосед' }]);
        return listCalls === 2 ? earlier.promise : trailing.promise;
      }
      if (path === 'entity.update') return ack.promise;
      return {};
    },
    { freshness: true },
  );
  await screen.findByText('Сосед');
  let attempt: Promise<void> | undefined;
  act(() => {
    attempt = view.queryClient.refetchQueries({ queryKey: listKey });
  });
  await waitFor(() => expect(listCalls).toBe(2));
  fireEvent.click(screen.getByRole('button', { name: 'B' }));
  await screen.findByText('B:0:1');
  await act(async () => {
    current = canonical;
    ack.resolve({ ...canonical, txId: '7' });
  });
  await screen.findByText('Канон:0:1');
  expect(listCalls).toBe(2);
  await act(async () => {
    earlier.resolve(queryReply([row]));
    await attempt;
  });
  expect(
    view.queryClient.getQueryData<{ rows: { title: string }[] }>(listKey)?.rows[0]?.title,
  ).toBe('B');
  await waitFor(() => expect(screen.getByLabelText('list')).toHaveTextContent('B'));
  await waitFor(() => expect(listCalls).toBe(3));
  await act(async () => trailing.resolve(queryReply([canonical])));
  await waitFor(() => expect(screen.getByLabelText('list')).toHaveTextContent('Канон'));
});
