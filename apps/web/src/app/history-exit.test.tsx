/**
 * Режим приложения: системный «назад», отпущенный на дне хоста, когда уйти некуда (гейт 19, I-1).
 *
 * У PWA, запущенной с иконки, базовая запись Orbis — первая в истории сессии, и `history.back()` с неё
 * — пустая операция: Orbis остаётся открытым. Если после этого человек идёт дальше, охранная запись
 * обязана вернуться — иначе следующий системный «назад» закрыл бы Orbis с любой глубины.
 *
 * Файл отдельный и тест в нём ПЕРВЫЙ: jsdom держит одну сессионную историю на файл, а здесь нужна
 * чистая — базовая запись должна быть первой, как у PWA с иконки. `history.back()` настоящий, без
 * заглушки: с первой записи jsdom, как и браузер, никуда не уходит.
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../lib/registry/useRegistry';
import { useNav } from '../state/navigation';
import { installCrashTrap, renderWithProviders } from '../test/harness';
import { BUILTIN_REGISTRY } from '../test/registry';
import {
  BREAD,
  frameHandler,
  resetFrame,
  shownPath,
  stubLaunchMode,
  UPCOMING,
  unstubLaunchMode,
} from './frame/frame-fixtures';

installCrashTrap();

beforeEach(() => {
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  vi.stubGlobal('requestIdleCallback', () => 1);
});

afterEach(() => {
  vi.unstubAllGlobals();
  unstubLaunchMode();
  resetFrame('/');
});

const heading = (name: string) =>
  screen.findByRole('heading', { level: 1, name }, { timeout: 5000 });

/** Системный «назад»: браузер снимает запись и шлёт `popstate` (или не шлёт — снимать нечего). */
async function systemBack() {
  await act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 30));
  });
}

test('«назад» на «Домой» отпущен, но уйти некуда → Orbis жив; дальше «Upcoming» → запись → «назад» идёт по стопке', async () => {
  stubLaunchMode('app');
  resetFrame('/');
  expect(window.history.length).toBe(1);
  renderWithProviders(<App />, frameHandler());
  await heading('Домой');
  // База + охранная.
  expect(window.history.length).toBe(2);

  // Дно стопки хоста: «назад» отпущен, `history.back()` с первой записи — пустая операция.
  const push = vi.spyOn(window.history, 'pushState');
  await systemBack();
  expect(screen.getByRole('heading', { level: 1, name: 'Домой' })).toBeInTheDocument();
  // Охранная сама НЕ вернулась: иначе второе нажатие, которым человек закрывает Orbis с дна, снова
  // было бы перехвачено, и приложение не закрывалось бы вовсе. Мы на базовой записи, над ней ничего.
  expect(push).not.toHaveBeenCalled();
  expect((window.history.state as { guard?: boolean } | null)?.guard).toBeUndefined();
  // Второе нажатие без переходов: перехвата нет, охранная не ставится (браузер закрыл бы Orbis).
  await systemBack();
  expect(push).not.toHaveBeenCalled();
  push.mockRestore();

  // Человек остался и пошёл дальше.
  fireEvent.click(screen.getByTestId('nav-switch'));
  fireEvent.click(await screen.findByTestId(`nav-section-${UPCOMING}`));
  await heading('Upcoming');
  act(() => useNav.getState().openRecord(BREAD));
  await heading('Купить хлеб');

  // Охранная запись вернулась: системный «назад» снова перехвачен и ведёт по стопке раздела.
  await systemBack();
  await heading('Upcoming');
  expect(shownPath()).toBe(`/r/${UPCOMING}`);
});
