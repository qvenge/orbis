import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppShell, preloadDesktopFrame } from '../../../app/AppShell';
import {
  noteRegistryVersion,
  resetRegistryVersionForTests,
} from '../../../lib/registry/useRegistry';
import { mayLeave } from '../../../state/leave-guard';
import { renderWithProviders, trpcError } from '../../../test/harness';
import { navAt } from '../../../test/nav';
import { registryReply } from '../../../test/registry';
import { entity, registry } from './test-fixtures';

let desktop = false;
const listeners = new Set<() => void>();
beforeEach(async () => {
  resetRegistryVersionForTests();
  navAt(entity.id);
  vi.stubGlobal('requestIdleCallback', () => 1);
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return desktop && query === '(min-width: 768px)';
    },
    media: query,
    addEventListener: (_name: string, callback: () => void) => listeners.add(callback),
    removeEventListener: (_name: string, callback: () => void) => listeners.delete(callback),
    addListener: () => {},
    removeListener: () => {},
  }));
  await preloadDesktopFrame();
});
afterEach(() => {
  vi.unstubAllGlobals();
  listeners.clear();
});
it.each([
  false,
  true,
])('host mutation pending survives responsive frame replacement starting desktop=%s', async (initial) => {
  desktop = initial;
  let release: (value: unknown) => void = () => {};
  const mutation = new Promise((resolve) => (release = resolve));
  const { calls } = renderWithProviders(
    <AppShell />,
    (path, _input, type) =>
      path === 'registry.effective'
        ? registry
        : path === 'entity.get'
          ? { entity, relations: [], thread: null, registryVersion: registry.version }
          : type === 'mutation'
            ? mutation
            : (registryReply(path) ?? []),
    { queries: { staleTime: Infinity } },
  );
  await screen.findByText(entity.title);
  fireEvent.click(await screen.findByTestId('screen-menu'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Свойства и связи' }));
  const dialog = await screen.findByRole('dialog', { name: 'Свойства и связи' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сделать страницей' }));
  await waitFor(() =>
    expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(1),
  );
  await act(async () => {
    desktop = !desktop;
    for (const notify of listeners) notify();
  });
  expect(screen.getByRole('dialog', { name: 'Свойства и связи' })).toBe(dialog);
  expect(within(dialog).getByRole('button', { name: 'Сделать страницей' })).toBeDisabled();
  await act(async () => expect(mayLeave()).toBe(false));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Закрыть' }));
  expect(dialog).toBeInTheDocument();
  await act(async () => release({ ok: true }));
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: 'Сделать страницей' })).not.toBeDisabled(),
  );
  expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(1);
});
it.each([
  false,
  true,
])('known new version stays blocked through cached host remount starting desktop=%s', async (initial) => {
  desktop = initial;
  const { calls } = renderWithProviders(
    <AppShell />,
    (path) =>
      path === 'registry.effective'
        ? registry
        : path === 'entity.get'
          ? { entity, relations: [], thread: null, registryVersion: registry.version }
          : (registryReply(path) ?? []),
    { queries: { staleTime: Infinity } },
  );
  await screen.findByText(entity.title);
  fireEvent.click(await screen.findByTestId('screen-menu'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Свойства и связи' }));
  const dialog = await screen.findByRole('dialog', { name: 'Свойства и связи' });
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Свойства' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Редактировать свойства' }));
  fireEvent.change(within(dialog).getByLabelText('Поле теста'), {
    target: { value: 'raw with stale metadata' },
  });
  await act(async () => noteRegistryVersion('new-version'));
  await screen.findByRole('button', { name: 'Повторить загрузку определений' });
  expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  const reads = calls.filter((call) => call.path === 'entity.get').length;
  await act(async () => {
    desktop = !desktop;
    for (const notify of listeners) notify();
  });
  await waitFor(() => expect(Boolean(screen.queryByTestId('desktop-frame'))).toBe(desktop));
  expect(within(dialog).getByLabelText('Поле теста')).toHaveValue('raw with stale metadata');
  expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  expect(calls.filter((call) => call.path === 'entity.get')).toHaveLength(reads);
});
it.each([
  false,
  true,
])('responsive frame starting desktop=%s retains dirty/pending/unknown panel lifecycle in both directions', async (initial) => {
  desktop = initial;
  let reject: (value: unknown) => void = () => {};
  const pending = new Promise((_resolve, rejection) => (reject = rejection));
  const { calls } = renderWithProviders(<AppShell />, (path, _input, type) =>
    path === 'registry.effective'
      ? registry
      : path === 'entity.get'
        ? { entity, relations: [], thread: null, registryVersion: registry.version }
        : type === 'mutation'
          ? pending
          : (registryReply(path) ?? []),
  );
  await screen.findByText(entity.title);
  fireEvent.click(await screen.findByTestId('screen-menu'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Свойства и связи' }));
  const dialog = await screen.findByRole('dialog', { name: 'Свойства и связи' });
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Свойства' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Редактировать свойства' }));
  fireEvent.change(within(dialog).getByLabelText('Поле теста'), {
    target: { value: 'raw survives' },
  });
  async function resize() {
    await act(async () => {
      desktop = !desktop;
      for (const notify of listeners) notify();
    });
    await waitFor(() => expect(Boolean(screen.queryByTestId('desktop-frame'))).toBe(desktop));
    expect(screen.getByRole('dialog', { name: 'Свойства и связи' })).toBe(dialog);
    expect(within(dialog).getByLabelText('Поле теста')).toHaveValue('raw survives');
    await act(async () => {
      expect(mayLeave()).toBe(false);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Продолжить редактирование' }));
  }
  await resize();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
  await waitFor(() =>
    expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(1),
  );
  await act(async () => {
    desktop = !desktop;
    for (const notify of listeners) notify();
  });
  expect(screen.getByRole('dialog', { name: 'Свойства и связи' })).toBe(dialog);
  expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  expect(mayLeave()).toBe(false);
  reject(trpcError('INTERNAL_SERVER_ERROR'));
  await screen.findByText('Не удалось подтвердить сохранение. Ввод сохранён.');
  await screen.findByText('Проверьте ввод и сохраните явно ещё раз.');
  await resize();
  expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(1);
});
