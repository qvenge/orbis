/**
 * «Скопировать ссылку» — полный адрес ТЕКУЩЕГО места без состояния (срез 1б §7.1, §7.4, С1б-2):
 * запись в приложении — `/a/<приложение>/r/<id>`, в хосте — `/r/<id>`; вкладка шаблона и «открыть
 * через X» живут в истории, а не в ссылке («поделиться» даёт адрес без `?` и `#`).
 *
 * Рисуется `<App/>` целиком: адрес места знает модель навигации, а не экран записи сам по себе.
 */
import { currentEntry } from '@orbis/shared/nav';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../App';
import {
  BREAD,
  frameHandler,
  frameWorld,
  MY_APP,
  MY_SECTION,
  navModel,
  resetFrame,
  stubLaunchMode,
  unstubLaunchMode,
} from '../../app/frame/frame-fixtures';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import { installCrashTrap, renderWithProviders } from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';

installCrashTrap();

// Radix-меню меряет якорь ResizeObserver'ом — в jsdom его нет (как в detail.test.tsx).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  vi.stubGlobal('requestIdleCallback', () => 1);
  stubLaunchMode('site');
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  vi.unstubAllGlobals();
  unstubLaunchMode();
  resetFrame('/');
});

const heading = (name: string) =>
  screen.findByRole('heading', { level: 1, name }, { timeout: 5000 });

async function openMenu() {
  fireEvent.click(
    within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Меню' }),
  );
  return screen.findByRole('group', { name: 'Этот экран' });
}

async function copyLink(): Promise<string> {
  const own = await openMenu();
  fireEvent.click(await within(own).findByRole('menuitem', { name: 'Скопировать ссылку' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  return writeText.mock.calls[0]?.[0] as string;
}

test('запись на /a/<app>/r/<id> — ссылка с приложением', async () => {
  resetFrame(`/a/${MY_APP}/r/${MY_SECTION}`);
  renderWithProviders(<App />, frameHandler(frameWorld()));
  await heading('Ремонт');
  expect(await copyLink()).toBe(`${window.location.origin}/a/${MY_APP}/r/${MY_SECTION}`);
});

test.each([
  [
    'домашняя приложения /a/<app> — адрес места, а не /r/<домашняя>',
    () => `/a/${MY_APP}`,
    'Дом приложения',
  ],
  ['домашняя хоста / — адрес места, а не /r/<Домой>', () => '/', 'Домой'],
])('%s (§7.1, гейт 24 I-1)', async (_what, path, title) => {
  resetFrame(path());
  renderWithProviders(<App />, frameHandler(frameWorld()));
  await heading(title);
  expect(await copyLink()).toBe(`${window.location.origin}${path()}`);
});

test('запись на /r/<id> — ссылка в хосте', async () => {
  resetFrame(`/r/${BREAD}`);
  renderWithProviders(<App />, frameHandler(frameWorld()));
  await heading('Купить хлеб');
  expect(await copyLink()).toBe(`${window.location.origin}/r/${BREAD}`);
});

test('«Открыть как запись» и открытая вкладка шаблона — тот же адрес, без состояния (без ? и #)', async () => {
  resetFrame(`/a/${MY_APP}/r/${MY_SECTION}`);
  renderWithProviders(<App />, frameHandler(frameWorld()));
  await heading('Ремонт');
  const own = await openMenu();
  fireEvent.click(await within(own).findByRole('menuitem', { name: 'Открыть как запись' }));
  await waitFor(() => expect(currentEntry(navModel()).view?.via).toBe('host'));
  // Вкладка шаблона — то же хранилище состояния места (история, §7.1), что и «открыть через».
  act(() => useNav.getState().setView({ 'tab:template:host/tabs0': 'Тред' }));
  expect(currentEntry(navModel()).view).toMatchObject({ 'tab:template:host/tabs0': 'Тред' });

  const url = await copyLink();
  expect(url).toBe(`${window.location.origin}/a/${MY_APP}/r/${MY_SECTION}`);
  expect(url).not.toMatch(/[?#]/);
});
