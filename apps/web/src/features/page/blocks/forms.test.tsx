import { BUILTIN_PROPERTY_META } from '@orbis/shared';
import { MISPLACED_HINT } from '@orbis/shared/doc/placement';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { BodyKindProvider } from '../../../lib/query-blocks/body-kind';
import { displayText } from '../../../lib/registry/format';
import { useNav } from '../../../state/navigation';
import {
  blocksReply,
  blockTexts,
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  wireEntity,
} from '../../../test/harness';
import { registryReply } from '../../../test/registry';
import { PinnedList } from '../../browser/PinnedList';
import { EditorShell } from '../../entity-editor/EditorShell';
import { DataBlock } from './DataBlock';

// Формы показа блока данных (спека страниц 1а §5.4, §7.2): `display` читается везде, где
// рисуется блок (РП-5), ошибка блока — плашкой (§6.5).

installCrashTrap();

beforeEach(() => {
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

const handler =
  (map: Parameters<typeof blocksReply>[0]): MockHandler =>
  (path, input) =>
    registryReply(path) ?? blocksReply(map)(path, input) ?? {};

const batches = (calls: { path: string; input: unknown }[]) =>
  calls.filter((c) => c.path === 'entity.blocks');

const task = (id: string, props: Record<string, unknown> = {}) =>
  wireEntity({
    id,
    title: id,
    aspects: ['orbis/task'],
    props: { 'orbis/task_status': 'inbox', ...props },
  });

const prop = (id: string) => {
  const def = BUILTIN_PROPERTY_META.find((p) => p.id === id);
  if (def === undefined) throw new Error(`нет встроенного свойства ${id}`);
  return def;
};

test('compact: строка — кнопка, открывающая запись', async () => {
  const text = 'aspect=orbis/task, display=compact';
  renderWithProviders(<DataBlock text={text} />, handler({ [text]: [task('Отчёт')] }));
  const item = await screen.findByTestId('qb-item');
  fireEvent.click(within(item).getByRole('button', { name: 'Отчёт' }));
  expect(useNav.getState().stacks.browser.at(-1)).toEqual({ kind: 'entity', id: 'Отчёт' });
});

test('compact — форма по умолчанию (display не задан)', async () => {
  const text = 'aspect=orbis/task';
  renderWithProviders(<DataBlock text={text} />, handler({ [text]: [task('Отчёт')] }));
  const item = await screen.findByTestId('qb-item');
  expect(within(item).getByRole('button', { name: 'Отчёт' })).toBeInTheDocument();
  expect(screen.queryByRole('table')).toBeNull();
});

test('list: строки EntityRow — глиф статуса есть, чекбокса-контрола нет (Р-13)', async () => {
  const text = 'aspect=orbis/task, display=list';
  renderWithProviders(
    <DataBlock text={text} />,
    handler({ [text]: [task('Отчёт', { 'orbis/due_date': '2026-07-18' })] }),
  );
  const item = await screen.findByTestId('qb-item');
  // Строка EntityRow: элементы строки фактов — срок из привязки контракта `orbis/when`.
  await waitFor(() => expect(item).toHaveTextContent('18 июл.'));
  expect(item.querySelector('svg')).not.toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.click(within(item).getByRole('button'));
  expect(useNav.getState().stacks.browser.at(-1)).toEqual({ kind: 'entity', id: 'Отчёт' });
});

test('table без columns: заголовок и элементы строки фактов', async () => {
  const text = 'aspect=orbis/task, display=table';
  renderWithProviders(
    <DataBlock text={text} />,
    handler({ [text]: [task('Отчёт', { 'orbis/due_date': '2026-07-18' })] }),
  );
  const table = await screen.findByRole('table');
  await waitFor(() => expect(within(table).getByText('18 июл.')).toBeInTheDocument());
  const headers = within(table)
    .getAllByRole('columnheader')
    .map((h) => h.textContent);
  expect(headers[0]).toBe('Название');
  expect(headers).toContain('Дата');
  expect(within(table).getByText('Отчёт')).toBeInTheDocument();
});

test('table с columns: колонки свойств со значениями displayText', async () => {
  const text = 'aspect=orbis/task, display=table, columns=orbis/due_date|orbis/priority';
  renderWithProviders(
    <DataBlock text={text} />,
    handler({
      [text]: [task('Отчёт', { 'orbis/due_date': '2026-07-18', 'orbis/priority': 'high' })],
    }),
  );
  const table = await screen.findByRole('table');
  await waitFor(() =>
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Название', 'Срок', 'Приоритет']),
  );
  const cells = within(table)
    .getAllByRole('cell')
    .map((c) => c.textContent);
  expect(cells).toEqual([
    'Отчёт',
    displayText(prop('orbis/due_date'), '2026-07-18'),
    displayText(prop('orbis/priority'), 'high'),
  ]);
  // Подпись варианта, а не машинный ключ: значение — по ТИПУ свойства.
  expect(cells[2]).toBe('Высокий');
});

test('tile count — число и подпись title', async () => {
  const text = 'aspect=orbis/task, display=tile, aggregate=count, title=Задач';
  renderWithProviders(
    <DataBlock text={text} />,
    handler({ [text]: { ok: true, kind: 'count', count: 7 } }),
  );
  const tile = await screen.findByTestId('qb-tile');
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent('7');
  expect(tile).toHaveTextContent('Задач');
});

test('tile sum — сумма с символом валюты (RUB → ₽)', async () => {
  const text = 'aspect=orbis/financial, display=tile, aggregate=sum:orbis/amount, title=Потрачено';
  renderWithProviders(
    <DataBlock text={text} />,
    handler({ [text]: { ok: true, kind: 'sum', sum: '1200.50', count: 3, currencies: ['RUB'] } }),
  );
  const tile = await screen.findByTestId('qb-tile');
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent('1 200.50 ₽');
  expect(tile).toHaveTextContent('Потрачено');
  expect(screen.queryByTestId('qb-currencies')).toBeNull();
});

test('tile sum в разных валютах — сумма без символа и плашка «разные валюты» (РП-20)', async () => {
  const text = 'aspect=orbis/financial, display=tile, aggregate=sum:orbis/amount';
  renderWithProviders(
    <DataBlock text={text} />,
    handler({
      [text]: { ok: true, kind: 'sum', sum: '300', count: 2, currencies: ['RUB', 'USD'] },
    }),
  );
  const tile = await screen.findByTestId('qb-tile');
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent(/^300$/);
  expect(screen.getByTestId('qb-currencies')).toHaveTextContent('разные валюты: RUB, USD');
});

test('tile latest — значение', async () => {
  const text =
    'aspect=orbis/financial, display=tile, aggregate=latest:orbis/amount, title=Последняя';
  renderWithProviders(
    <DataBlock text={text} />,
    handler({ [text]: { ok: true, kind: 'latest', value: '72.5' } }),
  );
  const tile = await screen.findByTestId('qb-tile');
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent('72.5');
});

test('«ещё 2» раскрывается на месте — второй вызов пачкой из одного с бо́льшим limit', async () => {
  const text = 'aspect=orbis/task, limit=3';
  const rows = ['р1', 'р2', 'р3', 'р4', 'р5'].map((id) => task(id));
  const { calls } = renderWithProviders(
    <DataBlock text={text} />,
    handler({
      [text]: (b) =>
        b.limit === undefined
          ? { ok: true, kind: 'rows', rows: rows.slice(0, 3) as never, more: 2 }
          : { ok: true, kind: 'rows', rows: rows.slice(0, b.limit) as never, more: 0 },
    }),
  );
  await waitFor(() => expect(screen.getAllByTestId('qb-item')).toHaveLength(3));
  fireEvent.click(screen.getByRole('button', { name: 'ещё 2' }));
  await waitFor(() => expect(screen.getAllByTestId('qb-item')).toHaveLength(5));
  expect(screen.queryByRole('button', { name: /ещё/ })).toBeNull();
  const second = batches(calls)[1]?.input as { blocks: { text: string; limit?: number }[] };
  expect(second.blocks).toHaveLength(1);
  expect(second.blocks[0]).toMatchObject({ text, limit: 5 });
});

test('абсолютная дата: на странице — плашка с подсказкой токенов, в заметке — данные (С1а-9)', async () => {
  const text = 'aspect=orbis/task, orbis/due_date>2026-10-01';
  const page = renderWithProviders(
    <BodyKindProvider kind="page">
      <DataBlock text={text} />
    </BodyKindProvider>,
    handler({ [text]: [task('Отчёт')] }),
  );
  const plaque = await page.findByTestId('qb-error');
  expect(plaque).toHaveTextContent('2026-10-01');
  expect(plaque).toHaveTextContent('today');
  expect(batches(page.calls)).toHaveLength(0);
  page.unmount();

  const note = renderWithProviders(
    <BodyKindProvider kind="note">
      <DataBlock text={text} />
    </BodyKindProvider>,
    handler({ [text]: [task('Отчёт')] }),
  );
  expect(await note.findByTestId('qb-item')).toHaveTextContent('Отчёт');
  expect(note.queryByTestId('qb-error')).toBeNull();
  expect(batches(note.calls).map(blockTexts)).toEqual([[text]]);
});

test('счётчик закреплённого (PinnedList) по-прежнему зовёт entity.count, а не entity.blocks (§6.3)', async () => {
  const { calls } = renderWithProviders(<PinnedList onOpen={() => {}} />, (path) => {
    if (path === 'user.getSettings') return { pinnedEntities: [{ id: 'p1', order: 0 }] };
    if (path === 'entity.get')
      return { entity: { ...wireEntity({ id: 'p1', title: 'Inbox' }), body: '{{query:tags=x}}' } };
    if (path === 'entity.count') return { count: 4 };
    return registryReply(path) ?? {};
  });
  await screen.findByText('4');
  expect(calls.find((c) => c.path === 'entity.count')?.input).toEqual({ query: 'tags=x' });
  expect(calls.some((c) => c.path === 'entity.blocks')).toBe(false);
});

test('первый кадр заметки: блок обвязки и контейнер — плашкой с подсказкой, блок данных — живой (§5.5)', async () => {
  const md = [
    'Вступление',
    '',
    '{{title}}',
    '',
    '{{columns}}',
    '{{column}}',
    'слева',
    '{{/column}}',
    '{{column}}',
    'справа',
    '{{/column}}',
    '{{/columns}}',
    '',
    '{{query:tags=x}}',
  ].join('\n');
  renderWithProviders(
    <EditorShell doc={null} markdown={md} onChange={() => {}} />,
    handler({ 'tags=x': [task('Отчёт')] }),
  );
  expect(await screen.findByTestId('qb-item')).toHaveTextContent('Отчёт');
  const plaques = screen.getAllByTestId('block-misplaced');
  expect(plaques).toHaveLength(2);
  for (const p of plaques) expect(p).toHaveTextContent(MISPLACED_HINT);
  expect(plaques[0]).toHaveTextContent('{{title}}');
  expect(plaques[1]).toHaveTextContent('{{columns}}');
  // Содержимое контейнера не рисуется ни текстом, ни раскладкой: в заметке его нет (§9.1).
  expect(screen.queryByText('слева')).toBeNull();
  expect(screen.getByText('Вступление')).toBeInTheDocument();
});

test('F2: у потолка строк «ещё N» не рисуется — подпись «показаны первые 500»', async () => {
  const text = 'aspect=orbis/task';
  const rows = Array.from({ length: 500 }, (_, i) => wireEntity({ id: `r${i}`, title: `r${i}` }));
  renderWithProviders(
    <DataBlock text={text} />,
    handler({ [text]: { ok: true, kind: 'rows', rows: rows as never, more: 3 } }),
  );
  expect(await screen.findByTestId('qb-cap')).toHaveTextContent('показаны первые 500');
  expect(screen.queryByRole('button', { name: /ещё/ })).toBeNull();
  // Счётчик по-прежнему честен: совпадений больше, чем показано.
  expect(screen.getByTestId('qb-count')).toHaveTextContent('503');
});

test('F4: незнакомый вид ответа — плашка «обновите приложение», а не пустая карточка', async () => {
  const text = 'aspect=orbis/task';
  renderWithProviders(
    <DataBlock text={text} />,
    handler({ [text]: { ok: true, kind: 'histogram', buckets: [] } as never }),
  );
  expect(await screen.findByTestId('qb-error')).toHaveTextContent('обновите приложение');
  expect(screen.queryByTestId('qb-tile')).toBeNull();
});
