import { onlineManager } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { useEnsuredThread } from '../../features/chat/useEnsuredThread';
import { testFreshnessOf } from '../../test/freshness';
import { renderWithProviders } from '../../test/harness';
import { bindQueryResponses, responseQueryOptions } from './query-responses';

const held = vi.hoisted(() => ({
  release: undefined as ((value: unknown) => void) | undefined,
  removeEntity: vi.fn(),
  writeServerResponse: vi.fn(async () => true),
}));

vi.mock('./response-cache', () => ({
  responseBuster: 'test-buster',
  openResponseCache: (scope: unknown) => ({
    scope,
    capture: () => 'ticket',
    isCurrent: () => true,
    read: () =>
      new Promise((resolve) => {
        held.release = resolve;
      }),
    removeEntity: held.removeEntity,
    writeServerResponse: held.writeServerResponse,
    close() {},
  }),
}));

function Thread() {
  const { state } = useEnsuredThread('entity-a');
  return <div data-testid="place">{state.status === 'ready' ? state.threadId : state.status}</div>;
}

function Probe() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Открыть
      </button>
      {open && <Thread />}
    </>
  );
}

test('a place restore already in flight cannot revive a feed-deleted binding', async () => {
  const { queryClient, calls } = renderWithProviders(<Probe />, () => ({}), {
    freshness: true,
    queries: responseQueryOptions,
  });
  const feed = testFreshnessOf(queryClient);
  const responses = bindQueryResponses(queryClient, feed.runtime, { enabled: true });
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    await waitFor(() => expect(held.release).toBeDefined());
    act(() => feed.changes([{ kind: 'entity', rowKey: 'entity-a', operation: 'delete' }]));
    await waitFor(() => expect(held.removeEntity).toHaveBeenCalledWith('entity-a'));
    await act(async () => held.release?.({ data: { threadId: 'retired' }, receivedAt: 1 }));
    await waitFor(() => expect(screen.getByTestId('place')).toHaveTextContent('failed'));
    expect(queryClient.getQueryData(['chatOpen', 'entity-a'])).toBeUndefined();
    expect(calls).toEqual([]);
  } finally {
    responses.close();
  }
});

function Toggle() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        Toggle
      </button>
      {open && <Thread />}
    </>
  );
}

test('ordinary close after disk miss retains the successful POST binding and tail', async () => {
  held.release = undefined;
  held.writeServerResponse.mockClear();
  let finish: ((result: { threadId: string; messages: [] }) => void) | undefined;
  const { queryClient, calls } = renderWithProviders(
    <Toggle />,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    { freshness: true, queries: responseQueryOptions },
  );
  const responses = bindQueryResponses(queryClient, testFreshnessOf(queryClient).runtime, {
    enabled: true,
  });
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    await waitFor(() => expect(held.release).toBeDefined());
    await act(async () => held.release?.(undefined));
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    await act(async () => finish?.({ threadId: 'retained', messages: [] }));
    expect(queryClient.getQueryData(['chatThread', 'retained'])).toMatchObject({ pages: [[]] });
    expect(queryClient.getQueryData(['chatOpen', 'entity-a'])).toEqual({ threadId: 'retained' });
    expect(held.writeServerResponse).toHaveBeenCalledWith(
      expect.objectContaining({ key: ['chatOpen', 'entity-a'] }),
      { threadId: 'retained' },
      expect.objectContaining({ watermark: '0' }),
    );
    act(() => onlineManager.setOnline(false));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    expect(screen.getByTestId('place')).toHaveTextContent('retained');
    expect(calls).toHaveLength(1);
  } finally {
    act(() => onlineManager.setOnline(true));
    responses.close();
  }
});

test('ordinary close before a disk miss does not start the POST', async () => {
  held.release = undefined;
  const { queryClient, calls } = renderWithProviders(
    <Toggle />,
    () => ({ threadId: 'fresh', messages: [] }),
    { freshness: true, queries: responseQueryOptions },
  );
  const responses = bindQueryResponses(queryClient, testFreshnessOf(queryClient).runtime, {
    enabled: true,
  });
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    await waitFor(() => expect(held.release).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    await act(async () => held.release?.(undefined));
    expect(calls).toEqual([]);
    held.release = undefined;
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    await waitFor(() => expect(held.release).toBeDefined());
    await act(async () => held.release?.(undefined));
    await waitFor(() => expect(screen.getByTestId('place')).toHaveTextContent('fresh'));
    expect(calls).toHaveLength(1);
  } finally {
    responses.close();
  }
});
