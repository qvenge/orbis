import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { mayLeave } from '../../../state/leave-guard';
import { renderWithProviders, trpcError } from '../../../test/harness';
import { navAt } from '../../../test/nav';
import { registryReply } from '../../../test/registry';
import { DetailScreen } from '../DetailScreen';
import { PropertiesRelationsOwner, usePropertiesRelationsOwner } from '../PropertiesRelationsOwner';
import type { LatestPanelHost } from './panel-host';
import { entity, registry } from './test-fixtures';

const loader = vi.hoisted(() => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
});
vi.mock('./panel-host', async (original) => {
  await loader.gate;
  return original();
});
it('addressed host lock starts synchronously before import and spans real page batch failure/retry', async () => {
  navAt(entity.id);
  vi.stubGlobal('requestIdleCallback', () => 1);
  let reject: (error: unknown) => void = () => {};
  const mutation = new Promise((_resolve, rejection) => (reject = rejection));
  let writes = 0;
  const { calls } = renderWithProviders(
    <DetailScreen entityId={entity.id} />,
    (path, _input, type) =>
      path === 'entity.get'
        ? { entity, relations: [], thread: null, registryVersion: registry.version }
        : path === 'registry.effective'
          ? registry
          : type === 'mutation'
            ? ++writes === 1
              ? mutation
              : { ok: true }
            : (registryReply(path) ?? []),
  );
  fireEvent.click(await screen.findByTestId('screen-menu'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Свойства и связи' }));
  const dialog = await screen.findByRole('dialog', { name: 'Свойства и связи' });
  const button = within(dialog).getByRole('button', { name: 'Сделать страницей' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(mayLeave()).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Закрыть' }));
  expect(dialog).toBeInTheDocument();
  loader.release();
  await waitFor(() =>
    expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(1),
  );
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(1);
  await act(async () => reject(trpcError('FORBIDDEN')));
  await waitFor(() => expect(button).not.toBeDisabled());
  expect(mayLeave()).toBe(true);
  fireEvent.click(button);
  await waitFor(() =>
    expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(2),
  );
  await waitFor(() => expect(button).not.toBeDisabled());
  vi.unstubAllGlobals();
});
it('public owner close/open cannot replace the addressed panel synchronously during a host intent', async () => {
  let release: () => void = () => {};
  const mutation = new Promise<void>((resolve) => (release = resolve));
  const available = new Set(['makePage', 'openBody'] as const);
  const latest: LatestPanelHost = {
    entity,
    available,
    restricted: false,
    setMode() {},
    setHostView() {},
    restore() {},
    makePage: vi.fn(() => mutation),
    stopPage() {},
    onClose() {},
  };
  const registration = { readLatest: () => latest, host: { screenEntityId: entity.id, available } };
  let api: ReturnType<typeof usePropertiesRelationsOwner> | undefined;
  function Probe() {
    api = usePropertiesRelationsOwner(registration);
    return (
      <button type="button" onClick={() => api?.open({ entityId: entity.id, readOnly: false })}>
        Open owned panel
      </button>
    );
  }
  renderWithProviders(
    <PropertiesRelationsOwner>
      <Probe />
    </PropertiesRelationsOwner>,
    (path) =>
      path === 'registry.effective'
        ? registry
        : path === 'entity.get'
          ? { entity, relations: [], registryVersion: registry.version }
          : (registryReply(path) ?? []),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open owned panel' }));
  const dialog = await screen.findByRole('dialog', { name: 'Свойства и связи' });
  const pageButton = await within(dialog).findByRole('button', { name: 'Сделать страницей' });
  act(() => {
    pageButton.click();
    api?.close();
    api?.open({ entityId: '00000000-0000-4000-8000-000000000099', readOnly: false });
  });
  expect(screen.getByRole('dialog', { name: 'Свойства и связи' })).toBe(dialog);
  expect(within(dialog).getByText(entity.id)).toBeVisible();
  await waitFor(() => expect(latest.makePage).toHaveBeenCalledTimes(1));
  await act(async () => release());
  act(() => api?.close());
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Свойства и связи' })).toBeNull(),
  );
});
it('restore holds its optimistic UI through the actual addressed mutation, not just dispatch', async () => {
  navAt(entity.id);
  vi.stubGlobal('requestIdleCallback', () => 1);
  let archived = true;
  let release: (value: unknown) => void = () => {};
  const mutation = new Promise((resolve) => (release = resolve));
  const { calls } = renderWithProviders(
    <DetailScreen entityId={entity.id} />,
    (path, _input, type) =>
      path === 'registry.effective'
        ? registry
        : path === 'entity.get'
          ? {
              entity: { ...entity, archived },
              relations: [],
              thread: null,
              registryVersion: registry.version,
            }
          : type === 'mutation'
            ? mutation
            : (registryReply(path) ?? []),
  );
  fireEvent.click(await screen.findByTestId('screen-menu'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Свойства и связи' }));
  const dialog = await screen.findByRole('dialog', { name: 'Свойства и связи' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Восстановить запись' }));
  await waitFor(() =>
    expect(calls.filter((call) => call.path === 'entity.update')).toHaveLength(1),
  );
  expect(calls.find((call) => call.path === 'entity.update')?.input).toMatchObject({
    id: entity.id,
    archived: false,
  });
  expect(mayLeave()).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Закрыть' }));
  expect(dialog).toBeInTheDocument();
  archived = false;
  await act(async () => release({ ok: true, entity: { ...entity, archived: false } }));
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Добавить: Исполнитель' }),
    ).not.toBeDisabled(),
  );
  expect(calls.filter((call) => call.path === 'entity.update')).toHaveLength(1);
  vi.unstubAllGlobals();
});
