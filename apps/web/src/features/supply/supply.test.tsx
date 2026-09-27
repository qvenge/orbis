/**
 * Поставка на записи и в меню «⋯» (срез 1б §9.1 п. 2, 4, 5; С1б-6 web): плашка обновления на записи
 * поставки, признак «Как в поставке» / «Изменено вами», «Вернуть как было» у страницы и — через диалог
 * исчезающих разделов — у оболочки хоста (раздел «Приложение «Orbis»» рамки, Р-20).
 *
 * Рисуется `<App/>` целиком на мире рамки (`frame-fixtures`); сеть поставки — мок по путям.
 */
import { APP_HOME, APP_NAV, PAGE_ASPECT, SUPPLY_ASPECT, SUPPLY_TEXT } from '@orbis/shared';
import { printAppProps, printPageRecord } from '@orbis/shared/supply/print';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../App';
import {
  frameHandler,
  frameWorld,
  HOME,
  PAGES,
  RECORDS_WORLD,
  ROUTINES,
  resetFrame,
  SHELL_ROW,
  stubLaunchMode,
  unstubLaunchMode,
  YEAR,
} from '../../app/frame/frame-fixtures';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import {
  installCrashTrap,
  renderWithProviders,
  type WireEntityFixture,
  wireEntity,
} from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { useToastStore } from '../../ui/toast-store';
import type { SupplyUpdate } from './useSupply';

installCrashTrap();

beforeEach(() => {
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  vi.stubGlobal('requestIdleCallback', () => 1);
  stubLaunchMode('site');
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  unstubLaunchMode();
  resetFrame('/');
});

const id = (n: number) => `00000000-0000-4000-8000-0000000023${String(n).padStart(2, '0')}`;
const MY_PAGE = id(1);
const KITCHEN = id(2);
const ACT = id(90);

const ROUTINES_ROW = PAGES.find((p) => p.id === ROUTINES) as WireEntityFixture;
const printOf = (r: WireEntityFixture, body = r.body) =>
  printPageRecord({ title: r.title, emoji: r.emoji, body });

/** «Рутины» с печатью эталона в записи: `edited` — эталон другой, чем тело записи. */
function routinesWith(edited: boolean, over: Partial<WireEntityFixture> = {}): WireEntityFixture {
  return {
    ...ROUTINES_ROW,
    props: {
      ...ROUTINES_ROW.props,
      [SUPPLY_TEXT]: edited ? printOf(ROUTINES_ROW, 'Рутины поставки.') : printOf(ROUTINES_ROW),
    },
    ...over,
  };
}

const ROUTINES_UPDATE: SupplyUpdate = {
  key: 'routines',
  kind: 'update',
  recordId: ROUTINES,
  edited: false,
  declined: false,
  etalonText: printOf(ROUTINES_ROW, 'Рутины, новая версия.'),
  recordText: printOf(ROUTINES_ROW),
};

function renderApp(opts: { rows?: WireEntityFixture[]; updates?: SupplyUpdate[] }) {
  const all = opts.rows ?? [SHELL_ROW, ...PAGES, ...RECORDS_WORLD];
  const world = frameWorld({
    all,
    supply: all.filter((e) => e.aspects.includes(SUPPLY_ASPECT) && !e.archived),
  });
  const base = frameHandler(world);
  const r = renderWithProviders(<App />, (path, input, type) => {
    switch (path) {
      case 'supply.updates':
        return opts.updates ?? [];
      case 'supply.accept':
      case 'supply.decline':
      case 'supply.revert':
        return { actionId: ACT };
      case 'ai.undo':
        return { ok: true, actionId: ACT };
      default:
        return base(path, input, type);
    }
  });
  const callsOf = (path: string) => r.calls.filter((c) => c.path === path).map((c) => c.input);
  return { ...r, callsOf };
}

const heading = (name: string) =>
  screen.findByRole('heading', { level: 1, name }, { timeout: 5000 });

async function openMenu(): Promise<void> {
  fireEvent.click(screen.getByTestId('screen-menu'));
  await screen.findByRole('menu');
}

// ─── (д) плашка на записи ─────────────────────────────────────────────────────────────────────────

test('(д) «Рутины» с обновлением: плашка с [Сравнить] [Принять — …] [Оставить своё]; «Принять» → supply.accept', async () => {
  resetFrame(`/r/${ROUTINES}`);
  const { callsOf } = renderApp({ updates: [ROUTINES_UPDATE] });
  await heading('Рутины');
  const plaque = await screen.findByTestId('supply-plaque', {}, { timeout: 5000 });
  expect(
    within(plaque)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Сравнить', 'Принять — прежняя версия сохранится', 'Оставить своё']);
  fireEvent.click(
    within(plaque).getByRole('button', { name: 'Принять — прежняя версия сохранится' }),
  );
  await waitFor(() => expect(callsOf('supply.accept')).toEqual([{ key: 'routines' }]));
  const toast = useToastStore.getState().toasts.find((t) => t.title.includes('Обновление принято'));
  expect(toast?.action?.label).toBe('Отменить');
});

test('(д) плашка «Сравнить» — сравнение по печатям из supply.updates', async () => {
  resetFrame(`/r/${ROUTINES}`);
  renderApp({ updates: [ROUTINES_UPDATE] });
  const plaque = await screen.findByTestId('supply-plaque', {}, { timeout: 5000 });
  fireEvent.click(within(plaque).getByRole('button', { name: 'Сравнить' }));
  const compare = await screen.findByTestId('supply-compare', {}, { timeout: 5000 });
  expect(compare).toHaveTextContent('новая версия');
});

test('(д) запись без обновления — плашки нет', async () => {
  resetFrame(`/r/${ROUTINES}`);
  const { callsOf } = renderApp({ updates: [] });
  await heading('Рутины');
  await waitFor(() => expect(callsOf('supply.updates')).toHaveLength(1));
  expect(screen.queryByTestId('supply-plaque')).toBeNull();
});

test('R-17: снятый аспект «поставка» — ни плашки, ни запроса «Обновлений», ни признака и «Вернуть как было»', async () => {
  resetFrame(`/r/${ROUTINES}`);
  const withdrawn = routinesWith(true, { aspects: [PAGE_ASPECT] });
  const { callsOf } = renderApp({
    rows: [SHELL_ROW, ...PAGES.filter((p) => p.id !== ROUTINES), withdrawn, ...RECORDS_WORLD],
    // Сервер такую запись не предлагает (R-17); даже будь пункт — экран его к ней не пристроит.
    updates: [ROUTINES_UPDATE],
  });
  await heading('Рутины');
  await openMenu();
  const own = screen.getByRole('group', { name: 'Этот экран' });
  expect(within(own).queryByTestId('menu-note')).toBeNull();
  expect(within(own).queryByRole('menuitem', { name: 'Вернуть как было' })).toBeNull();
  expect(screen.queryByTestId('supply-plaque')).toBeNull();
  expect(callsOf('supply.updates')).toEqual([]);
});

// ─── (е) «⋯» страницы поставки ────────────────────────────────────────────────────────────────────

test('(е) «Рутины» как в поставке: признак «Как в поставке», «Вернуть как было» нет', async () => {
  resetFrame(`/r/${ROUTINES}`);
  renderApp({ rows: [SHELL_ROW, ...PAGES.filter((p) => p.id !== ROUTINES), routinesWith(false)] });
  await heading('Рутины');
  await openMenu();
  const own = screen.getByRole('group', { name: 'Этот экран' });
  expect(within(own).getByTestId('menu-note')).toHaveTextContent('Как в поставке');
  expect(within(own).queryByRole('menuitem', { name: 'Вернуть как было' })).toBeNull();
});

test('(е) «Рутины» изменены: признак «Изменено вами»; «Вернуть как было» → supply.revert', async () => {
  resetFrame(`/r/${ROUTINES}`);
  const { callsOf } = renderApp({
    rows: [SHELL_ROW, ...PAGES.filter((p) => p.id !== ROUTINES), routinesWith(true)],
  });
  await heading('Рутины');
  await openMenu();
  const own = screen.getByRole('group', { name: 'Этот экран' });
  expect(within(own).getByTestId('menu-note')).toHaveTextContent('Изменено вами');
  fireEvent.click(within(own).getByRole('menuitem', { name: 'Вернуть как было' }));
  await waitFor(() => expect(callsOf('supply.revert')).toEqual([{ key: 'routines' }]));
});

// ─── (е′) оболочка хоста: раздел «Приложение «Orbis»» рамки ──────────────────────────────────────

const MY_PAGE_ROW = wireEntity({
  id: MY_PAGE,
  title: 'Моя страница',
  aspects: [PAGE_ASPECT],
  body: 'Моё.',
});
const KITCHEN_ROW = wireEntity({
  id: KITCHEN,
  title: 'Кухня',
  aspects: [PAGE_ASPECT],
  body: 'Кухня.',
});

/** Оболочка с печатью эталона = исходное место; `props` — нынешнее (правки владельца). */
function shellWith(props: Record<string, unknown>): WireEntityFixture {
  return {
    ...SHELL_ROW,
    props: { ...SHELL_ROW.props, [SUPPLY_TEXT]: printAppProps(SHELL_ROW), ...props },
  };
}

async function openShellSection(): Promise<HTMLElement> {
  await openMenu();
  return screen.findByRole('group', { name: 'Приложение «Orbis»' });
}

test('(е′) «/» → «⋯» → «Приложение «Orbis»»: «Изменено вами» → «Вернуть как было» → диалог исчезающих разделов → supply.revert', async () => {
  resetFrame('/');
  const nav = [...(SHELL_ROW.props[APP_NAV] as string[]), MY_PAGE];
  const { callsOf } = renderApp({
    rows: [shellWith({ [APP_NAV]: nav }), ...PAGES, MY_PAGE_ROW, ...RECORDS_WORLD],
  });
  await heading('Домой');
  const section = await openShellSection();
  expect(within(section).getByTestId('menu-note')).toHaveTextContent('Изменено вами');
  expect(
    within(section).getByRole('menuitem', { name: 'Настроить навигацию' }),
  ).toBeInTheDocument();
  fireEvent.click(within(section).getByRole('menuitem', { name: 'Вернуть как было' }));
  const dialog = await screen.findByTestId('revert-shell-dialog', {}, { timeout: 5000 });
  expect(within(dialog).getByTestId('revert-vanishing')).toHaveTextContent(
    'Исчезнут разделы, которые вы добавили: «Моя страница».',
  );
  // До подтверждения ничего не ушло: возврат — только после взгляда на то, что исчезнет.
  expect(callsOf('supply.revert')).toEqual([]);
  const confirm = within(dialog).getByRole('button', { name: 'Вернуть как было' });
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
  await waitFor(() => expect(callsOf('supply.revert')).toEqual([{ key: 'host-shell' }]));
});

test('(е′) оболочка как в поставке: «Как в поставке», «Вернуть как было» нет', async () => {
  resetFrame('/');
  renderApp({ rows: [shellWith({}), ...PAGES, ...RECORDS_WORLD] });
  await heading('Домой');
  const section = await openShellSection();
  expect(within(section).getByTestId('menu-note')).toHaveTextContent('Как в поставке');
  expect(within(section).queryByRole('menuitem', { name: 'Вернуть как было' })).toBeNull();
});

test('перенос 11 (R-16): «Домой» в архиве и своя домашняя — диалог предупреждает, что домашней не будет; архивный раздел не вернётся', async () => {
  resetFrame('/');
  const archived = (r: WireEntityFixture) =>
    r.id === HOME || r.id === YEAR ? { ...r, archived: true } : r;
  renderApp({
    rows: [
      shellWith({ [APP_HOME]: KITCHEN }),
      ...PAGES.map(archived),
      KITCHEN_ROW,
      ...RECORDS_WORLD,
    ],
  });
  await heading('Кухня');
  const section = await openShellSection();
  fireEvent.click(within(section).getByRole('menuitem', { name: 'Вернуть как было' }));
  const dialog = await screen.findByTestId('revert-shell-dialog', {}, { timeout: 5000 });
  expect(await within(dialog).findByTestId('revert-home')).toHaveTextContent(
    'Домашней после возврата не будет: страница поставки «Домой» в архиве, а ваша домашняя «Кухня» будет снята.',
  );
  expect(within(dialog).getByTestId('revert-lost')).toHaveTextContent(
    'Разделы поставки в архиве не вернутся: «Год».',
  );
  expect(dialog).toHaveTextContent('«Отменить» в уведомлении вернёт всё как сейчас.');
});
