/**
 * Переключатель приложений и форма «домашняя как центр» (срез 1б §6.2 п. 2–3, §6.4, §7.2; С1б-7
 * «Все приложения», С1б-11 часть; R-27): блок «Приложения» на «Домой», тот же список в «⋯ → Все
 * приложения», разделы плитками на домашней, ярлык «↗ Дом» у раздела чужого дома.
 */
import { APP_NAV, APP_NAV_FORM } from '@orbis/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../App';
import {
  HOME as HOST_HOME_PAGE,
  resetFrame,
  shownPath,
  stubLaunchMode,
  UPCOMING,
  unstubLaunchMode,
} from '../../app/frame/frame-fixtures';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import { installCrashTrap, renderWithProviders } from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import {
  type AppsWorld,
  appRow,
  appsHandler,
  appsWorld,
  DACHA,
  DACHA_ROW,
  HOST_PAGE,
  MY,
  MY_HOME,
  MY_ROW,
  MY_SECTION,
  PLAIN,
  PROJ,
  PROJ_HOME,
  PROJ_ROW,
  page,
  UTRO,
} from './apps-world';
import { HOMED_PAGES_QUERY } from './useApps';

installCrashTrap();

beforeEach(() => {
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  vi.stubGlobal('requestIdleCallback', () => 1);
  stubLaunchMode('site');
});

afterEach(() => {
  vi.unstubAllGlobals();
  unstubLaunchMode();
  resetFrame('/');
});

const renderApp = (world: AppsWorld) => renderWithProviders(<App />, appsHandler(world));

const heading = (name: string) =>
  screen.findByRole('heading', { level: 1, name }, { timeout: 5000 });

const frameIcon = () => within(screen.getByTestId('host-presence')).getByTestId('nav-switch');

const ARCHIVED = '00000000-0000-4000-8000-000000002099';

const WORLD = () =>
  appsWorld({
    apps: [MY_ROW, PROJ_ROW, DACHA_ROW, appRow(ARCHIVED, 'Старое', '🗃️', {}, { archived: true })],
  });

test('{{apps}} на «Домой» — плитки своих приложений; выключенное приглушено; нажатие → /a/<id>', async () => {
  resetFrame('/');
  renderApp(WORLD());
  await heading('Домой');
  const block = await screen.findByTestId('apps-block');
  const tiles = within(block).getAllByTestId(/^app-tile-/);
  expect(tiles.map((t) => t.textContent)).toEqual(['🏡Мой дом', '📁Проекты', '🌲Дача выключено']);
  // Оболочки хоста и архивного приложения среди плиток нет.
  expect(within(block).queryByText('Orbis')).toBeNull();
  expect(within(block).queryByText('Старое')).toBeNull();
  expect(within(block).getByTestId(`app-tile-${DACHA}`)).toHaveAttribute('data-disabled');
  expect(within(block).getByTestId(`app-tile-${MY}`)).not.toHaveAttribute('data-disabled');
  // Устаревшей плашки «не показывается этой версией» больше нет (снята задачей 20).
  expect(screen.queryByText(/этой версией не показывается/)).toBeNull();

  fireEvent.click(within(block).getByTestId(`app-tile-${MY}`));
  await heading('Дом приложения');
  expect(shownPath()).toBe(`/a/${MY}`);
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
});

test('«⋯ → Все приложения» — хост и тот же список; нажатие переключает приложение (R-38)', async () => {
  resetFrame(`/a/${MY}`);
  renderApp(WORLD());
  await heading('Дом приложения');
  fireEvent.click(screen.getByTestId('screen-menu'));
  const host = await screen.findByRole('group', { name: 'Хост' });
  fireEvent.click(within(host).getByRole('menuitem', { name: 'Все приложения' }));
  const sheet = await screen.findByRole('dialog', { name: 'Все приложения' });
  expect(
    within(sheet)
      .getAllByTestId(/^app-tile-/)
      .map((t) => t.textContent),
  ).toEqual(['🪐Orbis', '🏡Мой дом', '📁Проекты', '🌲Дача выключено']);
  fireEvent.click(within(sheet).getByTestId(`app-tile-${PROJ}`));
  await heading('Проекты: домашняя');
  expect(shownPath()).toBe(`/a/${PROJ}`);
  expect(screen.queryByRole('dialog', { name: 'Все приложения' })).toBeNull();
});

test('путь в хост из приложения на телефоне — плитка хоста в «Все приложения» (R-38)', async () => {
  resetFrame(`/a/${MY}`);
  renderApp(WORLD());
  await heading('Дом приложения');
  fireEvent.click(screen.getByTestId('screen-menu'));
  const host = await screen.findByRole('group', { name: 'Хост' });
  fireEvent.click(within(host).getByRole('menuitem', { name: 'Все приложения' }));
  const sheet = await screen.findByRole('dialog', { name: 'Все приложения' });
  fireEvent.click(within(sheet).getByTestId('app-tile-host'));
  await heading('Домой');
  expect(shownPath()).toBe('/');
  expect(useNav.getState().model.activeApp).toBe('host');
  expect(screen.queryByRole('dialog', { name: 'Все приложения' })).toBeNull();
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
});

test('второй {{apps}} на странице — два списка без плашки (R-27)', async () => {
  resetFrame(`/r/${UTRO}`);
  const world = appsWorld({
    records: [page(UTRO, 'Утро', null, 'Раз.\n\n{{apps}}\n\nДва.\n\n{{apps}}')],
  });
  renderApp(world);
  await heading('Утро');
  await waitFor(() => expect(screen.getAllByTestId('apps-block')).toHaveLength(2));
  expect(screen.queryByTestId('block-plaque')).toBeNull();
});

test('«домашняя как центр» — листа разделов нет, разделы плитками над домашней', async () => {
  resetFrame(`/a/${MY}`);
  const hub = appRow(MY, 'Мой дом', '🏡', {
    'orbis/app_home': MY_HOME,
    [APP_NAV]: [MY_SECTION],
    [APP_NAV_FORM]: 'home-hub',
  });
  renderApp(appsWorld({ apps: [hub] }));
  await heading('Дом приложения');
  expect(frameIcon()).toBeDisabled();
  const tiles = await screen.findByTestId('nav-tiles');
  // Плитки — над содержимым домашней, под заголовком экрана.
  const content = screen.getByTestId('page-view');
  expect(tiles.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(within(tiles).getByRole('button', { name: /Ремонт/ }));
  await heading('Ремонт');
  expect(shownPath()).toBe(`/a/${MY}/r/${MY_SECTION}`);
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
});

test('«список из заголовка» — раздел чужого дома ярлыком «↗ Дом»; нажатие — в его доме', async () => {
  resetFrame(`/a/${MY}`);
  const withShortcut = appRow(MY, 'Мой дом', '🏡', {
    'orbis/app_home': MY_HOME,
    [APP_NAV]: [MY_SECTION, UPCOMING, HOST_HOME_PAGE, HOST_PAGE, PROJ_HOME],
  });
  const { calls } = renderApp(appsWorld({ apps: [withShortcut, PROJ_ROW] }));
  await heading('Дом приложения');
  expect(screen.queryByTestId('nav-tiles')).toBeNull();
  fireEvent.click(frameIcon());
  const own = await screen.findByTestId(`nav-section-${MY_SECTION}`);
  // Раздел навигации и домашняя хоста без «Дома» — не бездомные (§4.3): ярлык хоста.
  const upcoming = await screen.findByTestId(`nav-section-${UPCOMING}`);
  await waitFor(() => expect(upcoming).toHaveTextContent('↗ Orbis'));
  expect(screen.getByTestId(`nav-section-${HOST_HOME_PAGE}`)).toHaveTextContent('↗ Orbis');
  // Страница с «Домом» = другое приложение — ярлык его дома.
  await waitFor(() =>
    expect(screen.getByTestId(`nav-section-${PROJ_HOME}`)).toHaveTextContent('↗ Проекты'),
  );
  // Бездомная страница (пустой «Дом», вне хоста) — обычный раздел: первое место задаст ей дом.
  expect(screen.getByTestId(`nav-section-${HOST_PAGE}`)).not.toHaveTextContent('↗');
  expect(own).not.toHaveTextContent('↗');
  // Узкий запрос страниц с «Домом»; всех страниц графа лист не тянет (гейт 20, m-5).
  const queries = calls
    .filter((c) => c.path === 'entity.query')
    .map((c) => (c.input as { query?: string }).query);
  expect(queries).toContain(HOMED_PAGES_QUERY);
  expect(queries).not.toContain('aspect=orbis/page');
  fireEvent.click(upcoming);
  await heading('Upcoming');
  await waitFor(() => expect(shownPath()).toBe(`/r/${UPCOMING}`));
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
});

test('m-2: раздел-не-страница — не ярлык «↗», открывается разделом своего приложения', async () => {
  resetFrame(`/a/${MY}`);
  const withRecord = appRow(MY, 'Мой дом', '🏡', {
    'orbis/app_home': MY_HOME,
    [APP_NAV]: [MY_SECTION, PLAIN],
  });
  renderApp(appsWorld({ apps: [withRecord] }));
  await heading('Дом приложения');
  fireEvent.click(frameIcon());
  const row = await screen.findByTestId(`nav-section-${PLAIN}`);
  await waitFor(() => expect(row).toHaveTextContent('Купить хлеб'));
  expect(row).not.toHaveTextContent('↗');
  fireEvent.click(row);
  await heading('Купить хлеб');
  expect(shownPath()).toBe(`/a/${MY}/r/${PLAIN}`);
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
  expect(useNav.getState().model.apps[MY]?.activeSection).toBe(PLAIN);
});
