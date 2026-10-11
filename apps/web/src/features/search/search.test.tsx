/**
 * Поиск хоста (срез 1б §6.3, §6.4, §7.3, §9.6; С1б-2, С1б-3, С1б-12, С1б-16): 🔍 и ⌘K, три группы
 * одной пачкой `entity.blocks`, адрес `/search?q=` заменой (ввод — не шаги истории), найденное —
 * правилом открытия из хоста; на телефоне — экран хоста поверх раздела с полем внизу, на десктопе —
 * окно вверху по центру, которое не элемент истории.
 *
 * Рисуется `<App/>` целиком (образец — `app/nav.test.tsx`): поиск — это рамка, стор навигации и
 * история вместе. `matchMedia` в jsdom нет — заглушка здесь же отвечает по запросу: брейкпоинт
 * десктопа — по случаю, `display-mode: standalone` — по режиму запуска.
 */
import {
  APP_ASPECT,
  APP_DISABLED,
  type BlockResult,
  type EntityBlocksResult,
  entityBlocksInput,
  PAGE_ASPECT,
} from '@orbis/shared';
import { currentEntry } from '@orbis/shared/nav';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../App';
import {
  AGENDA,
  BREAD,
  frameHandler,
  frameWorld,
  MY_APP,
  navModel,
  PAGES,
  RECORDS_WORLD,
  resetFrame,
  SHELL_ROW,
  shownPath,
  unstubLaunchMode,
} from '../../app/frame/frame-fixtures';
import { DESKTOP_QUERY } from '../../app/frame/useViewport';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import {
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  type WireEntityFixture,
  wireEntity,
} from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { useSearchDialog } from './search-dialog-store';
import { SEARCH_GROUPS, type SearchGroup, searchBlockTexts } from './search-query';

const id = (n: number) => `00000000-0000-4000-8000-0000000024${String(n).padStart(2, '0')}`;

/** Обычная запись, страница хоста (в «Записях» скрыта, §9.6), выключенное приложение, заметка. */
const MOVE_TASK = id(1);
const MOVE_PAGE = id(2);
const DACHA = id(3);
const HOUSE_NOTE = id(4);

const SEARCH_RECORDS: readonly WireEntityFixture[] = [
  wireEntity({ id: MOVE_TASK, title: 'Переезд — коробки' }),
  wireEntity({ id: MOVE_PAGE, title: 'Переезд — план', aspects: [PAGE_ASPECT], body: 'План.' }),
  wireEntity({
    id: DACHA,
    title: 'Дача',
    emoji: '🌲',
    aspects: [APP_ASPECT],
    props: { [APP_DISABLED]: true },
  }),
  wireEntity({ id: HOUSE_NOTE, title: 'Мой дом: заметки' }),
];

const byId = new Map(
  [...RECORDS_WORLD, ...SEARCH_RECORDS].map((e): [string, WireEntityFixture] => [e.id, e]),
);
const row = (rid: string) => byId.get(rid) as WireEntityFixture;

type Groups = Partial<Record<SearchGroup, { rows: readonly string[]; more?: number }>>;

/** Что «сервер» находит по строке. Строки нет в карте — пусто во всех группах. */
const FOUND: Readonly<Record<string, Groups>> = {
  переезд: {
    records: { rows: [MOVE_TASK], more: 2 },
    pages: { rows: [MOVE_PAGE] },
    // «Мой дом» — запись-приложение: в «Записях» она скрыта, в поиске — своей группой (§9.6).
    apps: { rows: [MY_APP] },
  },
  еда: { records: { rows: [BREAD] } },
  дача: { apps: { rows: [DACHA] } },
  'мой дом': { records: { rows: [HOUSE_NOTE] }, apps: { rows: [MY_APP] } },
};

function searchHandler(): MockHandler {
  const world = frameWorld({
    all: [SHELL_ROW, ...PAGES, ...RECORDS_WORLD, ...SEARCH_RECORDS],
  });
  const base = frameHandler(world);
  const byText = new Map<string, BlockResult>();
  for (const [q, groups] of Object.entries(FOUND)) {
    const texts = searchBlockTexts(q);
    if (texts === null) throw new Error(`пустая строка в FOUND: ${q}`);
    for (const g of SEARCH_GROUPS) {
      const found = groups[g];
      byText.set(texts[g], {
        ok: true,
        kind: 'rows',
        rows: (found?.rows ?? []).map(row) as never,
        more: found?.more ?? 0,
        closedIds: [],
      });
    }
  }
  return (path, input, type) => {
    // «Сервер» отвечает на те же тексты и обычным `entity.query`: поиск, ушедший мимо пачки, находит
    // то же самое — и тест краснеет на счёте пачек, а не на пустом экране (мутация (а) шага 6).
    if (path === 'entity.query') {
      const found = byText.get((input as { query?: string }).query ?? '');
      if (found?.ok && found.kind === 'rows') return found.rows;
    }
    const answer = base(path, input, type);
    if (path !== 'entity.blocks') return answer;
    const reply = answer as EntityBlocksResult;
    const results = { ...reply.results };
    for (const b of entityBlocksInput.parse(input).blocks) {
      if ('text' in b)
        results[b.key] = byText.get(b.text) ?? {
          ok: true,
          kind: 'rows',
          rows: [],
          more: 0,
          closedIds: [],
        };
    }
    // Верх пачки (`today`, `timeZone`) — из ответа рамки, не срезается.
    return { ...reply, results } satisfies EntityBlocksResult;
  };
}

/** `matchMedia` по запросу: брейкпоинт десктопа — `desktop`, установленное приложение — `mode`. */
function stubViewport(desktop: boolean, mode: 'app' | 'site' = 'site'): void {
  window.matchMedia = ((query: string) => ({
    matches: query === DESKTOP_QUERY ? desktop : mode === 'app' && query.includes('standalone'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

installCrashTrap();

beforeEach(() => {
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  vi.stubGlobal('requestIdleCallback', () => 1);
  stubViewport(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  unstubLaunchMode();
  act(() => useSearchDialog.getState().hide());
  resetFrame('/');
});

function renderApp() {
  return renderWithProviders(<App />, searchHandler());
}

/** Первое ожидание ленивого экрана (запись, поиск) — с запасом на сборку чанка (гейт 19, M-1). */
const heading = (name: string) =>
  screen.findByRole('heading', { level: 1, name }, { timeout: 5000 });

const searchButton = () =>
  within(screen.getByTestId('host-buttons')).getByRole('button', { name: 'Поиск' });

const back = () =>
  fireEvent.click(
    within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Назад' }),
  );

/**
 * Старт на «Домой» и переход в раздел «Повестка» — как человек: на телефоне листом разделов
 * («раздел ▾»), на десктопе — сайдбаром навигации (задача 25: «раздел ▾» там не рисуется).
 */
async function startOnAgenda() {
  resetFrame('/');
  const r = renderApp();
  await heading('Домой');
  // Десктоп: пока едет ленивый чанк рамки десктопа, стоит рамка телефона (гейт 25, m-5) — ждём рейку.
  if (window.matchMedia?.('(min-width: 768px)').matches) {
    await screen.findByTestId('host-rail', {}, { timeout: 5000 });
  }
  const sheet = screen.queryByTestId('nav-switch');
  if (sheet !== null) fireEvent.click(sheet);
  fireEvent.click(await screen.findByTestId(`nav-section-${AGENDA}`));
  await heading('Повестка');
  return r;
}

/** Телефон: 🔍 → экран «Поиск», поле ввода. */
async function openSearchScreen() {
  fireEvent.click(searchButton());
  await heading('Поиск');
  return screen.getByLabelText('Строка поиска');
}

const blocksCalls = (calls: readonly { path: string; input: unknown }[]) =>
  calls
    .filter((c) => c.path === 'entity.blocks')
    .map((c) => (c.input as { blocks: { text?: string }[] }).blocks);

const groupNames = () =>
  within(screen.getByTestId('search-results'))
    .getAllByRole('group')
    .map((g) => g.getAttribute('aria-label'));

const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

// ─── телефон ──────────────────────────────────────────────────────────────────────────────────

test('1. телефон: 🔍 на разделе — экран «Поиск» поверх раздела, поле внизу в фокусе, рамка на месте', async () => {
  await startOnAgenda();
  const field = await openSearchScreen();
  expect(shownPath()).toBe('/search');
  // Поверх раздела: экран хоста — в стопке «Повестка», раздел под ним.
  const host = navModel().apps.host;
  expect(host?.activeSection).toBe(AGENDA);
  expect(host?.stacks[AGENDA]?.map((e) => e.address)).toEqual([
    { kind: 'record', app: { kind: 'host' }, id: AGENDA },
    { kind: 'host-screen', screen: 'search' },
  ]);
  await waitFor(() => expect(field).toHaveFocus());
  expect(field).toHaveAttribute('placeholder', 'Найти запись, страницу или приложение');
  // Поле — ПОСЛЕ результатов в порядке документа: строка ввода внизу, над клавиатурой (§6.4).
  const results = screen.getByTestId('search-results');
  expect(results.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByTestId('host-presence')).toBeInTheDocument();
  expect(screen.getByTestId('host-buttons')).toBeInTheDocument();
});

test('2. ввод «переезд» — ОДНА пачка entity.blocks из трёх текстов, ни одного entity.query; группы по порядку', async () => {
  const { calls } = await startOnAgenda();
  const field = await openSearchScreen();
  const before = calls.length;
  fireEvent.change(field, { target: { value: 'переезд' } });
  const results = screen.getByTestId('search-results');
  await within(results).findByText('Переезд — коробки');

  const texts = searchBlockTexts('переезд');
  const since = calls.slice(before);
  const batches = blocksCalls(since);
  expect(batches).toHaveLength(1);
  expect(batches[0]?.map((b) => b.text).sort()).toEqual(
    [texts?.records, texts?.pages, texts?.apps].sort(),
  );
  expect(
    since.filter((c) => c.path === 'entity.query' && JSON.stringify(c.input).includes('search=')),
  ).toEqual([]);

  expect(groupNames()).toEqual(['Записи', 'Страницы', 'Приложения']);
  const records = within(results).getByRole('group', { name: 'Записи' });
  expect(records).toHaveTextContent('и ещё 2');
  // Страница и приложение, скрытые из «Записей» (§9.6), — в своих группах.
  expect(within(records).queryByText('Переезд — план')).toBeNull();
  expect(within(results).getByRole('group', { name: 'Страницы' })).toHaveTextContent(
    'Переезд — план',
  );
  expect(within(results).getByRole('group', { name: 'Приложения' })).toHaveTextContent('Мой дом');
});

test('3. ввод заменяет адрес на /search?q=… (replaceState) — история не растёт', async () => {
  await startOnAgenda();
  const field = await openSearchScreen();
  const length = window.history.length;
  const push = vi.spyOn(window.history, 'pushState');
  fireEvent.change(field, { target: { value: 'переезд' } });
  await waitFor(() =>
    expect(shownPath()).toBe('/search?q=%D0%BF%D0%B5%D1%80%D0%B5%D0%B5%D0%B7%D0%B4'),
  );
  expect(window.history.length).toBe(length);
  expect(push).not.toHaveBeenCalled();
});

test('4. найденная запись — правилом открытия из хоста; «‹» — в раздел, а не в поиск (§7.3)', async () => {
  // Режим приложения: «‹» идёт по модели (на сайте «назад» браузера честно вернул бы в поиск, R-30).
  stubViewport(false, 'app');
  await startOnAgenda();
  const field = await openSearchScreen();
  fireEvent.change(field, { target: { value: 'переезд' } });
  fireEvent.click(
    await within(screen.getByTestId('search-results')).findByText('Переезд — коробки'),
  );
  await heading('Переезд — коробки');
  expect(shownPath()).toBe(`/r/${MOVE_TASK}`);
  expect(navModel().activeApp).toBe('host');
  back();
  await heading('Повестка');
  expect(shownPath()).toBe(`/r/${AGENDA}`);
});

test('5. найденное приложение — переключение (/a/<id>); выключенное — приглушено, по нажатию — плашка', async () => {
  await startOnAgenda();
  let field = await openSearchScreen();
  fireEvent.change(field, { target: { value: 'переезд' } });
  const apps = await within(screen.getByTestId('search-results')).findByRole('group', {
    name: 'Приложения',
  });
  fireEvent.click(within(apps).getByText('Мой дом'));
  await heading('Дом приложения');
  expect(shownPath()).toBe(`/a/${MY_APP}`);
  expect(navModel().activeApp).toBe(MY_APP);

  field = await openSearchScreen();
  fireEvent.change(field, { target: { value: 'дача' } });
  const hit = await screen.findByTestId(`search-hit-${DACHA}`);
  expect(hit).toHaveAttribute('data-disabled');
  expect(hit).toHaveTextContent('выключено');
  fireEvent.click(hit);
  expect(await screen.findByTestId('open-plaque', {}, { timeout: 5000 })).toHaveTextContent(
    'Дача выключено',
  );
  expect(shownPath()).toBe(`/a/${DACHA}`);
});

test('6. старт на /search?q=еда — экран «Поиск» с «еда» в поле, одна пачка; пустая группа не рисуется', async () => {
  resetFrame('/search?q=%D0%B5%D0%B4%D0%B0');
  const { calls } = renderApp();
  await heading('Поиск');
  expect(screen.getByLabelText('Строка поиска')).toHaveValue('еда');
  await within(screen.getByTestId('search-results')).findByText('Купить хлеб');
  await pause(300);
  const texts = searchBlockTexts('еда');
  const batches = blocksCalls(calls);
  expect(batches).toHaveLength(1);
  expect(batches[0]?.map((b) => b.text).sort()).toEqual(
    [texts?.records, texts?.pages, texts?.apps].sort(),
  );
  expect(groupNames()).toEqual(['Записи']);
});

test('7. пустое поле (и одни пробелы) — ни одного entity.blocks', async () => {
  const { calls } = await startOnAgenda();
  const field = await openSearchScreen();
  const before = calls.length;
  await pause(300);
  fireEvent.change(field, { target: { value: '   ' } });
  await pause(300);
  expect(blocksCalls(calls.slice(before))).toEqual([]);
  expect(screen.queryByText('Ничего не найдено')).toBeNull();
});

test('«Ничего не найдено» — когда все три группы пусты', async () => {
  await startOnAgenda();
  const field = await openSearchScreen();
  fireEvent.change(field, { target: { value: 'кит' } });
  expect(
    await within(screen.getByTestId('search-results')).findByText('Ничего не найдено'),
  ).toBeInTheDocument();
});

test('↓ и Enter — выбор второго результата с клавиатуры', async () => {
  stubViewport(false, 'app');
  await startOnAgenda();
  const field = await openSearchScreen();
  fireEvent.change(field, { target: { value: 'переезд' } });
  await within(screen.getByTestId('search-results')).findByText('Переезд — план');
  fireEvent.keyDown(field, { key: 'ArrowDown' });
  fireEvent.keyDown(field, { key: 'Enter' });
  await heading('Переезд — план');
  expect(shownPath()).toBe(`/r/${MOVE_PAGE}`);
});

// ─── десктоп ──────────────────────────────────────────────────────────────────────────────────

test('8. десктоп: 🔍, ⌘K и Ctrl+K — окно вверху, не элемент истории; Enter — запись в основной области, «‹» — прежнее место', async () => {
  // Режим приложения: «‹» идёт по модели — видно, куда легла запись (источник — текущий раздел).
  stubViewport(true, 'app');
  await startOnAgenda();
  // Прежнее место — экран хоста поверх раздела: окно ⌘K не должно его снять (его в стопке нет).
  act(() => useNav.getState().openHostScreen('settings'));
  await heading('Настройки');
  const model = navModel();
  const path = shownPath();
  const length = window.history.length;

  fireEvent.click(searchButton());
  // Окно — не элемент истории: нажатие не трогает ни модель, ни адрес, ни историю вкладки (§7.3).
  expect(navModel()).toEqual(model);
  expect(shownPath()).toBe(path);
  expect(window.history.length).toBe(length);
  let dialog = await screen.findByRole('dialog', { name: 'Поиск' }, { timeout: 5000 });
  expect(screen.queryByRole('heading', { level: 1, name: 'Поиск' })).toBeNull();
  await waitFor(() => expect(within(dialog).getByLabelText('Строка поиска')).toHaveFocus());

  fireEvent.keyDown(within(dialog).getByLabelText('Строка поиска'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Поиск' })).toBeNull());

  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  dialog = await screen.findByRole('dialog', { name: 'Поиск' });
  fireEvent.keyDown(within(dialog).getByLabelText('Строка поиска'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Поиск' })).toBeNull());

  fireEvent.keyDown(window, { key: 'K', ctrlKey: true });
  dialog = await screen.findByRole('dialog', { name: 'Поиск' });
  expect(navModel()).toEqual(model);
  expect(shownPath()).toBe(path);

  const field = within(dialog).getByLabelText('Строка поиска');
  fireEvent.change(field, { target: { value: 'мой дом' } });
  await within(dialog).findByText('Мой дом: заметки');
  // Ввод в окне адрес не трогает: окна в истории нет.
  expect(shownPath()).toBe(path);
  fireEvent.keyDown(field, { key: 'Enter' });
  await heading('Мой дом: заметки');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Поиск' })).toBeNull());
  expect(shownPath()).toBe(`/r/${HOUSE_NOTE}`);
  expect(navModel().activeApp).toBe('host');

  back();
  // «‹» — прежнее место текущего раздела: экран настроек, над которым открыли окно, а не раздел под ним.
  expect(currentEntry(navModel()).address).toEqual({ kind: 'host-screen', screen: 'settings' });
  await heading('Настройки');
  expect(shownPath()).toBe('/settings');
}, 15_000);

test('8. десктоп, сайт: 🔍 не пишет в историю вкладки', async () => {
  stubViewport(true, 'site');
  await startOnAgenda();
  const push = vi.spyOn(window.history, 'pushState');
  const replace = vi.spyOn(window.history, 'replaceState');
  const length = window.history.length;
  fireEvent.click(searchButton());
  expect(push).not.toHaveBeenCalled();
  expect(shownPath()).toBe(`/r/${AGENDA}`);
  await screen.findByRole('dialog', { name: 'Поиск' }, { timeout: 5000 });
  fireEvent.change(screen.getByLabelText('Строка поиска'), { target: { value: 'переезд' } });
  await screen.findByText('Переезд — коробки');
  expect(push).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  expect(window.history.length).toBe(length);
  expect(shownPath()).toBe(`/r/${AGENDA}`);
});

test('9. телефон: ⌘K открывает экран поиска — тот же путь, что 🔍', async () => {
  await startOnAgenda();
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  await heading('Поиск');
  expect(shownPath()).toBe('/search');
  expect(screen.queryByRole('dialog', { name: 'Поиск' })).toBeNull();
});

// ─── фикс гейта 24 ──────────────────────────────────────────────────────────────────────────────

test('M-1: поле очищено — Enter не открывает прежний, уже невидимый результат', async () => {
  await startOnAgenda();
  const field = await openSearchScreen();
  fireEvent.change(field, { target: { value: 'переезд' } });
  await within(screen.getByTestId('search-results')).findByText('Переезд — коробки');
  fireEvent.change(field, { target: { value: '' } });
  await waitFor(() =>
    expect(
      within(screen.getByTestId('search-results')).queryByText('Переезд — коробки'),
    ).toBeNull(),
  );
  await pause(300);
  fireEvent.keyDown(field, { key: 'Enter' });
  await pause(50);
  expect(currentEntry(navModel()).address).toMatchObject({ kind: 'host-screen', screen: 'search' });
  expect(screen.queryByRole('heading', { level: 1, name: 'Переезд — коробки' })).toBeNull();
});

test('M-2: 🔍 на экране поиска (телефон, сайт) — место, адрес, строка и история те же', async () => {
  resetFrame('/search?q=%D0%B5%D0%B4%D0%B0');
  renderApp();
  await heading('Поиск');
  await within(screen.getByTestId('search-results')).findByText('Купить хлеб');
  const model = navModel();
  const length = window.history.length;
  const push = vi.spyOn(window.history, 'pushState');
  fireEvent.click(searchButton());
  expect(navModel()).toEqual(model);
  expect(push).not.toHaveBeenCalled();
  expect(window.history.length).toBe(length);
  expect(shownPath()).toBe('/search?q=%D0%B5%D0%B4%D0%B0');
  expect(screen.getByLabelText('Строка поиска')).toHaveValue('еда');
});

test('M-3: Ctrl+K в русской раскладке (key «л», code KeyK) — тот же поиск: окно на десктопе, экран на телефоне', async () => {
  stubViewport(true);
  await startOnAgenda();
  fireEvent.keyDown(window, { key: 'л', code: 'KeyK', ctrlKey: true });
  expect(useSearchDialog.getState().open).toBe(true);
  const dialog = await screen.findByRole('dialog', { name: 'Поиск' }, { timeout: 5000 });
  fireEvent.keyDown(within(dialog).getByLabelText('Строка поиска'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Поиск' })).toBeNull());

  stubViewport(false);
  fireEvent.keyDown(window, { key: 'л', code: 'KeyK', metaKey: true });
  await heading('Поиск');
  expect(shownPath()).toBe('/search');
  // Без модификатора «л» — просто буква.
  const model = navModel();
  fireEvent.keyDown(window, { key: 'л', code: 'KeyK' });
  expect(navModel()).toEqual(model);
});

test('M-6: Colemak/Dvorak — физическая K с латинской буквой (Ctrl+E, Ctrl+T) остаётся браузеру', async () => {
  stubViewport(true);
  await startOnAgenda();
  for (const key of ['e', 't']) {
    const ev = new KeyboardEvent('keydown', { key, code: 'KeyK', ctrlKey: true, cancelable: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect([key, ev.defaultPrevented, useSearchDialog.getState().open]).toEqual([
      key,
      false,
      false,
    ]);
  }
  // Буква «k» на любой физической клавише (Dvorak: K на месте QWERTY «V») — поиск.
  fireEvent.keyDown(window, { key: 'k', code: 'KeyV', ctrlKey: true });
  expect(useSearchDialog.getState().open).toBe(true);
});
