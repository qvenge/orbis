import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { expect, test, vi } from 'vitest';

vi.mock('../../auth/supabase', () => ({ auth: { signOut: vi.fn() }, useSession: vi.fn() }));

import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { AuthProvider } from '../../auth/AuthProvider';
import { useSession } from '../../auth/supabase';
import { mockEntityUpdateResult, renderWithProviders, trpcError } from '../../test/harness';
import type { FlushResult } from '../entity-editor/body-flush';
import { registerBodyFlush } from '../entity-editor/body-flush';
import { useBodySave } from '../entity-editor/useBodySave';
import { VersionsCard } from './VersionsCard';

const doc = (text: string) => ({
  v: 3 as const,
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
});
test('old restore intent after actual stable AuthProvider ownerchange must not send', async () => {
  vi.mocked(useSession).mockReturnValue({ token: 'jwt1', userId: 'u1', status: 'authed' });
  const entity = mockEntityUpdateResult({
    id: 'e1',
    bodyRevision: 3,
    bodyDoc: doc('base'),
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  let api!: ReturnType<typeof useBodySave>;
  let flushStarts = 0;
  function Body() {
    const body = useBodySave('e1', entity);
    api = body;
    useEffect(
      () =>
        registerBodyFlush(
          'e1',
          () => {
            flushStarts++;
            return body.flushSettled();
          },
          body.revisionForRewrite,
          body.beginRewrite,
        ),
      [body.flushSettled, body.revisionForRewrite, body.beginRewrite],
    );
    return null;
  }
  const stable = (
    <>
      <Body />
      <VersionsCard entity={entity} active />
    </>
  );
  function Host() {
    const [, refresh] = useState(0);
    return (
      <>
        <button type="button" onClick={() => refresh((n) => n + 1)}>
          ownerchange
        </button>
        <AuthProvider>{stable}</AuthProvider>
      </>
    );
  }
  const { calls } = renderWithProviders(<Host />, (path) => {
    if (path === 'version.list')
      return [
        { id: 'v-old', label: 'Old version', createdAt: '2026-01-01T00:00:00.000Z', hasDoc: true },
      ];
    if (path === 'user.getSettings') return { timezone: 'UTC' };
    if (path === 'entity.update' || path === 'version.restore') return new Promise(() => {});
    return {};
  });
  await screen.findByText('Old version');
  act(() => {
    api.onDocChange(doc('old typed'));
    api.flush();
  });
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Восстановить' }));
  await waitFor(() => expect(flushStarts).toBe(1));
  expect(calls.filter((c) => c.path === 'version.restore')).toHaveLength(0);
  vi.mocked(useSession).mockReturnValue({ token: 'jwt2', userId: 'u2', status: 'authed' });
  fireEvent.click(screen.getByText('ownerchange'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(calls.filter((c) => c.path === 'version.restore')).toHaveLength(0);
});
test('current owner restoration still sends and succeeds', async () => {
  vi.mocked(useSession).mockReturnValue({
    token: 'jwt-current',
    userId: 'u-current',
    status: 'authed',
  });
  const entity = mockEntityUpdateResult({
    id: 'e-current',
    title: 'Current',
    bodyRevision: 3,
    bodyDoc: doc('base'),
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const { calls } = renderWithProviders(
    <AuthProvider>
      <VersionsCard entity={entity} active />
    </AuthProvider>,
    (path) => {
      if (path === 'version.list')
        return [
          {
            id: 'v-current',
            label: 'Current version',
            createdAt: '2026-01-01T00:00:00.000Z',
            hasDoc: true,
          },
        ];
      if (path === 'user.getSettings') return { timezone: 'UTC' };
      if (path === 'version.restore')
        return {
          ...entity,
          bodyRevision: 4,
          bodyDoc: doc('restored'),
          actionId: 'current-restore',
          consequences: false,
        };
      return {};
    },
  );
  await screen.findByText('Current version');
  fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Восстановить' }));
  await waitFor(() => expect(calls.filter((c) => c.path === 'version.restore')).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

const confirmRestore = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Восстановить' }));
};

test('old flush finally cannot release a new owner restore wait', async () => {
  vi.mocked(useSession).mockReturnValue({ token: 'jwt1', userId: 'flush-old', status: 'authed' });
  const entity = mockEntityUpdateResult({
    id: 'e-wait',
    title: 'Wait',
    bodyDoc: doc('base'),
    bodyRevision: 3,
  });
  const releases: ((result: FlushResult) => void)[] = [];
  function Body() {
    const body = useBodySave(entity.id, entity);
    useEffect(
      () =>
        registerBodyFlush(
          entity.id,
          async () => {
            await body.flushSettled();
            return new Promise<FlushResult>((resolve) => {
              releases.push(resolve);
            });
          },
          body.revisionForRewrite,
          body.beginRewrite,
        ),
      [body.flushSettled, body.revisionForRewrite, body.beginRewrite],
    );
    return null;
  }
  const stable = (
    <>
      <Body />
      <VersionsCard entity={entity} active />
    </>
  );
  function Host() {
    const [, refresh] = useState(0);
    return (
      <>
        <button type="button" onClick={() => refresh((n) => n + 1)}>
          ownerchange
        </button>
        <AuthProvider>{stable}</AuthProvider>
      </>
    );
  }
  const { calls } = renderWithProviders(<Host />, (p) => {
    if (p === 'version.list')
      return [{ id: 'v-wait', label: 'Wait version', createdAt: entity.updatedAt, hasDoc: true }];
    if (p === 'user.getSettings') return { timezone: 'UTC' };
    if (p === 'version.restore')
      return mockEntityUpdateResult({ ...entity, bodyRevision: 4, bodyDoc: doc('restored') });
    return {};
  });
  await screen.findByText('Wait version');
  confirmRestore();
  await waitFor(() => expect(releases).toHaveLength(1));
  vi.mocked(useSession).mockReturnValue({ token: 'jwt2', userId: 'flush-new', status: 'authed' });
  fireEvent.click(screen.getByText('ownerchange'));
  await waitFor(() =>
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Восстановить' }),
    ).toBeEnabled(),
  );
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Восстановить' }));
  await waitFor(() => expect(releases).toHaveLength(2));
  await act(async () => {
    releases[0]?.('nothing');
  });
  expect(calls.filter((c) => c.path === 'version.restore')).toHaveLength(0);
  expect(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Восстановить' }),
  ).toBeDisabled();
  await act(async () => {
    releases[1]?.('nothing');
  });
  await waitFor(() => expect(calls.filter((c) => c.path === 'version.restore')).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test.each([
  'success',
  'error',
] as const)('late old restore %s cannot close or release current restore', async (outcome) => {
  vi.mocked(useSession).mockReturnValue({ token: 'jwt1', userId: 'restore-old', status: 'authed' });
  const entity = mockEntityUpdateResult({
    id: 'e-flight',
    title: 'Flight',
    bodyDoc: doc('base'),
    bodyRevision: 3,
  });
  const held: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  let client!: QueryClient;
  function Capture() {
    client = useQueryClient();
    return null;
  }
  const stable = (
    <>
      <Capture />
      <VersionsCard entity={entity} active />
    </>
  );
  function Host() {
    const [, refresh] = useState(0);
    return (
      <>
        <button type="button" onClick={() => refresh((n) => n + 1)}>
          ownerchange
        </button>
        <AuthProvider>{stable}</AuthProvider>
      </>
    );
  }
  const { calls } = renderWithProviders(<Host />, (p) => {
    if (p === 'version.list')
      return [
        { id: 'v-flight', label: 'Flight version', createdAt: entity.updatedAt, hasDoc: true },
      ];
    if (p === 'user.getSettings') return { timezone: 'UTC' };
    if (p === 'version.restore')
      return new Promise((resolve, reject) => held.push({ resolve, reject }));
    return {};
  });
  await screen.findByText('Flight version');
  confirmRestore();
  await waitFor(() => expect(held).toHaveLength(1));
  vi.mocked(useSession).mockReturnValue({ token: 'jwt2', userId: 'restore-new', status: 'authed' });
  fireEvent.click(screen.getByText('ownerchange'));
  await waitFor(() =>
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Восстановить' }),
    ).toBeEnabled(),
  );
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Восстановить' }));
  await waitFor(() => expect(held).toHaveLength(2));
  await act(async () => {
    if (outcome === 'success')
      held[0]?.resolve(
        mockEntityUpdateResult({ ...entity, bodyRevision: 99, bodyDoc: doc('old') }),
      );
    else held[0]?.reject(trpcError('BAD_REQUEST', 'old restore failure'));
  });
  await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.status).toBe(outcome));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Восстановить' }),
  ).toBeDisabled();
  expect(screen.queryByText('old restore failure')).not.toBeInTheDocument();
  expect(calls.filter((c) => c.path === 'version.restore')).toHaveLength(2);
  await act(async () => {
    held[1]?.resolve(
      mockEntityUpdateResult({ ...entity, bodyRevision: 4, bodyDoc: doc('current') }),
    );
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
