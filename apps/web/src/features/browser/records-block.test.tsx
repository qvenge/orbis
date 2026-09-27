/**
 * Блок «Записи» (`{{records}}`, спека 1б §3.5, §9.6, §12, С1б-12): сегодняшний экран Browser одним
 * блоком-экраном со СВОЕЙ точкой лени.
 *
 * Страницы и приложения в общем списке по умолчанию скрыты (отрицания в тексте запроса),
 * переключатель их показывает. Блок открывает запись через проп `onOpen` — куда открывать, решает
 * место показа: на странице — рендерер (текущий раздел), на экране «Обзор» — его стопка.
 *
 * Модуль блока (`RecordsBlock.tsx`) грузится только тогда, когда узел `{{records}}` рисуется: экран
 * записи открывается при каждом заходе в запись, и список с фильтрами, быстрым вводом и строками
 * в его первом кадре — вес, который платит каждая запись ради одной страницы (Н-9).
 */
import { PAGE_ASPECT } from '@orbis/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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
import { queryClient } from '../../trpc';
import { DetailScreen } from '../entity-detail/DetailScreen';
import { structureHandler } from '../entity-detail/structure-fixtures';
import { BrowserScreen } from './BrowserScreen';
import { RECORDS_HIDE_PAGES_AND_APPS } from './query';
import { resetRecordsBlockModuleForTests } from './RecordsBlockSlot';

/**
 * «Сеть» чанка блока: `attempts` — сколько раз модуль реально запросили, `gate` — медленный чанк
 * (загрузка ждёт его, прежде чем отдать модуль). По умолчанию чанк приезжает сразу.
 */
const chunk = vi.hoisted(() => ({ attempts: 0, gate: Promise.resolve() as Promise<void> }));

installCrashTrap();

const PAGE_ID = '00000000-0000-4000-8000-000000001801';
const rowId = (i: number) => `00000000-0000-4000-8000-0000000019${String(i).padStart(2, '0')}`;
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => wireEntity({ id: rowId(i), title: `Запись ${i}` }));

/** Текст запроса блока при выключенном переключателе и первой странице. */
const HIDDEN_QUERY =
  '!aspect=orbis/page, !aspect=orbis/app, sortBy=orbis/updated_at:desc, limit=50';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('requestIdleCallback', () => 1);
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  // Ленивый компонент помнит удавшуюся загрузку: без сброса «до рендера узла» проверялось бы
  // только в первом тесте файла.
  resetRecordsBlockModuleForTests();
  // Мок — заново на каждый тест: реестр модулей vitest помнит удавшуюся загрузку.
  vi.doMock('./RecordsBlock', async (importOriginal) => {
    chunk.attempts += 1;
    await chunk.gate;
    return importOriginal();
  });
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: PAGE_ID }], agenda: [], budget: [] },
  });
});

afterEach(() => {
  vi.doUnmock('./RecordsBlock');
  vi.unstubAllGlobals();
  chunk.attempts = 0;
  chunk.gate = Promise.resolve();
});

/** Запрос списка «Записей» (а не записи поставки, прогоны и прочие `entity.query` экрана). */
const isRecordsList = (path: string, input: unknown): boolean =>
  path === 'entity.query' &&
  String((input as { query?: string } | undefined)?.query ?? '').includes(
    'sortBy=orbis/updated_at:desc',
  );

const queriesOf = (calls: { path: string; input: unknown }[]): string[] =>
  calls
    .filter((c) => isRecordsList(c.path, c.input))
    .map((c) => (c.input as { query: string }).query);

/** Ответ списка: по `limit=` запроса — столько строк, сколько «есть» в графе (`total`). */
const listReply =
  (total: number): MockHandler =>
  (path, input) => {
    if (!isRecordsList(path, input)) return undefined;
    const q = (input as { query: string }).query;
    const limit = Number(/limit=(\d+)/.exec(q)?.[1] ?? '50');
    return rows(Math.min(total, limit));
  };

const page = (body: string): WireEntityFixture =>
  wireEntity({ id: PAGE_ID, title: 'Записи', body, aspects: [PAGE_ASPECT] });

/** Экран записи над страницей — так её откроет человек (образец — `page/render.test.tsx`). */
function openPage(entity: WireEntityFixture, over: MockHandler = listReply(3)) {
  const screenHandler = structureHandler({ name: 'page', entity, extra: {} });
  const handler: MockHandler = async (path, input) => {
    const own = await over(path, input);
    return own !== undefined ? own : screenHandler(path, input);
  };
  return renderWithProviders(<DetailScreen entityId={entity.id} />, handler, {
    queries: queryClient.getDefaultOptions().queries,
  });
}

/** Сам блок — модулем, как его отдаёт ленивая загрузка (статический импорт сломал бы пробу лени). */
async function renderBlock(onOpen: (id: string) => void, handler: MockHandler) {
  const { RecordsBlock } = await import('./RecordsBlock');
  return renderWithProviders(<RecordsBlock onOpen={onOpen} />, handler);
}

test('первый кадр экрана записи не грузит модуль «Записей»; узел {{records}} — скелетон, потом список (своя точка лени, Н-9)', async () => {
  let release: () => void = () => {};
  chunk.gate = new Promise<void>((r) => {
    release = r;
  });

  // Запись-страница без блока: экран записи целиком, а модуль блока не запрошен ни разу.
  const plain = openPage(page('Только текст\n'));
  expect(await screen.findByText('Только текст')).toBeInTheDocument();
  expect(chunk.attempts).toBe(0);
  plain.unmount();

  // Узел нарисован — модуль запрошен; пока чанк едет, на месте блока скелетон, а не пустота.
  openPage(page('Вступление\n\n{{records}}\n'));
  expect(await screen.findByText('Вступление')).toBeInTheDocument();
  await waitFor(() => expect(chunk.attempts).toBe(1));
  expect(screen.getByTestId('records-loading')).toBeInTheDocument();
  expect(screen.queryByTestId('records-block')).toBeNull();

  await act(async () => release());
  expect(await screen.findByTestId('records-block')).toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByTestId('entity-row')).toHaveLength(3));
  expect(screen.queryByTestId('records-loading')).toBeNull();
});

test('страница с {{records}} рисует список записей: запрос без страниц и приложений (§9.6)', async () => {
  expect(RECORDS_HIDE_PAGES_AND_APPS).toBe('!aspect=orbis/page, !aspect=orbis/app');
  const { calls } = openPage(page('{{records}}\n'));
  const block = await screen.findByTestId('records-block');
  await waitFor(() => expect(within(block).getAllByTestId('entity-row')).toHaveLength(3));
  expect(within(block).getByText('Запись 0')).toBeInTheDocument();
  expect(queriesOf(calls)).toEqual([HIDDEN_QUERY]);
  // Переключатель по умолчанию выключен — страницы и приложения скрыты.
  expect(within(block).getByLabelText('Показать страницы и приложения')).not.toBeChecked();
  // Показ ничего не пишет.
  expect(calls.some((c) => c.path.startsWith('entity.update'))).toBe(false);
});

test('переключатель «Показать страницы и приложения» снимает отрицания, выключение возвращает их', async () => {
  const pageRow = wireEntity({ id: rowId(50), title: 'Страница «Утро»', aspects: [PAGE_ASPECT] });
  // Сервер отвечает по тексту: без отрицаний в выдаче есть и страница.
  const { calls } = await renderBlock(
    () => {},
    (path, input) => {
      const list = listReply(3)(path, input);
      if (!Array.isArray(list)) return list;
      const q = (input as { query: string }).query;
      return q.includes('!aspect=orbis/page') ? list : [pageRow, ...list];
    },
  );
  await waitFor(() => expect(screen.getAllByTestId('entity-row')).toHaveLength(3));
  expect(screen.queryByText('Страница «Утро»')).toBeNull();
  const toggle = screen.getByLabelText('Показать страницы и приложения');

  fireEvent.click(toggle);
  expect(toggle).toBeChecked();
  expect(await screen.findByText('Страница «Утро»')).toBeInTheDocument();
  expect(queriesOf(calls)).toEqual([HIDDEN_QUERY, 'sortBy=orbis/updated_at:desc, limit=50']);

  fireEvent.click(toggle);
  expect(toggle).not.toBeChecked();
  await waitFor(() => expect(screen.queryByText('Страница «Утро»')).toBeNull());
  expect(screen.getAllByTestId('entity-row')).toHaveLength(3);
});

test('фильтр по тегу работает и не снимает отрицаний', async () => {
  const { calls } = await renderBlock(() => {}, listReply(3));
  await waitFor(() => expect(screen.getAllByTestId('entity-row')).toHaveLength(3));
  const input = screen.getByLabelText('Добавить тег');
  fireEvent.change(input, { target: { value: 'работа' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() =>
    expect(queriesOf(calls)).toContain(
      'tags=работа, !aspect=orbis/page, !aspect=orbis/app, sortBy=orbis/updated_at:desc, limit=50',
    ),
  );
});

test('«Показать ещё» добирает ещё 50', async () => {
  const { calls } = await renderBlock(() => {}, listReply(120));
  await waitFor(() => expect(screen.getAllByTestId('entity-row')).toHaveLength(50));
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
  await waitFor(() => expect(screen.getAllByTestId('entity-row')).toHaveLength(100));
  expect(queriesOf(calls)).toContain(
    '!aspect=orbis/page, !aspect=orbis/app, sortBy=orbis/updated_at:desc, limit=100',
  );
});

test('быстрый ввод создаёт запись', async () => {
  const created = wireEntity({ id: rowId(99), title: 'купить хлеб' });
  const { calls } = await renderBlock(
    () => {},
    (path, input) => (path === 'entity.create' ? created : listReply(0)(path, input)),
  );
  expect(await screen.findByText('Здесь появятся ваши записи')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/быстрая запись/i), { target: { value: 'купить хлеб' } });
  fireEvent.submit(screen.getByTestId('quick-capture-form'));
  await waitFor(() =>
    expect(calls.find((c) => c.path === 'entity.create')?.input).toMatchObject({
      source: 'quick_capture',
      input: { title: 'купить хлеб', tags: [] },
    }),
  );
});

test('нажатие строки зовёт onOpen(id) и не трогает стопки навигации само', async () => {
  const onOpen = vi.fn();
  const before = useNav.getState().stacks;
  await renderBlock(onOpen, listReply(3));
  const [, second] = await screen.findAllByTestId('entity-row');
  fireEvent.click(second as HTMLElement);
  expect(onOpen).toHaveBeenCalledWith(rowId(1));
  expect(useNav.getState().stacks).toEqual(before);
});

test('блок во вкладке контейнера рисуется; строка открывает запись в текущем разделе', async () => {
  // Раздел — не «Обзор»: жёсткий `push('browser', …)` увёл бы запись в чужую стопку.
  useNav.setState({
    activeTab: 'budget',
    stacks: { chat: [], browser: [], agenda: [], budget: [{ kind: 'entity', id: PAGE_ID }] },
  });
  openPage(
    page(`{{tabs}}
{{tab: Все записи}}
{{records}}
{{/tab}}
{{tab: Другое}}
Текст вкладки
{{/tab}}
{{/tabs}}
`),
  );
  const block = await screen.findByTestId('records-block');
  const panel = block.closest<HTMLElement>('[role="tabpanel"]');
  expect(panel).not.toBeNull();
  expect(panel).toHaveAttribute('data-state', 'active');
  const [first] = await within(block).findAllByTestId('entity-row');
  fireEvent.click(first as HTMLElement);
  // Рендерер открывает запись в активном разделе — поверх страницы, с которой ушли.
  expect(useNav.getState().stacks.budget).toEqual([
    { kind: 'entity', id: PAGE_ID },
    { kind: 'entity', id: rowId(0) },
  ]);
  expect(useNav.getState().stacks.browser).toEqual([]);
});

test('экран «Обзор» до рамки — шапка и тот же блок; строка открывается в стопке Обзора', async () => {
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
  const { calls } = renderWithProviders(<BrowserScreen />, (path, input) => {
    if (path === 'user.getSettings') return { pinnedEntities: [] };
    return listReply(2)(path, input) ?? {};
  });
  expect(screen.getByRole('heading', { name: 'Обзор' })).toBeInTheDocument();
  const block = await screen.findByTestId('records-block');
  const [first] = await within(block).findAllByTestId('entity-row');
  fireEvent.click(first as HTMLElement);
  expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: rowId(0) }]);
  expect(queriesOf(calls)).toEqual([HIDDEN_QUERY]);
});
