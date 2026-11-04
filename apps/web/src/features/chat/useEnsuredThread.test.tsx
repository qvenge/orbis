import { hashKey } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { bindQueryResponses } from '../../lib/local-data/query-responses';
import { testFreshnessOf } from '../../test/freshness';
import { renderWithProviders } from '../../test/harness';
import { trpc } from '../../trpc';
import { resetUndoSession } from '../undo/undo-epoch';
import { useEnsuredThread } from './useEnsuredThread';

/**
 * Пробник МЕНЯЕТ `entityId` у живого хука — то есть делает ровно то, чего сегодняшние
 * вызывающие не делают: `EntityThreadTab` монтируют с `key` по id записи (DetailScreen), и там
 * смена записи — всегда новый экземпляр. Хук, однако, экспортирован и общий, и вызывающий без
 * `key` появится раньше, чем о нём вспомнят; молча отдать ему тред ЧУЖОЙ записи (сообщения
 * уехали бы не туда) — цена, которой у общего хука быть не должно.
 */
function EnsureProbe() {
  const [entityId, setEntityId] = useState('e1');
  const { state } = useEnsuredThread(entityId);
  return (
    <div>
      <button type="button" onClick={() => setEntityId('e2')}>
        на e2
      </button>
      <span data-testid="probe">{state.status === 'ready' ? state.threadId : state.status}</span>
    </div>
  );
}

const threadOf = (input: unknown) => ({
  threadId: `th-${(input as { entityId: string }).entityId}`,
  messages: [],
});

test('смена записи без key: хук заводит тред НОВОЙ записи, а не отдаёт чужой', async () => {
  const { calls } = renderWithProviders(<EnsureProbe />, (path, input) => {
    if (path === 'chat.openThread') return threadOf(input);
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('th-e1'));

  fireEvent.click(screen.getByRole('button', { name: 'на e2' }));

  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('th-e2'));
  expect(calls.filter((c) => c.path === 'chat.openThread').map((c) => c.input)).toEqual([
    { entityId: 'e1' },
    { entityId: 'e2' },
  ]);
});

test('поздний ответ ПРЕЖНЕЙ записи состояние новой не затирает', async () => {
  // Отложенные ответы — массивом, а не переменной: `let x: F | null = null`, присвоенная внутри
  // замыкания, сужается компилятором до `null` и на вызове даёт `never` (проверено tsc).
  const releaseE1: ((v: { threadId: string; messages: [] }) => void)[] = [];
  renderWithProviders(<EnsureProbe />, (path, input) => {
    if (path !== 'chat.openThread') throw new Error(`unexpected ${path}`);
    if ((input as { entityId: string }).entityId === 'e1')
      return new Promise<{ threadId: string; messages: [] }>((resolve) => {
        releaseE1.push(resolve);
      });
    return threadOf(input);
  });

  // Ответ по e1 ещё в полёте — уходим на e2 и дожидаемся ЕГО треда.
  await waitFor(() => expect(releaseE1).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'на e2' }));
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('th-e2'));

  // …и только теперь отвечает e1. Это ответ на вопрос, который больше не задан.
  await act(async () => {
    releaseE1[0]?.({ threadId: 'th-e1', messages: [] });
  });
  expect(screen.getByTestId('probe')).toHaveTextContent('th-e2');
  // И по e1 никто ничего не переспрашивал: поздний ответ ОТБРОШЕН, а не превращён в новый
  // запрос (в кеш он при этом лёг — под id, для которого спрашивали).
  expect(releaseE1).toHaveLength(1);
});

// Под StrictMode React прогоняет и рендер, и эффекты монтирования ДВАЖДЫ — а состояние здесь
// правится прямо в рендере (штатный приём «adjusting state on prop change»). У ошибки в таком
// приёме ровно два исхода, и оба видны отсюда: лишняя мутация на второй прогон эффекта либо
// «Too many re-renders» (React бросает из рендера, и renderWithProviders падает вместе с ним).
test('смена записи под StrictMode: ровно две мутации, по одной на запись', async () => {
  const { calls } = renderWithProviders(
    <EnsureProbe />,
    (path, input) => {
      if (path === 'chat.openThread') return threadOf(input);
      throw new Error(`unexpected ${path}`);
    },
    { strict: true },
  );
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('th-e1'));

  fireEvent.click(screen.getByRole('button', { name: 'на e2' }));

  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('th-e2'));
  expect(calls.filter((c) => c.path === 'chat.openThread').map((c) => c.input)).toEqual([
    { entityId: 'e1' },
    { entityId: 'e2' },
  ]);
});

function ToggleThread() {
  const [show, setShow] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setShow(!show)}>
        Переключить тред
      </button>
      {show && <EnsureProbe />}
    </>
  );
}

test('open publishes the exact same confirmed operation to both newest keys and binding', async () => {
  const { queryClient } = renderWithProviders(<EnsureProbe />, (_path, input) => threadOf(input), {
    freshness: true,
  });
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('th-e1'));
  const { runtime } = testFreshnessOf(queryClient);
  const publications = [
    ['chatOpen', 'e1'],
    ['chatThread', 'th-e1'],
    getQueryKey(trpc.chat.listMessages, { threadId: 'th-e1', limit: 50 }, 'query'),
  ].map((key) => runtime.publicationOf(hashKey(key)));
  expect(publications).toMatchObject([
    { source: 'network', raw: { threadId: 'th-e1' } },
    { source: 'network', raw: { pages: [[]], pageParams: [undefined] } },
    { source: 'network', raw: [] },
  ]);
  expect(
    publications.map((publication) => publication?.source === 'network' && publication.receipt),
  ).toEqual(
    publications.map(() => publications[0]?.source === 'network' && publications[0].receipt),
  );
});

test('an entity deletion retires a disabled binding even in a coalesced oversized feed batch', async () => {
  const { queryClient, calls } = renderWithProviders(
    <ToggleThread />,
    (_path, input) => threadOf(input),
    {
      freshness: true,
    },
  );
  const feed = testFreshnessOf(queryClient);
  const responses = bindQueryResponses(queryClient, feed.runtime, { enabled: false });
  try {
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('th-e1'));
    const toggle = screen.getByRole('button', { name: 'Переключить тред' });
    fireEvent.click(toggle);
    act(() =>
      feed.changes([{ kind: 'message', rowKey: 'm1', threadId: 'th-e1', entityIds: ['e1'] }]),
    );
    fireEvent.click(toggle);
    expect(screen.getByTestId('probe')).toHaveTextContent('th-e1');
    expect(calls).toHaveLength(1);
    fireEvent.click(toggle);
    act(() =>
      feed.changes([
        ...Array.from({ length: 200 }, (_, i) => ({
          kind: 'entity' as const,
          rowKey: `neighbor-${i}`,
        })),
        { kind: 'entity', rowKey: 'e1', operation: 'delete' },
      ]),
    );
    await waitFor(() => expect(queryClient.getQueryData(['chatOpen', 'e1'])).toBeUndefined());
    fireEvent.click(toggle);
    expect(screen.getByTestId('probe')).toHaveTextContent('failed');
    expect(calls).toHaveLength(1);
  } finally {
    responses.close();
  }
});

test('a POST held across deletion and revival cannot publish its original tail', async () => {
  const finish: ((result: { threadId: string; messages: [] }) => void)[] = [];
  const { queryClient, calls } = renderWithProviders(
    <ToggleThread />,
    () => new Promise((resolve) => finish.push(resolve)),
    { freshness: true },
  );
  const feed = testFreshnessOf(queryClient);
  const responses = bindQueryResponses(queryClient, feed.runtime, { enabled: false });
  try {
    await waitFor(() => expect(finish).toHaveLength(1));
    const toggle = screen.getByRole('button', { name: 'Переключить тред' });
    fireEvent.click(toggle);
    act(() =>
      feed.changes([
        { kind: 'entity', rowKey: 'e1', operation: 'delete' },
        { kind: 'entity', rowKey: 'e1', operation: 'insert' },
      ]),
    );
    await waitFor(() => expect(queryClient.getQueryState(['chatOpen', 'e1'])).toBeUndefined());
    fireEvent.click(toggle);
    await waitFor(() => expect(finish).toHaveLength(2));
    await act(async () => finish[0]?.({ threadId: 'old-thread', messages: [] }));
    expect(queryClient.getQueryData(['chatThread', 'old-thread'])).toBeUndefined();
    expect(screen.getByTestId('probe')).toHaveTextContent('pending');
    await act(async () => finish[1]?.({ threadId: 'new-thread', messages: [] }));
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('new-thread'));
    expect(calls).toHaveLength(2);
  } finally {
    responses.close();
  }
});

test('a late response after the owner epoch changes cannot fill either query cache', async () => {
  const finish: ((result: { threadId: string; messages: [] }) => void)[] = [];
  const { queryClient } = renderWithProviders(
    <ToggleThread />,
    () => new Promise((resolve) => finish.push(resolve)),
  );
  await waitFor(() => expect(finish).toHaveLength(1));
  const toggle = screen.getByRole('button', { name: 'Переключить тред' });
  fireEvent.click(toggle);
  act(() => {
    resetUndoSession();
    queryClient.clear();
  });
  fireEvent.click(toggle);
  await waitFor(() => expect(finish).toHaveLength(2));
  await act(async () => finish[0]?.({ threadId: 'old-owner', messages: [] }));
  expect(queryClient.getQueryData(['chatThread', 'old-owner'])).toBeUndefined();
  expect(
    queryClient.getQueryData(
      getQueryKey(trpc.chat.listMessages, { threadId: 'old-owner', limit: 50 }, 'query'),
    ),
  ).toBeUndefined();
  await act(async () => finish[1]?.({ threadId: 'new-owner', messages: [] }));
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('new-owner'));
});

test('active pending binding reopens on reset and discards old response', async () => {
  const finish: ((result: { threadId: string; messages: [] }) => void)[] = [];
  const { queryClient } = renderWithProviders(
    <EnsureProbe />,
    () => new Promise((resolve) => finish.push(resolve)),
    { freshness: true },
  );
  const feed = testFreshnessOf(queryClient);
  const responses = bindQueryResponses(queryClient, feed.runtime, { enabled: false });
  try {
    await waitFor(() => expect(finish).toHaveLength(1));
    act(() => feed.reset());
    await act(async () => finish[0]?.({ threadId: 'old-thread', messages: [] }));
    expect(queryClient.getQueryData(['chatThread', 'old-thread'])).toBeUndefined();
    await waitFor(() => expect(finish).toHaveLength(2));
    await act(async () => finish[1]?.({ threadId: 'new-thread', messages: [] }));
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('new-thread'));
  } finally {
    responses.close();
  }
});

test('successful POST binding is saved when feed passed the read snapshot', async () => {
  const finish: ((result: { threadId: string; messages: [] }) => void)[] = [];
  const writes: unknown[] = [];
  const { queryClient, calls } = renderWithProviders(
    <EnsureProbe />,
    () => new Promise((resolve) => finish.push(resolve)),
    { freshness: true },
  );
  const feed = testFreshnessOf(queryClient);
  feed.runtime.setSinks({
    writeNetwork: (read) => writes.push({ key: read.key, watermark: read.receipt.watermark }),
  });
  await waitFor(() => expect(finish).toHaveLength(1));
  act(() =>
    feed.changes([
      { kind: 'message', rowKey: 'unrelated', threadId: 'other-thread', entityIds: [] },
    ]),
  );
  await act(async () => finish[0]?.({ threadId: 'current-thread', messages: [] }));
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('current-thread'));
  expect(calls).toHaveLength(1);
  expect(writes).toEqual([{ key: ['chatOpen', 'e1'], watermark: '0' }]);
});
