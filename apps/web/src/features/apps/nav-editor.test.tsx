/**
 * Правка навигации в web (срез 1б §4.3, §4.4, §9.3, §9.5; С1б-8, С1б-11 web, Фокус ревью п. 2):
 * «⋯ → Настроить навигацию» (редактор записи-приложения рамки), «Добавить в навигацию» / «Убрать из
 * навигации», «Новое приложение…», «Дом» шаблона из рамки и поле «Дом» в карточке страницы.
 *
 * Рисуется `<App/>` целиком, сеть — «сервер в памяти»: пачка правит записи, перечитывание видит
 * записанное; ссылку на архивную цель сервер отвергает («цель архивна», как проверка ссылок
 * исполнителя), а «Дом» бездомной странице, поставленной в своё приложение, ставит сам (follow-up
 * задачи 10) — так проверяется, что клиент его НЕ шлёт.
 */
import {
  APP_ASPECT,
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  HOME_PROPERTY,
  PAGE_ASPECT,
  SUPPLY_ASPECT,
  TEMPLATE_FOR_PROPERTY,
} from '@orbis/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../App';
import {
  ALL_TASKS,
  BREAD,
  DAILY,
  frameHandler,
  frameWorld,
  NAV_IDS,
  PAGES,
  RECORDS,
  ROUTINES,
  resetFrame,
  SHELL,
  SHELL_ROW,
  shownPath,
  stubLaunchMode,
  UPCOMING,
  unstubLaunchMode,
  YEAR,
} from '../../app/frame/frame-fixtures';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import {
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  trpcError,
  type WireEntityFixture,
  wireEntity,
} from '../../test/harness';
import { BUILTIN_REGISTRY, registryReply } from '../../test/registry';
import { useToastStore } from '../../ui/toast-store';
import { AspectSection } from '../entity-detail/AspectSection';

installCrashTrap();

beforeEach(() => {
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  vi.stubGlobal('requestIdleCallback', () => 1);
  stubLaunchMode('site');
  useToastStore.setState({ toasts: [] });
});

/** Заголовки тостов сейчас (тост рисует оболочка, которой в `<App/>` теста нет — читаем стор). */
const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);

afterEach(() => {
  vi.unstubAllGlobals();
  unstubLaunchMode();
  resetFrame('/');
});

const id = (n: number) => `00000000-0000-4000-8000-0000000021${String(n).padStart(2, '0')}`;

/** Бездомная страница: пустой «Дом», ни в одной навигации, ничья не домашняя. */
const LOOSE = id(50);
/** Страница с пустым «Домом» — домашняя «Моего дома» (стояла в хосте до того, как её поставили). */
const KITCHEN = id(51);
const MY = id(60);
const REPAIR = id(61);

const pageRow = (rid: string, title: string, props: Record<string, unknown> = {}) =>
  wireEntity({ id: rid, title, aspects: [PAGE_ASPECT], body: `${title}.`, props });

const MY_ROW = wireEntity({
  id: MY,
  title: 'Мой дом',
  emoji: '🏡',
  aspects: [APP_ASPECT],
  props: { [APP_HOME]: KITCHEN, [APP_NAV]: [REPAIR] },
});

function baseRows(): WireEntityFixture[] {
  return [
    { ...SHELL_ROW, props: { ...SHELL_ROW.props } },
    ...PAGES,
    wireEntity({ id: BREAD, title: 'Купить хлеб' }),
    pageRow(LOOSE, 'Общая страница'),
    pageRow(KITCHEN, 'Кухня'),
    pageRow(REPAIR, 'Ремонт', { [HOME_PROPERTY]: MY }),
  ];
}

type BatchOp = { tool: string; input: Record<string, unknown> & { id: string } };

/** «Сервер в памяти»: записи графа по id. */
function store(rows: WireEntityFixture[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const refs = (v: unknown): string[] =>
    typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];

  /** Проверка ссылок исполнителя (`assertRefValue`): архивная цель — отказ всей пачки. */
  function assertRefs(props: Record<string, unknown> | undefined) {
    for (const key of [APP_NAV, APP_HOME, HOME_PROPERTY]) {
      for (const rid of refs(props?.[key])) {
        if (byId.get(rid)?.archived === true) throw trpcError('BAD_REQUEST', 'цель архивна');
      }
    }
  }

  /** Follow-up задачи 10: бездомная страница, поставленная в своё приложение, получает «Дом». */
  function homeFollowUp(appId: string) {
    const app = byId.get(appId);
    if (app === undefined || app.id === SHELL) return;
    const placed = (r: WireEntityFixture, pid: string) =>
      r.aspects.includes(APP_ASPECT) &&
      r.id !== appId &&
      (r.props[APP_HOME] === pid || refs(r.props[APP_NAV]).includes(pid));
    for (const pid of [...refs(app.props[APP_HOME]), ...refs(app.props[APP_NAV])]) {
      const p = byId.get(pid);
      if (p === undefined || !p.aspects.includes(PAGE_ASPECT) || HOME_PROPERTY in p.props) continue;
      if ([...byId.values()].some((r) => placed(r, pid))) continue;
      byId.set(pid, { ...p, props: { ...p.props, [HOME_PROPERTY]: appId } });
    }
  }

  const handler: MockHandler = (path, input, type) => {
    if (path === 'entity.updateBatch') {
      const { operations } = input as { operations: BatchOp[] };
      for (const op of operations) assertRefs(op.input.props as Record<string, unknown>);
      for (const { tool, input: op } of operations) {
        if (tool === 'entity_create') {
          const { id: rid, title, emoji, aspects, props } = op as unknown as WireEntityFixture;
          byId.set(rid, wireEntity({ id: rid, title, emoji: emoji ?? null, aspects, props }));
          homeFollowUp(rid);
          continue;
        }
        const cur = byId.get(op.id);
        if (cur === undefined) continue;
        const props = { ...cur.props, ...(op.props as Record<string, unknown> | undefined) };
        for (const k of (op.unset as string[] | undefined) ?? []) delete props[k];
        byId.set(op.id, {
          ...cur,
          ...(typeof op.title === 'string' && { title: op.title }),
          ...(op.emoji !== undefined && { emoji: op.emoji as string | null }),
          props,
        });
        homeFollowUp(op.id);
      }
      return { actionId: 'act-21' };
    }
    if (path === 'entity.suggest') {
      const term = (input as { term: string }).term.toLowerCase();
      return [...byId.values()]
        .filter((e) => !e.archived && e.title.toLowerCase().includes(term))
        .map((e) => ({
          id: e.id,
          title: e.title,
          emoji: e.emoji,
          completable: null,
          archived: false,
        }));
    }
    const all = [...byId.values()];
    return frameHandler(
      frameWorld({
        all,
        supply: all.filter((e) => e.aspects.includes(SUPPLY_ASPECT) && !e.archived),
      }),
    )(path, input, type);
  };
  return { handler, byId };
}

function renderApp(rows: WireEntityFixture[] = baseRows(), opts: { rejectBatch?: boolean } = {}) {
  const s = store(rows);
  const r = renderWithProviders(<App />, (path, input, type) => {
    // Отказ пачки по существу (правило каталога) — как ответил бы исполнитель.
    if (opts.rejectBatch === true && path === 'entity.updateBatch')
      throw trpcError('BAD_REQUEST', 'правило app_nav_not_self');
    return s.handler(path, input, type);
  });
  const batches = () =>
    r.calls
      .filter((c) => c.path === 'entity.updateBatch')
      .map((c) => (c.input as { operations: BatchOp[] }).operations);
  return { ...r, batches, byId: s.byId };
}

const heading = (name: string) =>
  screen.findByRole('heading', { level: 1, name }, { timeout: 5000 });

async function openMenu(): Promise<void> {
  fireEvent.click(screen.getByTestId('screen-menu'));
  await screen.findByRole('menu');
}

const ownItems = () =>
  within(screen.getByRole('group', { name: 'Этот экран' }))
    .getAllByRole('menuitem')
    .map((i) => i.textContent ?? '');

/** Пункты «Этот экран» сейчас: открыть меню, прочитать, закрыть (повторяемо внутри `waitFor`). */
async function ownItemsOnce(): Promise<string[]> {
  await openMenu();
  const items = ownItems();
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  return items;
}

async function openNavEditor(appTitle: string): Promise<HTMLElement> {
  await openMenu();
  const group = await screen.findByRole('group', { name: `Приложение «${appTitle}»` });
  fireEvent.click(within(group).getByRole('menuitem', { name: 'Настроить навигацию' }));
  return screen.findByTestId('nav-editor');
}

const rowTitles = (editor: HTMLElement) =>
  within(editor)
    .getAllByTestId('ref-title')
    .map((t) => t.textContent);

const HOST_TITLES = ['Записи', 'Daily Planning', 'Upcoming', 'All Tasks', 'Год', 'Рутины'];

// ─── (б) «Настроить навигацию» ─────────────────────────────────────────────────────────────────

test('(б) хост на «/»: «Upcoming» выше «Daily Planning» → одна пачка с новым порядком', async () => {
  resetFrame('/');
  const { batches } = renderApp();
  await heading('Домой');
  const editor = await openNavEditor('Orbis');
  await waitFor(() => expect(rowTitles(editor)).toEqual(HOST_TITLES));
  fireEvent.click(within(editor).getByRole('button', { name: 'Выше: Upcoming' }));
  expect(rowTitles(editor)).toEqual([
    'Записи',
    'Upcoming',
    'Daily Planning',
    'All Tasks',
    'Год',
    'Рутины',
  ]);
  // Ничего не ушло до «Сохранить»: перестановка копится в черновике.
  expect(batches()).toHaveLength(0);
  fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(batches()).toHaveLength(1));
  expect(batches()).toEqual([
    [
      {
        tool: 'entity_update',
        input: {
          id: SHELL,
          props: { [APP_NAV]: [RECORDS, UPCOMING, DAILY, ALL_TASKS, YEAR, ROUTINES] },
        },
      },
    ],
  ]);
  await waitFor(() => expect(toastTitles()).toContain('Навигация сохранена'));
});

test('(б) добавить поиском, убрать, сменить домашнюю, форму, имя и иконку — одна пачка на «Сохранить»', async () => {
  resetFrame('/');
  const { batches } = renderApp();
  await heading('Домой');
  const editor = await openNavEditor('Orbis');
  await waitFor(() => expect(rowTitles(editor)).toEqual(HOST_TITLES));

  fireEvent.change(within(editor).getByRole('searchbox', { name: 'Добавить: Разделы' }), {
    target: { value: 'хлеб' },
  });
  fireEvent.click(await within(editor).findByRole('button', { name: 'Купить хлеб' }));
  fireEvent.click(within(editor).getByRole('button', { name: 'Убрать: Год' }));

  fireEvent.change(within(editor).getByRole('searchbox', { name: 'Сменить домашнюю' }), {
    target: { value: 'кухня' },
  });
  fireEvent.click(await within(editor).findByRole('button', { name: 'Кухня' }));
  await waitFor(() => expect(within(editor).getByTestId('nav-home')).toHaveTextContent('Кухня'));

  fireEvent.change(within(editor).getByRole('combobox', { name: 'Форма навигации' }), {
    target: { value: 'home-hub' },
  });
  fireEvent.change(within(editor).getByRole('textbox', { name: 'Имя' }), {
    target: { value: 'Мой Orbis' },
  });
  fireEvent.change(within(editor).getByRole('textbox', { name: 'Иконка' }), {
    target: { value: '🌍' },
  });
  expect(batches()).toHaveLength(0);
  fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(batches()).toHaveLength(1));
  expect(batches()).toEqual([
    [
      {
        tool: 'entity_update',
        input: {
          id: SHELL,
          title: 'Мой Orbis',
          emoji: '🌍',
          props: {
            [APP_NAV]: [RECORDS, DAILY, UPCOMING, ALL_TASKS, ROUTINES, BREAD],
            [APP_NAV_FORM]: 'home-hub',
            [APP_HOME]: KITCHEN,
          },
        },
      },
    ],
  ]);
});

test('(б) Фокус ревью п. 2: архивный раздел — плашка; «Сохранить» вычищает его, отказа «цель архивна» нет', async () => {
  resetFrame('/');
  const rows = baseRows().map((r) => (r.id === YEAR ? { ...r, archived: true } : r));
  const { batches } = renderApp(rows);
  await heading('Домой');
  const editor = await openNavEditor('Orbis');
  await waitFor(() => expect(rowTitles(editor)).toEqual(HOST_TITLES));
  const year = within(editor)
    .getAllByTestId('ref-row')
    .find((r) => r.textContent?.includes('Год')) as HTMLElement;
  expect(year).toHaveAttribute('data-archived', 'true');
  expect(within(year).getByText('в архиве')).toBeInTheDocument();

  // Больше ничего не правили — вычистка архивного и сама правка навигации.
  fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(batches()).toHaveLength(1));
  expect(batches()).toEqual([
    [
      {
        tool: 'entity_update',
        input: { id: SHELL, props: { [APP_NAV]: NAV_IDS.filter((x) => x !== YEAR) } },
      },
    ],
  ]);
  await waitFor(() => expect(toastTitles()).toEqual(['Навигация сохранена']));
});

test('(б) своё приложение: раздел «Приложение «Мой дом»» правит его запись', async () => {
  resetFrame(`/a/${MY}`);
  const { batches } = renderApp([...baseRows(), MY_ROW]);
  await heading('Кухня');
  const editor = await openNavEditor('Мой дом');
  await waitFor(() => expect(rowTitles(editor)).toEqual(['Ремонт']));
  fireEvent.click(within(editor).getByRole('button', { name: 'Убрать: Ремонт' }));
  fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(batches()).toHaveLength(1));
  expect(batches()).toEqual([
    [{ tool: 'entity_update', input: { id: MY, props: { [APP_NAV]: [] } } }],
  ]);
});

// ─── (в) «Добавить в навигацию» / «Убрать из навигации» / «Новое приложение…» ──────────────────

test('(в) страница в хосте: «Добавить в навигацию» — текущее приложение по умолчанию → пачка; затем рядом «Убрать из навигации» (R-34)', async () => {
  resetFrame(`/r/${LOOSE}`);
  const { batches } = renderApp([...baseRows(), MY_ROW]);
  await heading('Общая страница');
  await openMenu();
  expect(ownItems()).toContain('Добавить в навигацию');
  expect(ownItems()).not.toContain('Убрать из навигации');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Добавить в навигацию' }));

  const dialog = await screen.findByRole('dialog', { name: 'Добавить в навигацию' });
  expect(within(dialog).getByRole('radio', { name: 'Orbis' })).toBeChecked();
  expect(within(dialog).getByRole('radio', { name: 'Мой дом' })).not.toBeChecked();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }));
  await waitFor(() => expect(batches()).toHaveLength(1));
  expect(batches()[0]).toEqual([
    { tool: 'entity_update', input: { id: SHELL, props: { [APP_NAV]: [...NAV_IDS, LOOSE] } } },
  ]);

  // R-34: запись уже стоит — рядом «Убрать из навигации»; «Добавить» остаётся (в другое приложение).
  await waitFor(async () => {
    const items = await ownItemsOnce();
    expect(items).toContain('Убрать из навигации');
    expect(items).toContain('Добавить в навигацию');
  });
  // Без дублей: в выборе текущее приложение, где запись уже стоит, не выбирается; по умолчанию —
  // первое, где её ещё нет.
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Добавить в навигацию' }));
  const again = await screen.findByRole('dialog', { name: 'Добавить в навигацию' });
  expect(within(again).getByRole('radio', { name: 'Orbis (уже здесь)' })).toBeDisabled();
  expect(within(again).getByRole('radio', { name: 'Мой дом' })).toBeChecked();
  fireEvent.click(within(again).getByRole('button', { name: 'Отмена' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Убрать из навигации' }));
  await waitFor(() => expect(batches()).toHaveLength(2));
  expect(batches()[1]).toEqual([
    { tool: 'entity_update', input: { id: SHELL, props: { [APP_NAV]: [...NAV_IDS] } } },
  ]);
});

test('(в) приложение, где запись уже стоит, в диалоге не выбирается («уже здесь»)', async () => {
  resetFrame(`/r/${LOOSE}`);
  const my = { ...MY_ROW, props: { ...MY_ROW.props, [APP_NAV]: [REPAIR, LOOSE] } };
  renderApp([...baseRows(), my]);
  await heading('Общая страница');
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Добавить в навигацию' }));
  const dialog = await screen.findByRole('dialog', { name: 'Добавить в навигацию' });
  expect(within(dialog).getByRole('radio', { name: 'Мой дом (уже здесь)' })).toBeDisabled();
});

test('(в) Фокус ревью п. 2: добавление в навигацию с архивным разделом — архивный вычищен, пачка проходит', async () => {
  resetFrame(`/r/${LOOSE}`);
  const rows = baseRows().map((r) => (r.id === YEAR ? { ...r, archived: true } : r));
  const { batches } = renderApp(rows);
  await heading('Общая страница');
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Добавить в навигацию' }));
  const dialog = await screen.findByRole('dialog', { name: 'Добавить в навигацию' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }));
  await waitFor(() => expect(batches()).toHaveLength(1));
  expect(batches()[0]).toEqual([
    {
      tool: 'entity_update',
      input: { id: SHELL, props: { [APP_NAV]: [...NAV_IDS.filter((x) => x !== YEAR), LOOSE] } },
    },
  ]);
  await waitFor(() => expect(toastTitles()).toEqual(['Добавлено в навигацию «Orbis»']));
});

test('(в) «Новое приложение…» («Мой дом» 🏡) — одна пачка entity_create с домашней и разделом; «Дом» ставит сервер', async () => {
  resetFrame(`/r/${LOOSE}`);
  const { batches, byId } = renderApp();
  await heading('Общая страница');
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Добавить в навигацию' }));
  const dialog = await screen.findByRole('dialog', { name: 'Добавить в навигацию' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Новое приложение…' }));

  const create = await screen.findByRole('dialog', { name: 'Новое приложение' });
  fireEvent.change(within(create).getByRole('textbox', { name: 'Имя' }), {
    target: { value: 'Мой дом' },
  });
  fireEvent.change(within(create).getByRole('textbox', { name: 'Иконка' }), {
    target: { value: '🏡' },
  });
  fireEvent.click(within(create).getByRole('button', { name: 'Создать' }));
  await waitFor(() => expect(batches()).toHaveLength(1));
  const [ops] = batches();
  expect(ops).toHaveLength(1);
  const created = ops?.[0]?.input.id as string;
  expect(ops).toEqual([
    {
      tool: 'entity_create',
      input: {
        id: created,
        title: 'Мой дом',
        emoji: '🏡',
        tags: [],
        aspects: [APP_ASPECT],
        props: { [APP_HOME]: LOOSE, [APP_NAV]: [LOOSE], [APP_NAV_FORM]: 'header-list' },
      },
    },
  ]);
  // Клиент «Дом» НЕ шлёт: его ставит сервер (follow-up задачи 10) — одно правило для всех акторов.
  expect(JSON.stringify(ops)).not.toContain(HOME_PROPERTY);
  // Ответ сервера: у страницы «Дом» = новое приложение, и она переезжает в его рамку.
  expect(byId.get(LOOSE)?.props[HOME_PROPERTY]).toBe(created);
  await waitFor(() => expect(shownPath()).toBe(`/a/${created}/r/${LOOSE}`), { timeout: 3000 });
});

// ─── (г) «Сделать шаблоном для…» получает «Дом» рамки ──────────────────────────────────────────

async function makeTemplateForTasks(): Promise<void> {
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Сделать шаблоном для…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Сделать шаблоном для…' });
  fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'Задача' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
}

test('(г) «Сделать шаблоном для…» в рамке «Мой дом» — пачка с «Дом» = «Мой дом»', async () => {
  resetFrame(`/a/${MY}`);
  const { batches } = renderApp([...baseRows(), MY_ROW]);
  await heading('Кухня');
  await makeTemplateForTasks();
  await waitFor(() => expect(batches()).toHaveLength(1));
  expect(batches()).toEqual([
    [
      {
        tool: 'entity_update',
        input: {
          id: KITCHEN,
          props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/task'], [HOME_PROPERTY]: MY },
        },
      },
    ],
  ]);
});

test('(г) в хосте — без «Дома»', async () => {
  resetFrame(`/r/${LOOSE}`);
  const { batches } = renderApp([...baseRows(), MY_ROW]);
  await heading('Общая страница');
  await makeTemplateForTasks();
  await waitFor(() => expect(batches()).toHaveLength(1));
  expect(batches()).toEqual([
    [
      {
        tool: 'entity_update',
        input: { id: LOOSE, props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/task'] } },
      },
    ],
  ]);
});

// ─── (д) поле «Дом» в карточке страницы ────────────────────────────────────────────────────────

test('(д) карточка аспекта «страница» — «Дом» ссылочным контролом с выбором приложений', async () => {
  const entity = pageRow(LOOSE, 'Общая страница');
  const { calls } = renderWithProviders(
    <AspectSection entity={entity as never} aspectId={PAGE_ASPECT} />,
    (path) => {
      const reg = registryReply(path);
      if (reg !== undefined) return reg;
      if (path === 'entity.query') return [MY_ROW];
      return {};
    },
  );
  const home = await screen.findByTestId(`prop-${HOME_PROPERTY}`);
  expect(home).toHaveAttribute('data-kind', 'ref');
  expect(await within(home).findByRole('option', { name: 'Мой дом' })).toBeInTheDocument();
  // Выдача — по цели свойства: записи-приложения (без оболочки хоста, правило каталога задачи 9).
  const asked = calls.find((c) => c.path === 'entity.query');
  expect(JSON.stringify(asked?.input)).toContain(APP_ASPECT);
});

// ─── Раунд 1 гейта ─────────────────────────────────────────────────────────────────────────────

test('M-2: у архивной записи «Добавить в навигацию» нет — поставить её нельзя', async () => {
  resetFrame(`/r/${LOOSE}`);
  const rows = baseRows().map((r) => (r.id === LOOSE ? { ...r, archived: true } : r));
  renderApp([...rows, MY_ROW]);
  await heading('Общая страница');
  const items = await ownItemsOnce();
  expect(items).toContain('Разархивировать');
  expect(items).not.toContain('Добавить в навигацию');
});

test('M-3: поиск редактора не предлагает само приложение ни разделом, ни домашней', async () => {
  resetFrame(`/a/${MY}/r/${REPAIR}`);
  renderApp([...baseRows(), MY_ROW]);
  await heading('Ремонт');
  const editor = await openNavEditor('Мой дом');
  for (const name of ['Добавить: Разделы', 'Сменить домашнюю']) {
    fireEvent.change(within(editor).getByRole('searchbox', { name }), { target: { value: 'дом' } });
    const found = await within(editor).findByRole('list', { name: `Найдено: ${name}` });
    await within(found).findByRole('button', { name: /Домой/ });
    expect(within(found).queryByRole('button', { name: /Мой дом/ })).toBeNull();
    fireEvent.change(within(editor).getByRole('searchbox', { name }), { target: { value: '' } });
  }
});

test('M-3: отказ пачки — редактор не закрывается, черновик цел, отказ виден в нём', async () => {
  resetFrame('/');
  const { batches } = renderApp(baseRows(), { rejectBatch: true });
  await heading('Домой');
  const editor = await openNavEditor('Orbis');
  await waitFor(() => expect(rowTitles(editor)).toEqual(HOST_TITLES));
  fireEvent.change(within(editor).getByRole('textbox', { name: 'Имя' }), {
    target: { value: 'Мой Orbis' },
  });
  fireEvent.click(within(editor).getByRole('button', { name: 'Выше: Upcoming' }));
  fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(batches()).toHaveLength(1));
  expect(await within(editor).findByRole('alert')).toHaveTextContent('Не удалось сохранить');
  expect(screen.getByTestId('nav-editor')).toBe(editor);
  expect(within(editor).getByRole('textbox', { name: 'Имя' })).toHaveValue('Мой Orbis');
  expect(rowTitles(editor)).toEqual([
    'Записи',
    'Upcoming',
    'Daily Planning',
    'All Tasks',
    'Год',
    'Рутины',
  ]);
});

test('M-5: архивная «Домашняя» — плашка в редакторе; нетронутая не пишется, правка проходит', async () => {
  resetFrame(`/a/${MY}/r/${REPAIR}`);
  const rows = baseRows().map((r) => (r.id === KITCHEN ? { ...r, archived: true } : r));
  const { batches } = renderApp([...rows, MY_ROW]);
  await heading('Ремонт');
  const editor = await openNavEditor('Мой дом');
  const home = await within(editor).findByTestId('nav-home');
  await waitFor(() => expect(home).toHaveAttribute('data-archived', 'true'));
  expect(within(home).getByText('в архиве')).toBeInTheDocument();
  expect(home).toHaveTextContent('Кухня');

  fireEvent.change(within(editor).getByRole('combobox', { name: 'Форма навигации' }), {
    target: { value: 'home-hub' },
  });
  fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(batches()).toHaveLength(1));
  // Домашнюю не трогали — её нет в правке (сервер отверг бы архивную цель).
  expect(batches()).toEqual([
    [{ tool: 'entity_update', input: { id: MY, props: { [APP_NAV_FORM]: 'home-hub' } } }],
  ]);
  await waitFor(() => expect(toastTitles()).toEqual(['Навигация сохранена']));
});

test('M-4: выбранная домашняя до ответа сервера — её заголовок, не uuid «не найдено»', async () => {
  resetFrame('/');
  const s = store(baseRows());
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  renderWithProviders(<App />, async (path, input, type) => {
    if (path === 'entity.resolveRefs' && (input as { ids: string[] }).ids.includes(LOOSE))
      await gate;
    return s.handler(path, input, type);
  });
  await heading('Домой');
  const editor = await openNavEditor('Orbis');
  fireEvent.change(within(editor).getByRole('searchbox', { name: 'Сменить домашнюю' }), {
    target: { value: 'общая' },
  });
  fireEvent.click(await within(editor).findByRole('button', { name: 'Общая страница' }));
  const home = within(editor).getByTestId('nav-home');
  expect(home).toHaveTextContent('Общая страница');
  expect(within(home).queryByText('не найдено')).toBeNull();
  release();
  await waitFor(() => expect(home).toHaveTextContent('Общая страница'));
  expect(within(home).queryByText('не найдено')).toBeNull();
});
