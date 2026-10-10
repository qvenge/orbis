import { useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { beforeEach, expect, it } from 'vitest';
import {
  noteRegistryVersion,
  resetRegistryVersionForTests,
} from '../../../lib/registry/useRegistry';
import { renderWithProviders, trpcError } from '../../../test/harness';
import { trpc } from '../../../trpc';
import { detailGetInput, useEntityUpdate } from '../useEntityDetail';
import { PropertiesRelationsPanel } from './PropertiesRelationsPanel';
import { entity, registry } from './test-fixtures';

beforeEach(resetRegistryVersionForTests);
it.each([
  'optimistic',
  'rollback',
])('%s local cache write cannot supersede a newer actual registry observation', async (phase) => {
  let mutation: ReturnType<typeof useEntityUpdate>['mutation'] | undefined;
  let client: ReturnType<typeof useQueryClient> | undefined;
  let reject: (reason: unknown) => void = () => {};
  const write = new Promise((_resolve, rejection) => {
    reject = rejection;
  });
  let holdRead = false;
  let releaseRead: (value: unknown) => void = () => {};
  const freshRead = new Promise((resolve) => {
    releaseRead = resolve;
  });
  let version = registry.version;
  const response = () => ({ entity, relations: [], registryVersion: version });
  function Host() {
    client = useQueryClient();
    mutation = useEntityUpdate(entity.id).mutation;
    return (
      <PropertiesRelationsPanel
        target={{ entityId: entity.id, readOnly: false }}
        host={{ screenEntityId: entity.id, available: new Set(), run() {} }}
        onClose={() => {}}
      />
    );
  }
  const { calls } = renderWithProviders(
    <Host />,
    (path) =>
      path === 'entity.get'
        ? holdRead
          ? freshRead
          : response()
        : path === 'registry.effective'
          ? { ...registry, version }
          : path === 'entity.update'
            ? write
            : { ok: true },
    { queries: { staleTime: Infinity } },
  );
  fireEvent.click(await screen.findByRole('tab', { name: 'Свойства' }));
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать свойства' }));
  fireEvent.change(screen.getByLabelText('Поле теста'), {
    target: { value: 'raw remains blocked' },
  });
  const key = getQueryKey(trpc.entity.get, detailGetInput(entity.id), 'query');
  const originalReadAt = client?.getQueryState(key)?.dataUpdatedAt;
  expect(originalReadAt).toBeGreaterThan(0);
  await act(async () => noteRegistryVersion('new-server-version'));
  await screen.findByRole('button', { name: 'Повторить загрузку определений' });
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  await act(async () => {
    mutation?.mutate({ id: entity.id, title: 'optimistic title' });
  });
  await screen.findByText('optimistic title');
  if (phase === 'rollback') {
    // Give rollback its own newer observation, independently of an optimistic-write failure.
    await act(async () => noteRegistryVersion('new-server-version'));
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    holdRead = true;
    await act(async () => reject(trpcError('BAD_REQUEST')));
    await screen.findByText(entity.title);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  expect(screen.getByLabelText('Поле теста')).toHaveValue('raw remains blocked');
  expect(client?.getQueryState(key)?.dataUpdatedAt).toBe(originalReadAt);
  // The blocked state is recoverable through a real addressed read, not a local timestamp bump.
  version = 'new-server-version';
  holdRead = false;
  if (phase === 'optimistic') await act(async () => reject(trpcError('BAD_REQUEST')));
  else await act(async () => releaseRead(response()));
  fireEvent.click(await screen.findByRole('button', { name: 'Повторить загрузку определений' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Сохранить' })).not.toBeDisabled());
  expect(client?.getQueryState(key)?.dataUpdatedAt).toBeGreaterThan(originalReadAt ?? 0);
  expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(0);
});
