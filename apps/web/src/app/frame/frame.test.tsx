/**
 * Рамка хоста (спека 1б §6.1–§6.6, С1б-7, С1б-8, С1б-16): присутствие хоста на каждом экране, кнопки
 * хоста внизу справа, нижнего ряда вкладок нет; лист разделов формы «список из заголовка» с бейджами
 * одной пачкой и «где остановились»; архивный раздел и гарантии §6.6; одно меню «⋯» с разделами
 * «Этот экран» и «Хост»; «＋» — быстрый ввод.
 *
 * Рисуется `<App/>` целиком: рамка — это то, что стоит вокруг любого экрана, и проверять её на
 * отдельных кусках значило бы проверять куски.
 */
import { SUPPLY_ASPECT } from '@orbis/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../../App';
import { resetDetailMenuModuleForTests } from '../../features/entity-detail/DetailMenuSlot';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import {
  installCrashTrap,
  renderWithProviders,
  type WireEntityFixture,
  wireEntity,
} from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { resetDetailScreenModuleForTests } from '../router';
import {
  ALL_TASKS,
  BREAD,
  DAILY,
  frameHandler,
  frameWorld,
  HOME,
  NAV_IDS,
  PAGES,
  RECORDS,
  RECORDS_WORLD,
  ROUTINES,
  resetFrame,
  SHELL_ROW,
  stubLaunchMode,
  UPCOMING,
  unstubLaunchMode,
  YEAR,
} from './frame-fixtures';

/**
 * «Сеть» чанков: экран записи (`DetailScreen`) и пункты меню записи (`DetailMenu`). `gate` —
 * медленный чанк (загрузка ждёт его), `down` — отказ загрузки.
 */
const chunks = vi.hoisted(() => ({
  screenGate: Promise.resolve() as Promise<void>,
  screenDown: false,
  menuGate: Promise.resolve() as Promise<void>,
}));

installCrashTrap();

beforeEach(() => {
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  vi.stubGlobal('requestIdleCallback', () => 1);
  stubLaunchMode('site');
  resetDetailScreenModuleForTests();
  resetDetailMenuModuleForTests();
  // Мок — заново на каждый тест: реестр модулей vitest помнит удавшуюся загрузку.
  vi.doMock('../../features/entity-detail/DetailScreen', async (importOriginal) => {
    await chunks.screenGate;
    if (chunks.screenDown) throw new Error('Failed to fetch dynamically imported module');
    return importOriginal();
  });
  vi.doMock('../../features/entity-detail/DetailMenu', async (importOriginal) => {
    await chunks.menuGate;
    return importOriginal();
  });
});

afterEach(() => {
  vi.doUnmock('../../features/entity-detail/DetailScreen');
  vi.doUnmock('../../features/entity-detail/DetailMenu');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  unstubLaunchMode();
  chunks.screenGate = Promise.resolve();
  chunks.screenDown = false;
  chunks.menuGate = Promise.resolve();
  resetFrame('/');
});

function renderApp(world = frameWorld()) {
  return renderWithProviders(<App />, frameHandler(world));
}

const heading = (name: string) => screen.findByRole('heading', { level: 1, name });

function hanging(): { release: () => void; gate: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, gate };
}

/** Рамка на месте: присутствие хоста («‹» по условию, ⌂, ⋯), кнопки хоста; нижних вкладок нет. */
function expectFrame(opts: { back: boolean }) {
  const presence = screen.getByTestId('host-presence');
  expect(within(presence).getByRole('button', { name: 'Домой' })).toBeInTheDocument();
  expect(within(presence).getByRole('button', { name: 'Меню' })).toBeInTheDocument();
  expect(within(presence).queryByRole('button', { name: 'Назад' }) !== null).toBe(opts.back);
  const buttons = screen.getByTestId('host-buttons');
  expect(within(buttons).getByRole('button', { name: 'Чат' })).toBeInTheDocument();
  expect(within(buttons).getByRole('button', { name: 'Новая запись' })).toBeInTheDocument();
  expect(screen.queryByTestId('tab-bar')).toBeNull();
  expect(screen.queryByRole('tablist', { name: 'Разделы' })).toBeNull();
  // Отдельной иконки настроек в шапке нет: «Настройки» — пункт раздела «Хост» меню «⋯» (§6.4).
  expect(screen.queryByRole('button', { name: 'Настройки' })).toBeNull();
}

// ─── (а) рамка на каждом экране ───────────────────────────────────────────────────────────────

describe('(а) присутствие хоста и кнопки хоста на каждом экране (С1б-7)', () => {
  test('запись', async () => {
    resetFrame(`/r/${BREAD}`);
    renderApp();
    await heading('Купить хлеб');
    expectFrame({ back: true });
  });

  test('страница', async () => {
    resetFrame(`/r/${UPCOMING}`);
    renderApp();
    await heading('Upcoming');
    expectFrame({ back: true });
  });

  test('домашняя хоста — «‹» нет: идти некуда', async () => {
    resetFrame('/');
    renderApp();
    await heading('Домой');
    expectFrame({ back: false });
  });

  test('чат', async () => {
    resetFrame('/chat');
    renderApp();
    await heading('Чат');
    expectFrame({ back: true });
  });

  test('настройки', async () => {
    resetFrame('/settings');
    renderApp();
    await heading('Настройки');
    expectFrame({ back: true });
  });

  test('«Не найдено»', async () => {
    resetFrame('/r/00000000-0000-4000-8000-00000000dead');
    renderApp();
    await heading('Не найдено');
    expectFrame({ back: true });
  });

  test('фолбэк загрузки экрана', async () => {
    const slow = hanging();
    chunks.screenGate = slow.gate;
    resetFrame(`/r/${BREAD}`);
    renderApp();
    await waitFor(() =>
      expect(screen.getAllByRole('status', { name: 'Загрузка' }).length).toBeGreaterThan(0),
    );
    expectFrame({ back: true });
    slow.release();
    await heading('Купить хлеб');
  });

  test('кадр ошибки чанка', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    chunks.screenDown = true;
    resetFrame(`/r/${BREAD}`);
    renderApp();
    expect(await screen.findByText('Не удалось открыть экран')).toBeInTheDocument();
    expectFrame({ back: true });
  });
});

// ─── (б) лист разделов ─────────────────────────────────────────────────────────────────────────

describe('(б) лист разделов формы «список из заголовка» (С1б-8, С1б-16)', () => {
  test('«🪐 · Записи ▾» раскрывает разделы хоста в порядке оболочки', async () => {
    resetFrame('/browser');
    renderApp();
    await heading('Записи');
    const sw = screen.getByTestId('nav-switch');
    expect(sw).toHaveTextContent('🪐');
    expect(sw).toHaveTextContent('Записи');
    fireEvent.click(sw);
    const sheet = await screen.findByTestId('nav-sheet');
    const rows = within(sheet)
      .getAllByTestId(/^nav-section-/)
      .map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual(NAV_IDS.map((id) => `nav-section-${id}`));
    expect(within(sheet).getByTestId(`nav-section-${RECORDS}`)).toHaveTextContent('Записи');
    expect(within(sheet).getByTestId(`nav-section-${ROUTINES}`)).toHaveTextContent('Рутины');
    expect(within(sheet).queryByTestId('shell-etalon-plaque')).toBeNull();
  });

  test('бейджи — ОДИН entity.blocks с элементами badgeOf, без entity.count и entity.get на раздел', async () => {
    resetFrame('/');
    const { calls } = renderApp();
    await heading('Домой');
    const before = calls.length;
    fireEvent.click(screen.getByTestId('nav-switch'));
    await waitFor(() => expect(screen.getByTestId(`nav-badge-${UPCOMING}`)).toHaveTextContent('3'));
    expect(screen.getByTestId(`nav-badge-${ALL_TASKS}`)).toHaveTextContent('99+');
    // Нет числа (`kind:'none'`) — нет бейджа.
    expect(screen.queryByTestId(`nav-badge-${YEAR}`)).toBeNull();
    const after = calls.slice(before);
    const blocks = after.filter((c) => c.path === 'entity.blocks');
    expect(blocks).toHaveLength(1);
    const items = (blocks[0]?.input as { blocks: { badgeOf?: string }[] }).blocks;
    expect(items.map((b) => b.badgeOf).sort()).toEqual([...NAV_IDS].sort());
    expect(after.filter((c) => c.path === 'entity.count')).toEqual([]);
    expect(after.filter((c) => c.path === 'entity.get')).toEqual([]);
  });

  test('раздел, открытый вглубь, показывает «где остановились» — «Upcoming · Купить хлеб»', async () => {
    resetFrame('/');
    renderApp();
    await heading('Домой');
    fireEvent.click(screen.getByTestId('nav-switch'));
    fireEvent.click(await screen.findByTestId(`nav-section-${UPCOMING}`));
    await heading('Upcoming');
    act(() => useNav.getState().openRecord(BREAD));
    await heading('Купить хлеб');
    fireEvent.click(screen.getByTestId('nav-switch'));
    fireEvent.click(await screen.findByTestId(`nav-section-${RECORDS}`));
    await heading('Записи');
    fireEvent.click(screen.getByTestId('nav-switch'));
    const row = await screen.findByTestId(`nav-section-${UPCOMING}`);
    await waitFor(() => expect(row).toHaveTextContent('Upcoming · Купить хлеб'));
    // У раздела на корне — только заголовок.
    expect(screen.getByTestId(`nav-section-${RECORDS}`)).not.toHaveTextContent('·');
  });
});

// ─── (в) архивный раздел ───────────────────────────────────────────────────────────────────────

test('(в) архивный раздел — строка-плашка «в архиве», не кнопка', async () => {
  const archived = PAGES.map((p) => (p.id === DAILY ? { ...p, archived: true } : p));
  const world = frameWorld({
    supply: [SHELL_ROW, ...archived.filter((p) => !p.archived)],
    all: [SHELL_ROW, ...archived, ...RECORDS_WORLD],
  });
  resetFrame('/');
  renderApp(world);
  await heading('Домой');
  fireEvent.click(screen.getByTestId('nav-switch'));
  const row = await screen.findByTestId(`nav-section-${DAILY}`);
  await waitFor(() => expect(row).toHaveTextContent('в архиве'));
  expect(row.tagName).not.toBe('BUTTON');
});

// ─── (г) гарантии §6.6 ─────────────────────────────────────────────────────────────────────────

describe('(г) оболочка хоста по эталону и «Домой» в архиве (§6.6)', () => {
  const broken: [string, WireEntityFixture | null][] = [
    ['без записи или в архиве', null],
    ['без аспекта «приложение»', { ...SHELL_ROW, aspects: [SUPPLY_ASPECT] }],
    [
      'навигация — не список id',
      { ...SHELL_ROW, props: { ...SHELL_ROW.props, 'orbis/app_nav': 'records' } },
    ],
  ];

  test.each(broken)('оболочка %s — разделы по ключам поставки и плашка', async (_name, shell) => {
    const world = frameWorld({
      supply: shell === null ? [...PAGES] : [shell, ...PAGES],
      all: [...(shell === null ? [] : [shell]), ...PAGES, ...RECORDS_WORLD],
    });
    resetFrame('/');
    renderApp(world);
    await heading('Домой');
    expect(screen.getByTestId('nav-switch')).toHaveTextContent('🪐');
    fireEvent.click(screen.getByTestId('nav-switch'));
    const sheet = await screen.findByTestId('nav-sheet');
    expect(within(sheet).getByTestId('shell-etalon-plaque')).toHaveTextContent(
      'Оболочка хоста повреждена — показан эталон поставки',
    );
    await waitFor(() =>
      expect(
        within(sheet)
          .getAllByTestId(/^nav-section-/)
          .map((r) => r.getAttribute('data-testid')),
      ).toEqual(NAV_IDS.map((id) => `nav-section-${id}`)),
    );
  });

  test('«Домой» в архиве — ⌂ показывает «Домашняя в архиве» с «Восстановить»', async () => {
    const archivedHome = PAGES.map((p) => (p.id === HOME ? { ...p, archived: true } : p));
    const world = frameWorld({
      supply: [SHELL_ROW, ...archivedHome.filter((p) => !p.archived)],
      all: [SHELL_ROW, ...archivedHome, ...RECORDS_WORLD],
    });
    resetFrame(`/r/${BREAD}`);
    const { calls } = renderApp(world);
    await heading('Купить хлеб');
    fireEvent.click(
      within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Домой' }),
    );
    const plaque = await screen.findByTestId('home-archived');
    expect(plaque).toHaveTextContent('Домашняя в архиве');
    fireEvent.click(within(plaque).getByRole('button', { name: 'Восстановить' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'entity.update').map((c) => c.input)).toEqual([
        { id: HOME, archived: false },
      ]),
    );
  });
});

// ─── (д) одно меню «⋯» ─────────────────────────────────────────────────────────────────────────

describe('(д) одно меню «⋯»: «Этот экран» и «Хост» (§6.4)', () => {
  test('на записи — пункты записи (лениво) и раздел «Хост»; открывается с первого нажатия при медленном чанке', async () => {
    const slow = hanging();
    chunks.menuGate = slow.gate;
    resetFrame(`/r/${BREAD}`);
    renderApp();
    await heading('Купить хлеб');
    fireEvent.click(
      within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Меню' }),
    );
    expect(screen.getByTestId('screen-menu')).toHaveAttribute('aria-expanded', 'true');
    slow.release();
    const own = await screen.findByRole('group', { name: 'Этот экран' });
    expect(within(own).getByRole('menuitem', { name: 'Скопировать ссылку' })).toBeInTheDocument();
    expect(within(own).queryByRole('menuitem', { name: 'Закрепить' })).toBeNull();
    const host = screen.getByRole('group', { name: 'Хост' });
    expect(
      within(host)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Все приложения', 'Приложения и расширения', 'Настройки']);
  });

  test('на экране хоста — только «Хост»; «Настройки» открывает настройки', async () => {
    resetFrame('/chat');
    renderApp();
    await heading('Чат');
    fireEvent.click(screen.getByTestId('screen-menu'));
    const host = await screen.findByRole('group', { name: 'Хост' });
    expect(screen.queryByRole('group', { name: 'Этот экран' })).toBeNull();
    fireEvent.click(within(host).getByRole('menuitem', { name: 'Настройки' }));
    await heading('Настройки');
  });
});

// ─── (е) «＋» ───────────────────────────────────────────────────────────────────────────────────

test('(е) «＋» открывает быстрый ввод без контекста (root)', async () => {
  resetFrame(`/r/${BREAD}`);
  const { calls } = renderWithProviders(<App />, (path, input, type) => {
    if (path === 'entity.create') {
      return wireEntity({ id: (input as { input: { id: string } }).input.id, title: 'Молоко' });
    }
    return frameHandler()(path, input, type);
  });
  await heading('Купить хлеб');
  fireEvent.click(
    within(screen.getByTestId('host-buttons')).getByRole('button', { name: 'Новая запись' }),
  );
  const capture = await screen.findByTestId('host-capture');
  fireEvent.change(within(capture).getByLabelText('Быстрая запись'), {
    target: { value: 'Молоко' },
  });
  fireEvent.submit(within(capture).getByTestId('quick-capture-form'));
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.create')).toHaveLength(1));
  const create = calls.find((c) => c.path === 'entity.create')?.input as {
    input: Record<string, unknown>;
  };
  // Без контекста: ни аспекта задачи, ни связи с родителем.
  expect(create.input.aspects).toBeUndefined();
  expect(calls.filter((c) => c.path === 'relation.create')).toEqual([]);
});
