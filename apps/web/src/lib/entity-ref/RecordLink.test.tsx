import { currentEntry, HOST_APP, initialModel } from '@orbis/shared/nav';
import { useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { warmDetailScreen } from '../../app/detail-screen-loader';
import { FrameAppContext } from '../../app/frame/FrameApp';
import { HOST_HOME, useNav } from '../../state/navigation';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { PrivacyActionsContext } from '../local-data/privacy-actions';
import type { CreateAttempt } from '../optimistic/create-intents';
import { createIntentsOf } from '../optimistic/use-create-intent';
import { RecordLink } from './RecordLink';
import { useRecordLinkController } from './record-link-controller';

const id = '018cd857-511b-7f25-870e-377777ceca00';
const app = '018cd857-511b-7f25-870e-377777ceca01';
vi.mock('../../app/detail-screen-loader', () => ({ warmDetailScreen: vi.fn() }));
const read = vi.fn(() => new Promise(() => {}));

beforeEach(() => {
  read.mockClear();
  vi.mocked(warmDetailScreen).mockClear();
  useNav.setState({
    model: initialModel(HOST_HOME),
    overlay: null,
    pendingCreate: null,
    pendingCreateOpen: null,
  });
});
afterEach(() => vi.useRealTimers());

test('native modified click keeps the real href and keyboard activation opens the frame record', () => {
  renderWithProviders(
    <FrameAppContext.Provider value={{ app, via: 'content' }}>
      <RecordLink id={id} href={`/r/${id}`}>
        Record
      </RecordLink>
    </FrameAppContext.Provider>,
    read,
    { freshness: true },
  );
  const link = screen.getByRole('link', { name: 'Record' });
  expect(link.getAttribute('href')).toBe(`/r/${id}`);
  const modified = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
  let native = false;
  const stopJsdomNavigation = (event: MouseEvent) => {
    native = !event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener('click', stopJsdomNavigation, { once: true });
  fireEvent(link, modified);
  expect(native).toBe(true);
  expect(currentEntry(useNav.getState().model).address).toEqual(HOST_HOME);
  expect(fireEvent.click(link, { detail: 0 })).toBe(false);
  expect(currentEntry(useNav.getState().model).address).toEqual({
    kind: 'record',
    app: { kind: 'app', ref: app },
    id,
  });
});

test('custom open can defer the common transition, and ephemeral records skip speculative GET', () => {
  let open: (() => void) | undefined;
  renderWithProviders(
    <RecordLink
      id={id}
      pending
      onOpen={(_id, proceed) => {
        open = proceed;
      }}
    >
      Pending
    </RecordLink>,
    read,
    { freshness: true },
  );
  const button = screen.getByRole('button', { name: 'Pending' });
  fireEvent.focus(button);
  fireEvent.pointerDown(button, { pointerType: 'touch', pointerId: 1, button: 0 });
  fireEvent.click(button);
  expect(read).not.toHaveBeenCalled();
  expect(currentEntry(useNav.getState().model).address).toEqual(HOST_HOME);
  open?.();
  expect(useNav.getState().model.activeApp).toBe(HOST_APP);
  expect(currentEntry(useNav.getState().model).address).toEqual(HOST_HOME);
  expect(useNav.getState().pendingCreate).toBe(id);
});

test.each([
  'move',
  'cancel',
] as const)('touch starts immediately; %s aborts only its speculation', (kind) => {
  const { queryClient } = renderWithProviders(<RecordLink id={id}>Record</RecordLink>, read, {
    freshness: true,
  });
  const link = screen.getByRole('link');
  fireEvent.pointerDown(link, { pointerType: 'touch', pointerId: 1, button: 0, clientX: 10 });
  expect(read).toHaveBeenCalledTimes(1);
  const detail = queryClient
    .getQueryCache()
    .getAll()
    .find((query) => query.state.fetchStatus === 'fetching');
  expect(detail).toBeDefined();
  if (kind === 'move') {
    fireEvent.pointerMove(link, { pointerType: 'touch', pointerId: 1, clientX: 18 });
    expect(detail?.state.fetchStatus).toBe('fetching');
    fireEvent.pointerMove(link, { pointerType: 'touch', pointerId: 1, clientX: 19 });
  } else {
    fireEvent.pointerCancel(link, { pointerType: 'touch', pointerId: 1 });
  }
  expect(detail?.state.fetchStatus).toBe('idle');
});

test('touch pointerout after pointerup keeps the request available for the delayed native click', () => {
  const { queryClient } = renderWithProviders(<RecordLink id={id}>Record</RecordLink>, read, {
    freshness: true,
  });
  const link = screen.getByRole('link');
  const pointer = { pointerType: 'touch', pointerId: 1, button: 0 };
  fireEvent.pointerDown(link, pointer);
  const detail = queryClient
    .getQueryCache()
    .getAll()
    .find((query) => query.state.fetchStatus === 'fetching');
  expect(detail).toBeDefined();
  fireEvent.pointerUp(link, pointer);
  fireEvent.pointerOut(link, pointer);
  fireEvent.click(link);
  expect(detail?.state.fetchStatus).toBe('fetching');
  expect(currentEntry(useNav.getState().model).address).toMatchObject({ kind: 'record', id });
});

function WithCreate({ children }: { children: (attempt: CreateAttempt) => ReactNode }) {
  const registry = createIntentsOf(useQueryClient());
  const [attempt] = useState(() =>
    registry.begin({
      origin: 'capture',
      draftIdentity: 'row',
      command: { source: 'quick_capture', input: { title: 'Draft', tags: [] } },
    }),
  );
  if (!attempt) throw new Error('Failed to begin create');
  return children(attempt);
}

test('imperative adapters can open a pending record without starting data or code speculation', () => {
  function Adapter({ id }: { id: string }) {
    const { open, prepare } = useRecordLinkController();
    return (
      <button
        type="button"
        onClick={() => {
          prepare(id, 'selection');
          open(id);
        }}
      >
        Open pending
      </button>
    );
  }
  const { queryClient } = renderWithProviders(
    <WithCreate>{({ id }) => <Adapter id={id} />}</WithCreate>,
    read,
    { freshness: true },
  );
  const id = createIntentsOf(queryClient).getSnapshot()[0]?.id;
  expect(id).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Open pending' }));
  expect(read).not.toHaveBeenCalled();
  expect(warmDetailScreen).not.toHaveBeenCalled();
  expect(currentEntry(useNav.getState().model).address).toEqual(HOST_HOME);
  expect(useNav.getState().pendingCreate).toBe(id);
});

test('keyboard focus prepares the record and Enter adopts the request', async () => {
  const user = userEvent.setup();
  renderWithProviders(<RecordLink id={id}>Record</RecordLink>, read, { freshness: true });
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Record' }));
  expect(read).toHaveBeenCalledTimes(1);
  await user.keyboard('{Enter}');
  expect(currentEntry(useNav.getState().model).address).toMatchObject({ kind: 'record', id });
  expect(read).toHaveBeenCalledTimes(1);
});

test('the scoped UUID switches from button to native link only after ACK', () => {
  let attempt: CreateAttempt | undefined;
  const { queryClient } = renderWithProviders(
    <WithCreate>
      {(created) => {
        attempt = created;
        return <RecordLink id={created.id}>Draft</RecordLink>;
      }}
    </WithCreate>,
    read,
    { freshness: true },
  );
  const registry = createIntentsOf(queryClient);
  const created = attempt;
  if (!created) throw new Error('Failed to begin create');
  const pending = screen.getByRole('button', { name: 'Draft' });
  expect(pending.getAttribute('href')).toBeNull();
  fireEvent.focus(pending);
  fireEvent.pointerDown(pending, { pointerType: 'touch', pointerId: 1, button: 0 });
  fireEvent.click(pending);
  expect(useNav.getState().pendingCreate).toBe(created.id);
  expect(currentEntry(useNav.getState().model).address).toEqual(HOST_HOME);
  expect(read).not.toHaveBeenCalled();
  expect(warmDetailScreen).not.toHaveBeenCalled();

  act(() => {
    registry.settle(created, {
      kind: 'ack',
      result: {
        ...wireEntity({ id: created.id, graphId: 'owner', title: 'Draft' }),
        bodyChangedAt: '2026-11-03T00:00:00.000Z',
        bodyRevision: 1,
      },
    });
  });
  const link = screen.getByRole('link', { name: 'Draft' });
  expect(link.getAttribute('href')).toBe(`/r/${created.id}`);
  fireEvent.focus(link);
  expect(read).toHaveBeenCalledTimes(1);
  expect(warmDetailScreen).toHaveBeenCalledTimes(1);
});

test.each([
  'explicit app',
  'close before ACK',
  'open again in another app',
] as const)('pending destination and ACK respect %s', (scenario) => {
  const anotherApp = '018cd857-511b-7f25-870e-377777ceca02';
  const { queryClient } = renderWithProviders(
    <WithCreate>
      {({ id }) => (
        <>
          <RecordLink id={id} app={app}>
            First app
          </RecordLink>
          <RecordLink id={id} app={anotherApp}>
            Another app
          </RecordLink>
        </>
      )}
    </WithCreate>,
    read,
    { freshness: true },
  );
  const registry = createIntentsOf(queryClient);
  const id = registry.getSnapshot()[0]?.id;
  if (!id) throw new Error('Failed to begin create');
  const model = useNav.getState().model;
  const url = location.href;
  const historyLength = history.length;
  fireEvent.click(screen.getByRole('button', { name: 'First app' }));
  expect(useNav.getState().pendingCreate).toBe(id);
  if (scenario !== 'explicit app') {
    act(() => useNav.getState().back());
    expect(useNav.getState().pendingCreate).toBeNull();
  }
  if (scenario === 'open again in another app') {
    fireEvent.click(screen.getByRole('button', { name: 'Another app' }));
    expect(useNav.getState().pendingCreate).toBe(id);
  }
  expect(useNav.getState().model).toBe(model);
  expect(location.href).toBe(url);
  expect(history.length).toBe(historyLength);
  expect(read).not.toHaveBeenCalled();
  act(() => useNav.getState().confirmPendingCreate(id));
  const address = currentEntry(useNav.getState().model).address;
  expect(address).toEqual(
    scenario === 'close before ACK'
      ? HOST_HOME
      : {
          kind: 'record',
          id,
          app: { kind: 'app', ref: scenario === 'explicit app' ? app : anotherApp },
        },
  );
  expect(useNav.getState().pendingCreate).toBeNull();
});

test('shared record links keep in-app keyboard and pointer activation without a native address', async () => {
  const user = userEvent.setup();
  const privacy = {
    shared: true,
    scope: { accountId: 'owner', graphId: 'owner', epoch: 0 },
    canSeed: false,
    logout() {},
    toggleShared() {},
    graphSeeded() {},
  };
  let setShared: (shared: boolean) => void = () => {};
  function Fixture() {
    const [shared, change] = useState(false);
    setShared = change;
    return (
      <PrivacyActionsContext.Provider value={{ ...privacy, shared }}>
        <RecordLink id={id} href={`/entity/${id}#source`} target="_blank" download>
          Shared record
        </RecordLink>
      </PrivacyActionsContext.Provider>
    );
  }
  const { queryClient } = renderWithProviders(<Fixture />, read, { freshness: true });
  const link = screen.getByRole('link', { name: 'Shared record' });
  expect(link).toHaveAttribute('href', `/entity/${id}#source`);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('download');
  act(() => setShared(true));
  expect(link).not.toHaveAttribute('href');
  expect(link).not.toHaveAttribute('target');
  expect(link).not.toHaveAttribute('download');
  fireEvent.pointerDown(link, { pointerType: 'touch', pointerId: 1, button: 0 });
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.pointerCancel(link, { pointerType: 'touch', pointerId: 1 });
  expect(queryClient.isFetching()).toBe(0);
  fireEvent.click(link, { metaKey: true });
  fireEvent(link, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(currentEntry(useNav.getState().model).address).toEqual(HOST_HOME);
  await user.tab();
  expect(link).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(currentEntry(useNav.getState().model).address).toMatchObject({ kind: 'record', id });
  act(() => useNav.setState({ model: initialModel(HOST_HOME) }));
  fireEvent.click(link);
  expect(currentEntry(useNav.getState().model).address).toMatchObject({ kind: 'record', id });
  act(() => setShared(false));
  expect(link).toHaveAttribute('href', `/entity/${id}#source`);
  expect(link).toHaveAttribute('target', '_blank');
});
