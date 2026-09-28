/**
 * Отказ чанка окна ⌘K (финал 1б, C1 M-5; остаток М-25): кадр провала — без второго набора элементов
 * хоста поверх рамки (С1б-7, §6.6), и окно закрываемо. Отдельный файл: `lazy` окна живёт модулем
 * `AppShell` и помнит отказ навсегда — в общем файле поиска он уронил бы соседние тесты.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { useSearchDialog } from '../features/search/search-dialog-store';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../lib/registry/useRegistry';
import { installCrashTrap, renderWithProviders } from '../test/harness';
import { BUILTIN_REGISTRY } from '../test/registry';
import { frameHandler, frameWorld, resetFrame, stubViewport } from './frame/frame-fixtures';
import { HOST_ELEMENTS } from './frame/host-elements';

vi.mock('../features/search/SearchDialog', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

installCrashTrap();

beforeEach(() => {
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  vi.stubGlobal('requestIdleCallback', () => 1);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  act(() => useSearchDialog.setState({ open: false }));
  resetFrame('/');
});

const hostRoles = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-host]')].map((e) => e.dataset.host ?? '');

test('чанк окна ⌘K не приехал — свой кадр без второго набора элементов хоста; «Закрыть» снимает окно', async () => {
  // React печатает пойманную ошибку — ожидаемо.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stubViewport(true);
  resetFrame('/');
  renderWithProviders(<App />, frameHandler(frameWorld()));
  await screen.findByRole('heading', { level: 1, name: 'Домой' }, { timeout: 5000 });
  const before = hostRoles();
  fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
  const failed = await screen.findByTestId('search-dialog-failed', {}, { timeout: 5000 });
  expect(failed).toHaveTextContent('Не удалось открыть поиск');
  expect(screen.getByTestId('chunk-reload')).toBeInTheDocument();
  // Один набор элементов хоста: кадр провала шапки с присутствием хоста не рисует.
  expect(hostRoles()).toEqual(before);
  expect(before).toHaveLength(new Set(before).size);
  expect(before.every((r) => (HOST_ELEMENTS as readonly string[]).includes(r))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
  await waitFor(() => expect(screen.queryByTestId('search-dialog-failed')).toBeNull());
  expect(useSearchDialog.getState().open).toBe(false);
});
