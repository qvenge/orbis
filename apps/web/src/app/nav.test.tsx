/**
 * Навигация по адресам в web (срез 1б §7.1–§7.3, С1б-2, С1б-3, Фокус ревью п. 1): старт по ссылке и
 * старые ссылки, старое сохранение `orbis:nav:v1`, два поведения истории, перезапуск, экраны хоста
 * поверх раздела, ссылки из содержимого и из чата, повторное нажатие на раздел.
 *
 * Рисуется `<App/>` целиком — рамка, история и стор вместе: по отдельности они зеленели бы и при
 * разъехавшемся старте. jsdom держит ОДНУ сессионную историю на файл — поэтому длину меряем дельтой,
 * а адресную строку перед тестом ставим `replaceState` (`resetFrame`).
 */
import { NAV_STORAGE_KEY } from '@orbis/shared/nav';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../lib/registry/useRegistry';
import { resetNavForTests, useNav } from '../state/navigation';
import { installCrashTrap, renderWithProviders } from '../test/harness';
import { BUILTIN_REGISTRY } from '../test/registry';
import {
  BREAD,
  chatMessage,
  frameHandler,
  frameWorld,
  GLOBAL_THREAD,
  HOME,
  MY_APP,
  MY_SECTION,
  NOTE,
  NOTE_THREAD,
  navModel,
  RECORDS,
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
  stubLaunchMode('site');
});

afterEach(() => {
  vi.unstubAllGlobals();
  unstubLaunchMode();
  resetFrame('/');
});

function renderApp(world = frameWorld()) {
  return renderWithProviders(<App />, frameHandler(world));
}

const heading = (name: string) => screen.findByRole('heading', { level: 1, name });

// ─── (а) старт по адресу и старые ссылки ───────────────────────────────────────────────────────

test('(а) старт на / — «Домой» (страница поставки home) в рамке хоста', async () => {
  resetFrame('/');
  renderApp();
  await heading('Домой');
  const presence = screen.getByTestId('host-presence');
  expect(within(presence).getByTestId('nav-switch')).toHaveTextContent('🪐');
  expect(within(presence).getByTestId('nav-switch')).toHaveTextContent('Домой');
  expect(shownPath()).toBe('/');
});

test('(а) /r/<id> — запись в хосте, адрес тот же', async () => {
  resetFrame(`/r/${BREAD}`);
  renderApp();
  await heading('Купить хлеб');
  expect(shownPath()).toBe(`/r/${BREAD}`);
  expect(navModel().activeApp).toBe('host');
});

test('(а) /entity/<id> — запись, адрес заменён на /r/<id>', async () => {
  resetFrame(`/entity/${BREAD}`);
  renderApp();
  await heading('Купить хлеб');
  expect(shownPath()).toBe(`/r/${BREAD}`);
});

test('(а) /thread/<id> — запись треда (chat.threadEntity), адрес /r/<id>', async () => {
  resetFrame(`/thread/${NOTE_THREAD}`);
  const { calls } = renderApp();
  await heading('Заметка');
  expect(shownPath()).toBe(`/r/${NOTE}`);
  expect(calls.filter((c) => c.path === 'chat.threadEntity')).toEqual([
    { path: 'chat.threadEntity', input: { threadId: NOTE_THREAD } },
  ]);
});

test('(а) /thread/<id> глобального треда — чат хоста, адрес /chat', async () => {
  resetFrame(`/thread/${GLOBAL_THREAD}`);
  renderApp();
  await heading('Чат');
  expect(shownPath()).toBe('/chat');
});

test('(а) /browser — страница «Записи» разделом хоста', async () => {
  resetFrame('/browser');
  renderApp();
  await heading('Записи');
  expect(shownPath()).toBe(`/r/${RECORDS}`);
  expect(screen.getByTestId('nav-switch')).toHaveTextContent('Записи');
});

test.each([
  ['/budget/category/00000000-0000-4000-8000-000000009999', 'Бюджет придёт со следующим срезом'],
  ['/budget', 'Бюджет придёт со следующим срезом'],
  ['/agenda', 'Повестка придёт со следующим срезом'],
])('(а) %s — плашка «придёт со следующим срезом» без кнопки «включить»', async (path, text) => {
  resetFrame(path);
  renderApp();
  const reserved = await screen.findByTestId('reserved-screen');
  expect(reserved).toHaveTextContent(text);
  expect(within(reserved).queryByRole('button', { name: /включить/i })).toBeNull();
  // Рамка на месте и на плашке: уйти можно всегда (§6.6).
  expect(screen.getByTestId('host-presence')).toBeInTheDocument();
  expect(screen.getByTestId('host-buttons')).toBeInTheDocument();
});

// ─── (б) старое сохранение orbis:nav:v1 ────────────────────────────────────────────────────────

test('(б) в хранилище orbis:nav:v1 — старт на /, без падения, v1 не читается', async () => {
  resetFrame('/');
  const v1 = JSON.stringify({
    state: {
      activeTab: 'browser',
      stacks: { chat: [], browser: [{ kind: 'entity', id: BREAD }], agenda: [], budget: [] },
    },
    version: 0,
  });
  localStorage.setItem('orbis:nav:v1', v1);
  renderApp();
  await heading('Домой');
  expect(shownPath()).toBe('/');
  expect(screen.queryByRole('heading', { name: 'Купить хлеб' })).toBeNull();
  // Не переносится: v1 лежит как лежал, новое сохранение — только своей формы.
  expect(localStorage.getItem('orbis:nav:v1')).toBe(v1);
  const v2 = JSON.parse(localStorage.getItem(NAV_STORAGE_KEY) ?? 'null') as { v?: number } | null;
  expect(v2 === null || v2.v === 2).toBe(true);
});

// ─── (в) два поведения истории ─────────────────────────────────────────────────────────────────

test('(в) сайт: переход — pushState, браузерный «назад» (popstate) возвращает прежнее место', async () => {
  resetFrame('/');
  renderApp();
  await heading('Домой');
  const push = vi.spyOn(window.history, 'pushState');
  fireEvent.click(screen.getByTestId('nav-switch'));
  fireEvent.click(await screen.findByTestId(`nav-section-${UPCOMING}`));
  await heading('Upcoming');
  expect(push).toHaveBeenCalledTimes(1);
  expect(shownPath()).toBe(`/r/${UPCOMING}`);
  push.mockRestore();

  act(() => window.history.back());
  await heading('Домой');
  expect(shownPath()).toBe('/');
});

test('(в) приложение: одна запись истории; системный «назад» — как «‹» по стопке раздела', async () => {
  stubLaunchMode('app');
  resetFrame('/');
  renderApp();
  await heading('Домой');
  const push = vi.spyOn(window.history, 'pushState');
  const lengthBefore = window.history.length;
  fireEvent.click(screen.getByTestId('nav-switch'));
  fireEvent.click(await screen.findByTestId(`nav-section-${UPCOMING}`));
  await heading('Upcoming');
  act(() => useNav.getState().openRecord(BREAD));
  await heading('Купить хлеб');
  expect(window.history.length).toBe(lengthBefore);
  expect(push).not.toHaveBeenCalled();
  expect(shownPath()).toBe(`/r/${BREAD}`);
  push.mockRestore();

  // Перехваченный системный «назад» ведёт по стопке раздела, адрес обновляется, охранная запись
  // возвращается (иначе следующий «назад» ушёл бы из приложения).
  const guard = vi.spyOn(window.history, 'pushState');
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  });
  await heading('Upcoming');
  expect(shownPath()).toBe(`/r/${UPCOMING}`);
  expect(guard).toHaveBeenCalledTimes(1);
  guard.mockRestore();
});

test('(в) приложение: на дне стопки хоста системный «назад» не перехватывается', async () => {
  stubLaunchMode('app');
  resetFrame('/');
  renderApp();
  await heading('Домой');
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  const push = vi.spyOn(window.history, 'pushState');
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  });
  // Отпустили: ещё один шаг назад — прочь из Orbis, охранная запись не возвращается.
  expect(back).toHaveBeenCalledTimes(1);
  expect(push).not.toHaveBeenCalled();
  back.mockRestore();
  push.mockRestore();
});

// ─── (г) перезапуск ────────────────────────────────────────────────────────────────────────────

test('(г) перезапуск: активный раздел и его последнее место — из orbis:nav:v2, глубина — нет', async () => {
  resetFrame('/');
  const first = renderApp();
  await heading('Домой');
  fireEvent.click(screen.getByTestId('nav-switch'));
  fireEvent.click(await screen.findByTestId(`nav-section-${UPCOMING}`));
  await heading('Upcoming');
  act(() => useNav.getState().openRecord(BREAD));
  await heading('Купить хлеб');
  first.unmount();

  // Новая вкладка: истории нет, в хранилище — сохранение v2.
  act(() => resetNavForTests());
  window.history.replaceState(null, '', '/');
  renderApp();
  await heading('Купить хлеб');
  expect(screen.getByTestId('nav-switch')).toHaveTextContent('Upcoming');
  const host = navModel().apps.host;
  expect(host?.activeSection).toBe(UPCOMING);
  expect(host?.stacks[UPCOMING]).toHaveLength(1);
});

// ─── (д) экраны хоста поверх раздела; ссылка из чата ──────────────────────────────────────────

test('(д) чат кнопкой хоста ложится поверх раздела, «‹» возвращает в раздел', async () => {
  resetFrame(`/a/${MY_APP}`);
  renderApp();
  await heading('Дом приложения');
  fireEvent.click(within(screen.getByTestId('host-buttons')).getByRole('button', { name: /Чат/ }));
  await heading('Чат');
  expect(shownPath()).toBe('/chat');
  fireEvent.click(
    within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Назад' }),
  );
  await heading('Дом приложения');
  expect(navModel().activeApp).toBe(MY_APP);
});

test('(д) ссылка из чата открывает запись из хоста; «‹» — в раздел, а не в чат', async () => {
  // Режим приложения: «‹» идёт по модели. На сайте «назад» браузера честно вернул бы в чат —
  // запись истории чата там настоящая (§7.3, таблица поведений).
  stubLaunchMode('app');
  resetFrame(`/a/${MY_APP}`);
  renderApp(frameWorld({ chat: [chatMessage('m1', `готово: [[entity:${BREAD}]]`)] }));
  await heading('Дом приложения');
  fireEvent.click(within(screen.getByTestId('host-buttons')).getByRole('button', { name: /Чат/ }));
  await heading('Чат');
  fireEvent.click(await screen.findByRole('link', { name: BREAD }));
  await heading('Купить хлеб');
  // Из чата — хост (правило открытия, §7.2), а не приложение рамки под чатом.
  expect(navModel().activeApp).toBe('host');
  expect(shownPath()).toBe(`/r/${BREAD}`);
  fireEvent.click(
    within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Назад' }),
  );
  await heading('Дом приложения');
  expect(navModel().activeApp).toBe(MY_APP);
});

// ─── (е) ссылка внутри страницы «Записи» ───────────────────────────────────────────────────────

test('(е) строка на странице «Записи» открывает запись в рамке хоста, в том же разделе', async () => {
  resetFrame(`/r/${RECORDS}`);
  renderApp();
  await heading('Записи');
  fireEvent.click(await screen.findByTestId('entity-row'));
  await heading('Купить хлеб');
  expect(navModel().activeApp).toBe('host');
  expect(shownPath()).toBe(`/r/${BREAD}`);
});

// ─── (ж) повторное нажатие на активный раздел ─────────────────────────────────────────────────

test('(ж) повторное нажатие на активный раздел — его корень', async () => {
  resetFrame('/');
  renderApp();
  await heading('Домой');
  fireEvent.click(screen.getByTestId('nav-switch'));
  fireEvent.click(await screen.findByTestId(`nav-section-${UPCOMING}`));
  await heading('Upcoming');
  act(() => useNav.getState().openRecord(BREAD));
  await heading('Купить хлеб');
  fireEvent.click(screen.getByTestId('nav-switch'));
  fireEvent.click(await screen.findByTestId(`nav-section-${UPCOMING}`));
  await heading('Upcoming');
  expect(navModel().apps.host?.stacks[UPCOMING]).toHaveLength(1);
});

test('⌂ хоста из приложения — «Домой» хоста одним переходом (R-23)', async () => {
  resetFrame(`/r/${MY_SECTION}`);
  renderApp();
  await heading('Ремонт');
  fireEvent.click(
    within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Домой' }),
  );
  await heading('Домой');
  expect(shownPath()).toBe('/');
  expect(navModel().apps.host?.stacks.home?.[0]?.address).toEqual({
    kind: 'home',
    app: { kind: 'host' },
  });
  expect(HOME).toBeTruthy();
});
