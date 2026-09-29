/**
 * Две рамки — один набор элементов хоста (спека 1б §6.3, §6.6, §7.3, С1б-7, С1б-3, Фокус «две рамки»).
 *
 * Телефон и десктоп — две реализации рамки: на телефоне ⌂ живёт в строке присутствия хоста, а
 * навигация приложения — в листе «раздел ▾»; на десктопе ⌂ — в тёмной рейке слева, навигация — в
 * сайдбаре, шапка содержимого несёт только «‹ ⋯». Набор элементов хоста по ролям (`data-host`) обязан
 * совпадать на обеих ширинах: иначе одна из форм молча потеряла бы кнопку хоста (Э-13).
 *
 * Рисуется `<App/>` целиком: ширину выбирает `AppShell` в JS (`useIsDesktop`), и тест обязан видеть
 * ровно одну рамку на ширину — CSS-скрытая вторая дала бы повторы.
 */
import { APP_ASPECT, APP_DISABLED, APP_HOME, APP_NAV, APP_NAV_FORM } from '@orbis/shared';
import { HOST_APP } from '@orbis/shared/nav';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../../App';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import { installCrashTrap, renderWithProviders, wireEntity } from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { preloadDesktopFrame, resetDesktopFrameLoadForTests } from '../AppShell';
import {
  AGENDA,
  ALL_TASKS,
  BREAD,
  chatMessage,
  frameHandler,
  frameWorld,
  MY_APP,
  MY_HOME,
  MY_SECTION,
  NAV_IDS,
  NOTE,
  navModel,
  PAGES,
  RECORDS_WORLD,
  resetFrame,
  SHELL_ROW,
  shownPath,
  stubViewport,
  unstubLaunchMode,
} from './frame-fixtures';
import { HOST_ELEMENTS } from './host-elements';
import { useSideChat } from './side-chat-store';

installCrashTrap();

beforeEach(() => {
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  vi.stubGlobal('requestIdleCallback', () => 1);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Глушение `console.error` в тестах I-1 не тянется на следующие тесты файла.
  vi.restoreAllMocks();
  unstubLaunchMode();
  act(() => useSideChat.setState({ open: false }));
  resetFrame('/');
});

function renderApp(world = frameWorld()) {
  return renderWithProviders(<App />, frameHandler(world));
}

/** Ленивые чанки (экран записи, рамка десктопа) на холодном кеше vitest — дольше секунды. */
const heading = (name: string) =>
  screen.findByRole('heading', { level: 1, name }, { timeout: 5000 });
const byTestId = (id: string) => screen.findByTestId(id, {}, { timeout: 5000 });

/** Роли элементов хоста, как их видит DOM, — по порядку документа. */
const hostRoles = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-host]')].map((e) => e.dataset.host ?? '');

/** Запись «Купить хлеб», открытая вглубь из раздела «Повестка» (глубина 1). */
async function openBreadFromAgenda() {
  await heading('Домой');
  act(() => useNav.getState().openSection(HOST_APP, AGENDA));
  await heading('Повестка');
  act(() => useNav.getState().openRecord(BREAD));
  await heading('Купить хлеб');
}

const hostButtons = () => screen.getByTestId('host-buttons');
const chatButton = () => within(hostButtons()).getByRole('button', { name: /Чат/ });

// ─── (а) один набор элементов хоста на обеих ширинах ──────────────────────────────────────────

describe.each([
  ['телефон', false],
  ['десктоп', true],
] as const)('(а) %s: элементы хоста (С1б-7)', (_name, desktop) => {
  test('набор ролей `data-host` = HOST_ELEMENTS, без повторов; нижней навигации нет', async () => {
    stubViewport(desktop);
    resetFrame('/');
    renderApp();
    await openBreadFromAgenda();
    if (desktop) await byTestId('host-rail');
    const roles = hostRoles();
    // Без повторов: длина списка — длина множества.
    expect(roles).toHaveLength(new Set(roles).size);
    expect([...roles].sort()).toEqual([...HOST_ELEMENTS].sort());
    expect(screen.queryByTestId('tab-bar')).toBeNull();

    const presence = screen.getByTestId('host-presence');
    expect(within(presence).getByRole('button', { name: 'Назад' })).toBeInTheDocument();
    expect(within(presence).getByRole('button', { name: 'Меню' })).toBeInTheDocument();
    if (desktop) {
      expect(screen.getByTestId('host-rail')).toBeInTheDocument();
      expect(screen.getByTestId('app-sidebar')).toBeInTheDocument();
      // ⌂ живёт в рейке, «раздел ▾» — в сайдбаре: шапка содержимого — «‹ · заголовок · ⋯».
      expect(within(presence).queryByRole('button', { name: 'Домой' })).toBeNull();
      expect(within(presence).queryByTestId('nav-switch')).toBeNull();
      expect(
        within(screen.getByTestId('host-rail')).getByRole('button', { name: 'Домой' }),
      ).toHaveAttribute('data-host', 'home');
    } else {
      expect(screen.queryByTestId('host-rail')).toBeNull();
      expect(screen.queryByTestId('app-sidebar')).toBeNull();
      expect(within(presence).getByRole('button', { name: 'Домой' })).toHaveAttribute(
        'data-host',
        'home',
      );
    }
  });
});

// ─── (б) рейка хоста ──────────────────────────────────────────────────────────────────────────

const OFF_APP = '00000000-0000-4000-8000-000000002540';
const GONE_APP = '00000000-0000-4000-8000-000000002541';
const NAMELESS_APP = '00000000-0000-4000-8000-000000002542';

describe('(б) десктоп: тёмная рейка хоста «куда» (§6.3)', () => {
  test('⌂ рейки ИЗ ПРИЛОЖЕНИЯ — «Домой» хоста, а не домашняя приложения рамки (R-38, раунд 2 финала I-1)', async () => {
    stubViewport(true);
    resetFrame(`/a/${MY_APP}/r/${MY_SECTION}`);
    renderApp();
    const rail = await byTestId('host-rail');
    await heading('Ремонт');
    expect(navModel().activeApp).toBe(MY_APP);
    fireEvent.click(within(rail).getByRole('button', { name: 'Домой' }));
    await heading('Домой');
    expect(shownPath()).toBe('/');
    expect(navModel().activeApp).toBe(HOST_APP);
  });

  test('кадр отказа рейки: ⌂ ИЗ ПРИЛОЖЕНИЯ — тоже «Домой» хоста (R-38, раунд 2 финала I-1)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubViewport(true);
    resetFrame(`/a/${MY_APP}/r/${MY_SECTION}`);
    const base = frameWorld();
    renderApp(
      frameWorld({
        all: [
          ...base.all,
          // Приложение без имени — рейка бросает (как в тесте кадра отказа ниже).
          wireEntity({
            id: OFF_APP,
            title: null as unknown as string,
            aspects: [APP_ASPECT],
            props: { [APP_NAV]: [] },
          }),
        ],
      }),
    );
    await heading('Ремонт');
    await waitFor(() => expect(screen.getByTestId('host-rail')).toHaveAttribute('data-failed'));
    expect(navModel().activeApp).toBe(MY_APP);
    fireEvent.click(within(screen.getByTestId('host-rail')).getByRole('button', { name: 'Домой' }));
    await heading('Домой');
    expect(shownPath()).toBe('/');
    expect(navModel().activeApp).toBe(HOST_APP);
  });

  test('⌂ — домашняя хоста; приложение — одним нажатием, активное отмечено; выключенное приглушено, архивного нет; «Настройки» внизу', async () => {
    stubViewport(true);
    resetFrame(`/r/${BREAD}`);
    const base = frameWorld();
    renderApp(
      frameWorld({
        all: [
          ...base.all,
          wireEntity({
            id: OFF_APP,
            title: 'Отпуск',
            aspects: [APP_ASPECT],
            props: { [APP_NAV]: [], [APP_DISABLED]: true },
          }),
          wireEntity({
            id: NAMELESS_APP,
            title: '',
            aspects: [APP_ASPECT],
            props: { [APP_NAV]: [] },
          }),
          wireEntity({
            id: GONE_APP,
            title: 'Старое',
            archived: true,
            aspects: [APP_ASPECT],
            props: { [APP_NAV]: [] },
          }),
        ],
      }),
    );
    const rail = await byTestId('host-rail');
    await heading('Купить хлеб');

    fireEvent.click(within(rail).getByRole('button', { name: 'Домой' }));
    await heading('Домой');
    expect(shownPath()).toBe('/');

    const mine = await within(rail).findByRole('button', { name: 'Мой дом' });
    expect(mine).toHaveAttribute('title', 'Мой дом');
    expect(mine).not.toHaveAttribute('aria-current');
    fireEvent.click(mine);
    await heading('Дом приложения');
    expect(shownPath()).toBe(`/a/${MY_APP}`);
    expect(within(rail).getByRole('button', { name: 'Мой дом' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    const off = within(rail).getByRole('button', { name: 'Отпуск, выключено' });
    expect(off).toHaveAttribute('data-disabled');
    expect(off.className).toContain('opacity-50');
    expect(within(rail).queryByRole('button', { name: /Старое/ })).toBeNull();

    // Приложение без имени — названная кнопка с видимым глифом, а не пустая (гейт 25, m-7).
    const nameless = within(rail).getByRole('button', { name: 'Без названия' });
    expect(nameless).toHaveAttribute('title', 'Без названия');
    expect(nameless.textContent?.trim()).not.toBe('');

    const settings = within(rail).getByRole('button', { name: 'Настройки' });
    // «Настройки» — внизу рейки: последняя кнопка.
    expect(within(rail).getAllByRole('button').at(-1)).toBe(settings);
    fireEvent.click(settings);
    await heading('Настройки');
    expect(shownPath()).toBe('/settings');
  });
});

// ─── (в) сайдбар навигации ────────────────────────────────────────────────────────────────────

describe('(в) десктоп: сайдбар навигации текущего приложения (§6.3)', () => {
  test('разделы хоста в порядке оболочки, активный отмечен, «где остановились»; нажатие — место раздела', async () => {
    stubViewport(true);
    resetFrame('/');
    renderApp();
    const sidebar = await byTestId('app-sidebar');
    await openBreadFromAgenda();
    expect(within(sidebar).getByText('Orbis')).toBeInTheDocument();
    const rows = within(sidebar).getAllByTestId(/^nav-section-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(NAV_IDS.map((id) => `nav-section-${id}`));
    const agenda = within(sidebar).getByTestId(`nav-section-${AGENDA}`);
    expect(agenda).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(agenda).toHaveTextContent('Повестка · Купить хлеб'));

    fireEvent.click(within(sidebar).getByTestId(`nav-section-${ALL_TASKS}`));
    await heading('All Tasks');
    expect(shownPath()).toBe(`/r/${ALL_TASKS}`);
    expect(within(sidebar).getByTestId(`nav-section-${ALL_TASKS}`)).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('приложение формы «домашняя как центр» — на десктопе тоже сайдбар', async () => {
    stubViewport(true);
    resetFrame(`/a/${MY_APP}`);
    renderApp(
      frameWorld({
        all: [
          SHELL_ROW,
          ...PAGES,
          ...RECORDS_WORLD.map((e) =>
            e.id === MY_APP
              ? {
                  ...e,
                  props: {
                    [APP_HOME]: MY_HOME,
                    [APP_NAV]: [MY_SECTION],
                    [APP_NAV_FORM]: 'home-hub',
                  },
                }
              : e,
          ),
        ],
      }),
    );
    await heading('Дом приложения');
    const sidebar = await byTestId('app-sidebar');
    await waitFor(() => expect(within(sidebar).getByText('Мой дом')).toBeInTheDocument());
    const row = await within(sidebar).findByTestId(`nav-section-${MY_SECTION}`);
    expect(row).toHaveTextContent('Ремонт');
    fireEvent.click(row);
    await heading('Ремонт');
    expect(shownPath()).toBe(`/a/${MY_APP}/r/${MY_SECTION}`);
    // Одна стопка (§7.3): «Ремонт» лёг поверх домашней, а не завёл раздел — как плитка.
    expect(navModel().activeApp).toBe(MY_APP);
    expect(navModel().apps[MY_APP]?.activeSection).toBe('home');
    expect(navModel().apps[MY_APP]?.stacks.home).toHaveLength(2);
    expect(Object.keys(navModel().apps[MY_APP]?.stacks ?? {})).toEqual(['home']);
    // «‹» — на домашнюю приложения, а не в хост.
    fireEvent.click(within(screen.getByTestId('host-presence')).getByTestId('host-back'));
    await heading('Дом приложения');
    expect(shownPath()).toBe(`/a/${MY_APP}`);
    expect(navModel().activeApp).toBe(MY_APP);
  });
});

// ─── (г) боковой чат ──────────────────────────────────────────────────────────────────────────

describe('(г) боковой чат — не элемент истории (§6.3, §7.3, С1б-3)', () => {
  test('десктоп: 💬 открывает и закрывает боковой чат; место, адрес и история не меняются', async () => {
    stubViewport(true);
    resetFrame('/');
    renderApp();
    await byTestId('host-rail');
    await openBreadFromAgenda();
    const path = shownPath();
    const length = window.history.length;
    const model = navModel();

    expect(chatButton()).toHaveAttribute('aria-pressed', 'false');
    expect(chatButton()).toHaveAttribute('aria-controls', 'side-chat');
    fireEvent.click(chatButton());
    // Не элемент истории: ни адрес, ни история вкладки, ни модель навигации нажатие не трогает.
    expect(shownPath()).toBe(path);
    expect(window.history.length).toBe(length);
    expect(navModel()).toEqual(model);
    expect(chatButton()).toHaveAttribute('aria-pressed', 'true');
    const side = await screen.findByRole('complementary', { name: 'Чат' }, { timeout: 5000 });
    expect(side).toHaveAttribute('id', 'side-chat');
    // Данные видны, кнопки хоста на месте.
    expect(screen.getByRole('heading', { level: 1, name: 'Купить хлеб' })).toBeInTheDocument();
    expect(hostButtons()).toBeInTheDocument();
    expect(within(side).getByRole('textbox', { name: 'Сообщение' })).toBeInTheDocument();

    fireEvent.click(chatButton());
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Чат' })).toBeNull());
    expect(chatButton()).toHaveAttribute('aria-pressed', 'false');
    expect(navModel()).toEqual(model);

    // «Закрыть» в шапке бокового чата — то же, что второе 💬.
    fireEvent.click(chatButton());
    const again = await screen.findByRole('complementary', { name: 'Чат' });
    fireEvent.click(within(again).getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Чат' })).toBeNull());
    expect(navModel()).toEqual(model);
  });

  test('десктоп: ссылка из бокового чата — запись в основной области, чат открыт; «‹» — прежняя запись раздела', async () => {
    stubViewport(true, 'app');
    resetFrame('/');
    renderApp(frameWorld({ chat: [chatMessage('m1', `вот: [[entity:${NOTE}]]`)] }));
    await byTestId('host-rail');
    await openBreadFromAgenda();
    fireEvent.click(chatButton());
    const side = await screen.findByRole('complementary', { name: 'Чат' }, { timeout: 5000 });
    fireEvent.click(await within(side).findByRole('link', { name: NOTE }));
    await heading('Заметка');
    expect(screen.getByRole('complementary', { name: 'Чат' })).toBeInTheDocument();
    // Источник — текущий раздел основной области: запись легла в стопку «Повестка» хоста.
    expect(navModel().activeApp).toBe(HOST_APP);
    expect(navModel().apps[HOST_APP]?.activeSection).toBe(AGENDA);
    fireEvent.click(
      within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Назад' }),
    );
    await heading('Купить хлеб');
    expect(screen.getByRole('complementary', { name: 'Чат' })).toBeInTheDocument();
  });

  test('десктоп: основная область на экране хоста — ссылка из бокового чата его не снимает (чата в стопке нет)', async () => {
    stubViewport(true, 'app');
    resetFrame('/');
    renderApp(frameWorld({ chat: [chatMessage('m1', `вот: [[entity:${NOTE}]]`)] }));
    await byTestId('host-rail');
    await openBreadFromAgenda();
    fireEvent.click(
      within(screen.getByTestId('host-rail')).getByRole('button', { name: 'Настройки' }),
    );
    await heading('Настройки');
    fireEvent.click(chatButton());
    const side = await screen.findByRole('complementary', { name: 'Чат' }, { timeout: 5000 });
    fireEvent.click(await within(side).findByRole('link', { name: NOTE }));
    await heading('Заметка');
    // «‹» идёт по стопке основной области: на прежнее место — «Настройки». Правило `host-screen`
    // сняло бы со стопки экран, которого боковой чат не открывал.
    fireEvent.click(
      within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Назад' }),
    );
    // Экран настроек эагерный: ожидание по умолчанию, а не пять секунд ленивого чанка.
    await waitFor(() => expect(shownPath()).toBe('/settings'));
    expect(screen.getByRole('heading', { level: 1, name: 'Настройки' })).toBeInTheDocument();
  });

  test('телефон: 💬 — экран хоста /chat, как в задаче 19; бокового чата нет', async () => {
    stubViewport(false);
    resetFrame('/');
    renderApp();
    await openBreadFromAgenda();
    expect(chatButton()).not.toHaveAttribute('aria-pressed');
    fireEvent.click(chatButton());
    await heading('Чат');
    expect(shownPath()).toBe('/chat');
    expect(screen.queryByRole('complementary', { name: 'Чат' })).toBeNull();
  });
});

// ─── гейт 25, m-4: узкий десктоп с открытым боковым чатом ──────────────────────────────────────

describe.each([
  ['узкий десктоп (≈ 800 px): чат занимает место сайдбара', false],
  ['широкий десктоп (≥ 1100 px): сайдбар на месте', true],
] as const)('(г) %s', (_name, wide) => {
  test('основная область и капсула кнопок хоста на месте', async () => {
    stubViewport(true, 'site', wide);
    resetFrame('/');
    renderApp();
    await byTestId('host-rail');
    await openBreadFromAgenda();
    expect(screen.getByTestId('app-sidebar')).toBeInTheDocument();
    fireEvent.click(chatButton());
    await screen.findByRole('complementary', { name: 'Чат' }, { timeout: 5000 });
    expect(screen.queryByTestId('app-sidebar') !== null).toBe(wide);
    expect(screen.getByTestId('host-rail')).toBeInTheDocument();
    // Капсула — в основной колонке, рядом с содержимым, а не на сайдбаре или в чате.
    const main = screen.getByTestId('screen-content');
    expect(main.parentElement).toContainElement(hostButtons());
    expect(
      within(main).getByRole('heading', { level: 1, name: 'Купить хлеб' }),
    ).toBeInTheDocument();
    fireEvent.click(chatButton());
    await waitFor(() => expect(screen.getByTestId('app-sidebar')).toBeInTheDocument());
  });
});

// ─── гейт 25, m-5: чанк рамки десктопа едет или отказал — элементы хоста на месте (§6.6) ──────

describe('(а) десктоп, чанк рамки ещё не приехал или отказал', () => {
  const gate = { wait: Promise.resolve() as Promise<void>, down: false };

  beforeEach(() => {
    vi.doMock('./DesktopFrame', async (importOriginal) => {
      await gate.wait;
      if (gate.down) throw new Error('Failed to fetch dynamically imported module');
      return importOriginal();
    });
    resetDesktopFrameLoadForTests();
  });

  afterEach(() => {
    vi.doUnmock('./DesktopFrame');
    gate.wait = Promise.resolve();
    gate.down = false;
    resetDesktopFrameLoadForTests();
  });

  const expectHostSet = () => {
    const roles = hostRoles();
    expect(roles).toHaveLength(new Set(roles).size);
    expect([...roles].sort()).toEqual([...HOST_ELEMENTS].sort());
  };

  test('пока едет — рамка телефона со всеми элементами хоста; приехал — рамка десктопа', async () => {
    let release!: () => void;
    gate.wait = new Promise<void>((r) => {
      release = r;
    });
    stubViewport(true);
    resetFrame('/');
    renderApp();
    await openBreadFromAgenda();
    expect(screen.queryByTestId('host-rail')).toBeNull();
    expectHostSet();
    expect(
      within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Домой' }),
    ).toBeInTheDocument();
    release();
    await byTestId('host-rail');
    await heading('Купить хлеб');
    expectHostSet();
  });

  test('отказал — рамка телефона остаётся рабочей: элементы хоста, 💬 — экран чата', async () => {
    gate.down = true;
    stubViewport(true);
    resetFrame('/');
    renderApp();
    await openBreadFromAgenda();
    await act(async () => {});
    expect(screen.queryByTestId('host-rail')).toBeNull();
    expectHostSet();
    expect(chatButton()).not.toHaveAttribute('aria-pressed');
    fireEvent.click(chatButton());
    await heading('Чат');
    expect(shownPath()).toBe('/chat');
  });
});

// ─── гейт 25, I-1: упавшая часть рамки десктопа — кадр на её месте, остальное живёт ─────────────

describe('(г) десктоп: ошибка рисования в части рамки вне <main>', () => {
  const expectHostSet = () => {
    const roles = hostRoles();
    expect(roles).toHaveLength(new Set(roles).size);
    expect([...roles].sort()).toEqual([...HOST_ELEMENTS].sort());
  };

  test('карточка сообщения бокового чата бросает — кадр в колонке чата; основная область и элементы хоста на месте', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubViewport(true);
    resetFrame('/');
    renderApp(
      frameWorld({
        // Карточка неожиданной формы (`null` вместо объекта) — рисование карточек бросает.
        chat: [{ ...chatMessage('m1', 'сломано'), metadata: { cards: [null] } }],
      }),
    );
    await byTestId('host-rail');
    await openBreadFromAgenda();
    fireEvent.click(chatButton());
    const side = await screen.findByRole('complementary', { name: 'Чат' }, { timeout: 5000 });
    expect(await within(side).findByRole('alert')).toHaveTextContent('Не удалось показать чат');
    expect(screen.getByRole('heading', { level: 1, name: 'Купить хлеб' })).toBeInTheDocument();
    expect(screen.getByTestId('app-sidebar')).toBeInTheDocument();
    expectHostSet();
    // Закрыть и открыть — новая граница, новая попытка (кадр снова: данные те же).
    fireEvent.click(within(side).getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Чат' })).toBeNull());
    expect(chatButton()).toHaveAttribute('aria-pressed', 'false');
  });

  test('рейка бросает — на её месте ⌂ и «Настройки»; набор элементов хоста полный', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubViewport(true);
    resetFrame(`/r/${BREAD}`);
    const base = frameWorld();
    renderApp(
      frameWorld({
        all: [
          ...base.all,
          // Приложение без эмодзи и без имени — рейка берёт первую букву имени и бросает.
          wireEntity({
            id: OFF_APP,
            title: null as unknown as string,
            aspects: [APP_ASPECT],
            props: { [APP_NAV]: [] },
          }),
        ],
      }),
    );
    await heading('Купить хлеб');
    await byTestId('host-rail');
    await waitFor(() => expect(screen.getByTestId('host-rail')).toHaveAttribute('data-failed'));
    expectHostSet();
    fireEvent.click(within(screen.getByTestId('host-rail')).getByRole('button', { name: 'Домой' }));
    await heading('Домой');
    expect(shownPath()).toBe('/');
  });
});

// ─── гейт 25, m-6: чанк рамки десктопа уже есть — без кадра рамки телефона ─────────────────────

test('(а) десктоп: модуль рамки уже загружен — первый кадр сразу в рамке десктопа', async () => {
  resetDesktopFrameLoadForTests();
  await preloadDesktopFrame();
  stubViewport(true);
  resetFrame(`/r/${BREAD}`);
  renderApp();
  // Синхронно, без ожидания: фолбэка (рамки телефона с ⌂ в строке присутствия) не было.
  expect(screen.getByTestId('host-rail')).toBeInTheDocument();
  expect(screen.getByTestId('desktop-frame')).toBeInTheDocument();
  await heading('Купить хлеб');
  expect(
    within(screen.getByTestId('host-presence')).queryByRole('button', { name: 'Домой' }),
  ).toBeNull();
});
