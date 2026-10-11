import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../../auth/supabase', () => ({ auth: { signOut: vi.fn() }, useSession: vi.fn() }));
vi.mock('../../auth/LoginScreen', () => ({
  LoginScreen: () => <div data-testid="anon">anon leaf</div>,
}));

import { AuthProvider, getCurrentToken } from '../../auth/AuthProvider';
import { useSession } from '../../auth/supabase';
import { useFastPath } from '../../features/chat/useFastPath';
import { isUndoEpoch, resetUndoSession, undoEpoch } from '../../features/undo/undo-epoch';
import { registerRetrySend, useRetryBuffer, useRetryFlush } from '../../state/retry';
import { renderWithProviders, trpcError, wireEntity } from '../../test/harness';

afterEach(() => {
  cleanup();
  localStorage.clear();
  useRetryBuffer.setState({ size: 0, pending: [], flushing: false });
});
for (const mode of [
  'same_owner',
  'same_owner_token_refresh',
  'direct_owner_switch',
  'logout_unmount_login',
]) {
  test(mode, async () => {
    localStorage.clear();
    const oldOwner = '019a0000-0000-7000-8000-000000000003',
      newOwner = mode.startsWith('same_owner') ? oldOwner : '019a0000-0000-7000-8000-000000000004';
    let token = 'FAKE_OLD';
    vi.mocked(useSession).mockReturnValue({ token, userId: oldOwner, status: 'authed' });
    let oldApi!: ReturnType<typeof useFastPath>,
      reject!: (e: Error) => void,
      submitted!: Promise<void>,
      unmounts = 0;
    const deliveries: Array<{
      op: Parameters<Parameters<typeof registerRetrySend>[0]>[0];
      currentToken: string | null;
      epoch: number;
    }> = [];
    registerRetrySend(async (op) => {
      deliveries.push({ op, currentToken: getCurrentToken(), epoch: undoEpoch() });
      return 'transport_failure';
    });
    function Sender() {
      const api = useFastPath('019a0000-0000-7000-8000-000000000001');
      oldApi = api;
      useRetryFlush();
      useEffect(() => {
        return () => {
          unmounts++;
        };
      }, []);
      return <div data-testid="sender" />;
    }
    const stable = <Sender />;
    function Host() {
      const [, refresh] = useState(0);
      return (
        <>
          <button type="button" onClick={() => refresh((n) => n + 1)}>
            refresh-owner
          </button>
          <AuthProvider>{stable}</AuthProvider>
        </>
      );
    }
    const category = wireEntity({
      id: '019a0000-0000-7000-8000-000000000002',
      title: 'Еда',
      props: { 'orbis/aliases': ['кофе'], 'orbis/spend_class': 'variable' },
      aspects: ['orbis/category'],
    });
    const { calls } = renderWithProviders(<Host />, (path, input) =>
      path === 'entity.query'
        ? (input as { query: string }).query === 'aspect=orbis/category'
          ? [category]
          : []
        : path === 'user.getSettings'
          ? { timezone: 'UTC', defaultCurrency: 'RUB', disabledModules: [] }
          : path === 'entity.create'
            ? new Promise((_resolve, j) => (reject = j))
            : {},
    );
    act(() => {
      submitted = oldApi.submit('кофе 100');
    });
    await waitFor(() => expect(reject).toBeDefined());
    const originalEpoch = undoEpoch();
    const originMutation = calls.find((c) => c.path === 'entity.create');
    expect(originMutation?.input).toMatchObject({
      source: 'fast_path',
      threadId: '019a0000-0000-7000-8000-000000000001',
    });
    if (mode === 'logout_unmount_login') {
      vi.mocked(useSession).mockReturnValue({ token: null, userId: null, status: 'anon' });
      fireEvent.click(screen.getByRole('button', { name: 'refresh-owner' }));
      expect(screen.getByTestId('anon')).toBeTruthy();
      expect(unmounts).toBe(1);
    }
    if (mode !== 'same_owner') {
      token = 'FAKE_CURRENT';
      vi.mocked(useSession).mockReturnValue({ token, userId: newOwner, status: 'authed' });
      fireEvent.click(screen.getByRole('button', { name: 'refresh-owner' }));
    }
    const wasStale = !isUndoEpoch(originalEpoch);
    expect(wasStale).toBe(!mode.startsWith('same_owner'));
    // Fresh current-owner sentinel: exercise append into actual current scope, not empty-key fabrication.
    act(() => {
      useRetryBuffer
        .getState()
        .enqueueCreate(
          { id: '019a0000-0000-7000-8000-000000000005', title: 'current owner sentinel', tags: [] },
          'fast_path',
        );
    });
    const deliveriesBefore = deliveries.length;
    await act(async () => {
      reject(new Error('held network failure'));
      await submitted;
      await useRetryBuffer.getState().flushNow();
    });
    const key = `orbis:retry-buffer:v1:${newOwner}`;
    const disk = JSON.parse(localStorage.getItem(key) ?? '[]');
    const privateRows = disk.filter(
      (q: { payload?: { input?: { title?: string } } }) => q.payload?.input?.title === 'кофе',
    );
    expect(privateRows).toHaveLength(mode.startsWith('same_owner') ? 1 : 0);
    expect(
      disk.some(
        (q: { payload?: { input?: { title?: string } } }) =>
          q.payload?.input?.title === 'current owner sentinel',
      ),
    ).toBe(true);
    if (mode.startsWith('same_owner'))
      expect(privateRows[0].payload.input.props).toMatchObject({
        'orbis/amount': '100.00',
        'orbis/currency': 'RUB',
        'orbis/finance_category': '019a0000-0000-7000-8000-000000000002',
      });
    expect(calls.filter((c) => c.path === 'entity.create')).toHaveLength(1);
    expect(
      deliveries
        .slice(deliveriesBefore)
        .some(
          (d) =>
            (d.op.payload as { input: { title: string } }).input.title === 'кофе' &&
            d.currentToken === token,
        ),
    ).toBe(mode.startsWith('same_owner'));
    if (!mode.startsWith('same_owner'))
      expect(localStorage.getItem(`orbis:retry-buffer:v1:${oldOwner}`)).toBeNull();
  });
}

for (const phase of ['categories', 'settings', 'rules', 'replacement'] as const)
  test(`old owner held ${phase} continuation cannot launch another request`, async () => {
    const owner = '019a0000-0000-7000-8000-000000000003';
    vi.mocked(useSession).mockReturnValue({ token: 'FAKE_OLD', userId: owner, status: 'authed' });
    let api!: ReturnType<typeof useFastPath>,
      release!: (value: unknown) => void,
      promise!: Promise<void>;
    const category = wireEntity({
      id: '019a0000-0000-7000-8000-000000000002',
      title: 'Еда',
      props: { 'orbis/aliases': ['кофе'], 'orbis/spend_class': 'variable' },
      aspects: ['orbis/category'],
    });
    function Sender() {
      api = useFastPath('019a0000-0000-7000-8000-000000000001');
      return null;
    }
    let creates = 0;
    const { calls } = renderWithProviders(
      <AuthProvider>
        <Sender />
      </AuthProvider>,
      (path, input) => {
        if (path === 'entity.query') {
          const cats = (input as { query: string }).query === 'aspect=orbis/category';
          if ((cats && phase === 'categories') || (!cats && phase === 'rules'))
            return new Promise((resolve) => {
              release = resolve;
            });
          return cats ? [category] : [];
        }
        if (path === 'user.getSettings')
          return phase === 'settings'
            ? new Promise((resolve) => {
                release = resolve;
              })
            : { timezone: 'UTC', defaultCurrency: 'RUB' };
        if (path === 'entity.create') {
          creates++;
          if (creates === 1 && phase === 'replacement') throw trpcError('CONFLICT', 'occupied ID');
          if (phase === 'replacement')
            return new Promise((resolve) => {
              release = resolve;
            });
          return wireEntity({ id: '019a0000-0000-7000-8000-000000000006', title: 'кофе' });
        }
        return {};
      },
    );
    act(() => {
      promise = api.submit('кофе 100');
    });
    await waitFor(() => expect(release).toBeDefined());
    const before = calls.length;
    act(() => resetUndoSession());
    await act(async () => {
      release(
        phase === 'categories'
          ? [category]
          : phase === 'settings'
            ? { timezone: 'UTC', defaultCurrency: 'RUB' }
            : phase === 'rules'
              ? []
              : wireEntity({ id: '019a0000-0000-7000-8000-000000000006', title: 'кофе' }),
      );
      await promise;
    });
    expect(calls).toHaveLength(before);
    expect(useRetryBuffer.getState().size).toBe(0);
  });
