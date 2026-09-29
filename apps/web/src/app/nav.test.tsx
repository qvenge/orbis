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
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../lib/registry/useRegistry';
import { resetNavForTests, useNav } from '../state/navigation';
import { installCrashTrap, renderWithProviders } from '../test/harness';
import { BUILTIN_REGISTRY } from '../test/registry';
import {
  AGENDA,
  BREAD,
  chatMessage,
  frameHandler,
  frameWorld,
  GLOBAL_THREAD,
  MY_APP,
  MY_HOME,
  MY_SECTION,
  NOTE,
  NOTE_THREAD,
  navModel,
  PAGES,
  RECORDS,
  RECORDS_WORLD,
  resetFrame,
  SHELL_ROW,
  shownPath,
  stubLaunchMode,
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

/**
 * Первое ожидание экрана записи ждёт ленивый чанк `DetailScreen`: на холодном кеше vite/vitest его
 * сборка занимает больше секунды умолчания Testing Library (гейт 19, M-1) — запас в пять секунд.
 */
const heading = (name: string) =>
  screen.findByRole('heading', { level: 1, name }, { timeout: 5000 });

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

// Срез 1в §6.2 (РП-16): `/agenda` — не плашка, а запись поставки «Повестка» разделом хоста; закладка
// из старой вкладки ведёт туда же.
test('(а) /agenda — запись поставки «Повестка» разделом хоста, адрес заменён на /r/<id>', async () => {
  resetFrame('/agenda');
  renderApp();
  await heading('Повестка');
  expect(shownPath()).toBe(`/r/${AGENDA}`);
  expect(screen.getByTestId('nav-switch')).toHaveTextContent('Повестка');
  expect(screen.queryByTestId('reserved-screen')).toBeNull();
});

test('(а) /agenda без записи «Повестка» (в архиве, выведена) — «Домой» хоста', async () => {
  resetFrame('/agenda');
  renderApp(frameWorld({ supply: [SHELL_ROW, ...PAGES.filter((p) => p.id !== AGENDA)] }));
  await heading('Домой');
  expect(shownPath()).toBe('/');
  expect(screen.queryByTestId('reserved-screen')).toBeNull();
});

test('(а) /browser при «Записях» в архиве — «Домой» хоста, а не сохранённое место (финал C1 M-2)', async () => {
  resetFrame('/browser');
  // Сохранённое активное место — запись в «Моём доме»: фолбэк не должен её показать.
  localStorage.setItem(
    NAV_STORAGE_KEY,
    JSON.stringify({
      v: 2,
      activeApp: MY_APP,
      apps: {
        [MY_APP]: {
          activeSection: 'home',
          last: { home: { kind: 'record', app: { kind: 'app', ref: MY_APP }, id: MY_SECTION } },
        },
      },
    }),
  );
  renderApp(frameWorld({ supply: [SHELL_ROW, ...PAGES.filter((p) => p.id !== RECORDS)] }));
  await heading('Домой');
  expect(shownPath()).toBe('/');
  expect(navModel().activeApp).toBe('host');
  expect(navModel().apps.host?.activeSection).toBe('home');
});

test.each([
  ['/budget/category/00000000-0000-4000-8000-000000009999', 'Бюджет придёт со следующим срезом'],
  ['/budget', 'Бюджет придёт со следующим срезом'],
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
  fireEvent.click(await screen.findByTestId(`nav-section-${AGENDA}`));
  await heading('Повестка');
  expect(push).toHaveBeenCalledTimes(1);
  expect(shownPath()).toBe(`/r/${AGENDA}`);
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
  fireEvent.click(await screen.findByTestId(`nav-section-${AGENDA}`));
  await heading('Повестка');
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
  await heading('Повестка');
  expect(shownPath()).toBe(`/r/${AGENDA}`);
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

test('(г) перезапуск в режиме приложения: активный раздел и его последнее место — из orbis:nav:v2, глубина — нет', async () => {
  // Режим приложения: `/` — адрес иконки, открывается сохранённое место (R-32, §7.3).
  stubLaunchMode('app');
  resetFrame('/');
  const first = renderApp();
  await heading('Домой');
  fireEvent.click(screen.getByTestId('nav-switch'));
  fireEvent.click(await screen.findByTestId(`nav-section-${AGENDA}`));
  await heading('Повестка');
  act(() => useNav.getState().openRecord(BREAD));
  await heading('Купить хлеб');
  first.unmount();

  // Новый запуск: истории нет, в хранилище — сохранение v2.
  act(() => resetNavForTests());
  window.history.replaceState(null, '', '/');
  renderApp();
  await heading('Купить хлеб');
  expect(screen.getByTestId('nav-switch')).toHaveTextContent('Повестка');
  const host = navModel().apps.host;
  expect(host?.activeSection).toBe(AGENDA);
  expect(host?.stacks[AGENDA]).toHaveLength(1);
});

test('(г) сайт: `/` — домашняя хоста, последние места разделов из orbis:nav:v2 — в модели (R-32)', async () => {
  resetFrame('/');
  const first = renderApp();
  await heading('Домой');
  fireEvent.click(screen.getByTestId('nav-switch'));
  fireEvent.click(await screen.findByTestId(`nav-section-${AGENDA}`));
  await heading('Повестка');
  act(() => useNav.getState().openRecord(BREAD));
  await heading('Купить хлеб');
  first.unmount();

  // Новая вкладка на `/`: адрес главнее — «Домой», а «где остановились» Повестка на месте.
  act(() => resetNavForTests());
  window.history.replaceState(null, '', '/');
  renderApp();
  await heading('Домой');
  expect(shownPath()).toBe('/');
  expect(navModel().apps.host?.stacks[AGENDA]?.map((e) => e.address)).toEqual([
    { kind: 'record', app: { kind: 'host' }, id: BREAD },
  ]);
  fireEvent.click(screen.getByTestId('nav-switch'));
  await waitFor(() =>
    expect(screen.getByTestId(`nav-section-${AGENDA}`)).toHaveTextContent('Повестка · Купить хлеб'),
  );
});

test('сайт: после перезагрузки на корне раздела с записью Orbis позади «‹» есть с первого кадра (гейт 19, Fable M-4)', async () => {
  resetFrame('/');
  const first = renderApp();
  await heading('Домой');
  fireEvent.click(screen.getByTestId('nav-switch'));
  fireEvent.click(await screen.findByTestId(`nav-section-${AGENDA}`));
  await heading('Повестка');
  first.unmount();

  // Перезагрузка: запись истории своя (idx 1), модель — из её снимка; корень раздела — по модели
  // идти некуда, но позади — «Домой». Сеть молчит: ни один ответ не перерисует шапку — «‹» обязан
  // быть уже в первом кадре, а не появиться случайной перерисовкой.
  act(() => resetNavForTests());
  renderWithProviders(<App />, () => new Promise(() => {}));
  expect(
    within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Назад' }),
  ).toBeInTheDocument();
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

test('(д) сайт: ссылка из чата → запись; «‹» — «назад» браузера по порядку, то есть в чат (R-30)', async () => {
  resetFrame(`/a/${MY_APP}`);
  renderApp(frameWorld({ chat: [chatMessage('m1', `готово: [[entity:${BREAD}]]`)] }));
  await heading('Дом приложения');
  fireEvent.click(within(screen.getByTestId('host-buttons')).getByRole('button', { name: /Чат/ }));
  await heading('Чат');
  fireEvent.click(await screen.findByRole('link', { name: BREAD }));
  await heading('Купить хлеб');
  expect(navModel().activeApp).toBe('host');
  fireEvent.click(
    within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Назад' }),
  );
  await heading('Чат');
  expect(shownPath()).toBe('/chat');
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
  fireEvent.click(await screen.findByTestId(`nav-section-${AGENDA}`));
  await heading('Повестка');
  act(() => useNav.getState().openRecord(BREAD));
  await heading('Купить хлеб');
  fireEvent.click(screen.getByTestId('nav-switch'));
  fireEvent.click(await screen.findByTestId(`nav-section-${AGENDA}`));
  await heading('Повестка');
  expect(navModel().apps.host?.stacks[AGENDA]).toHaveLength(1);
});

test('⌂ телефона в приложении — его домашняя в его рамке (R-38, спека §4.2, приёмка №3)', async () => {
  resetFrame(`/a/${MY_APP}/r/${MY_SECTION}`);
  renderApp();
  await heading('Ремонт');
  expect(navModel().activeApp).toBe(MY_APP);
  expect(screen.getByTestId('nav-switch')).toHaveTextContent('🏡');
  fireEvent.click(
    within(screen.getByTestId('host-presence')).getByRole('button', {
      name: 'Домашняя приложения',
    }),
  );
  await heading('Дом приложения');
  expect(shownPath()).toBe(`/a/${MY_APP}`);
  expect(navModel().activeApp).toBe(MY_APP);
  expect(navModel().apps[MY_APP]?.activeSection).toBe('home');
  expect(screen.getByTestId('nav-switch')).toHaveTextContent('🏡');
});

test('⌂ телефона в хосте — «Домой» хоста (R-23 для хоста в силе)', async () => {
  resetFrame(`/r/${BREAD}`);
  renderApp();
  await heading('Купить хлеб');
  fireEvent.click(
    within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Домой' }),
  );
  await heading('Домой');
  expect(shownPath()).toBe('/');
  expect(navModel().activeApp).toBe('host');
  expect(navModel().apps.host?.activeSection).toBe('home');
});

test('домашняя своего приложения в архиве — ⌂ показывает плашку «Домашняя в архиве» (§6.6, R-38)', async () => {
  const all = [SHELL_ROW, ...PAGES, ...RECORDS_WORLD].map((e) =>
    e.id === MY_HOME ? { ...e, archived: true } : e,
  );
  resetFrame(`/a/${MY_APP}/r/${MY_SECTION}`);
  const { calls } = renderApp(frameWorld({ all }));
  await heading('Ремонт');
  fireEvent.click(
    within(screen.getByTestId('host-presence')).getByRole('button', {
      name: 'Домашняя приложения',
    }),
  );
  const plaque = await screen.findByTestId('home-archived');
  expect(plaque).toHaveTextContent('Домашняя в архиве');
  expect(navModel().activeApp).toBe(MY_APP);
  fireEvent.click(within(plaque).getByRole('button', { name: 'Восстановить' }));
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'entity.update').map((c) => c.input)).toEqual([
      { id: MY_HOME, archived: false },
    ]),
  );
});
