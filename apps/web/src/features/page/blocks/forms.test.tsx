import type { BlockResult, EntityBlocksResult } from '@orbis/shared';
import { MISPLACED_HINT } from '@orbis/shared/doc/placement';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, expect, test } from 'vitest';
import { BodyKindProvider } from '../../../lib/query-blocks/body-kind';
import { ThisEntityProvider } from '../../../lib/query-blocks/this-entity';
import { useBadgeData } from '../../../lib/query-blocks/useBadgeData';
import { resetNavForTests } from '../../../state/navigation';
import {
  BLOCKS_TIME_ZONE,
  BLOCKS_TODAY,
  blocksReply,
  blockTexts,
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  trpcError,
  wireEntity,
} from '../../../test/harness';
import { recordAddress, topAddress } from '../../../test/nav';
import { BUILTIN_REGISTRY, registryReply } from '../../../test/registry';
import { EditorShell } from '../../entity-editor/EditorShell';
import { REGISTRY_FAILED_MESSAGE } from './BlockPlaque';
import { DataBlock } from './DataBlock';

// Формы показа блока данных (спека страниц 1а §5.4, §7.2): `display` читается везде, где
// рисуется блок (РП-5), ошибка блока — плашкой (§6.5).

installCrashTrap();

beforeEach(() => {
  resetNavForTests();
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

test('compact: строка — кнопка, открывающая запись', async () => {
  const text = 'aspect=orbis/task, display=compact';
  renderWithProviders(<DataBlock text={text} />, handler({ [text]: [task('Отчёт')] }));
  const item = await screen.findByTestId('qb-item');
  fireEvent.click(within(item).getByRole('button', { name: 'Отчёт' }));
  expect(topAddress()).toEqual(recordAddress('Отчёт'));
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
  expect(topAddress()).toEqual(recordAddress('Отчёт'));
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

test('table с columns: колонки свойств со значениями по типу', async () => {
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
  // Литералы, а не `displayText`: оракулом он закреплял бы сырой ISO даты (финальное ревью, C1-I2).
  // Подпись варианта, а не машинный ключ: значение — по ТИПУ свойства.
  expect(cells).toEqual(['Отчёт', '18 июл.', 'Высокий']);
});

test('table с columns=orbis/title|orbis/due_date: колонка заголовка одна (Л-3)', async () => {
  for (const [columns, headers, titleAt] of [
    ['orbis/title|orbis/due_date', ['Заголовок', 'Срок'], 0],
    ['orbis/due_date|orbis/title', ['Срок', 'Заголовок'], 1],
  ] as const) {
    resetNavForTests();
    const text = `aspect=orbis/task, display=table, columns=${columns}`;
    const { unmount } = renderWithProviders(
      <DataBlock text={text} />,
      handler({ [text]: [task('Отчёт', { 'orbis/due_date': '2026-07-18' })] }),
    );
    const table = await screen.findByRole('table');
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole('columnheader')
          .map((h) => h.textContent),
      ).toEqual(headers),
    );
    const cell = within(table).getAllByRole('cell')[titleAt];
    if (cell === undefined) throw new Error('нет ячейки заголовка');
    // Колонка заголовка из `columns` — тот же вход в запись, что и постоянная «Название».
    fireEvent.click(within(cell).getByRole('button', { name: 'Отчёт' }));
    expect(topAddress()).toEqual(recordAddress('Отчёт'));
    unmount();
  }
});

test('table с columns: core-свойство из полей строки, дата днём, ссылка названием (C1-I2)', async () => {
  const CATEGORY = '00000000-0000-4000-8000-000000000777';
  const text =
    'aspect=orbis/task, display=table, columns=orbis/updated_at|orbis/due_date|orbis/finance_category';
  const row = wireEntity({
    ...task('Отчёт', { 'orbis/due_date': '2026-07-18', 'orbis/finance_category': CATEGORY }),
    updatedAt: '2026-09-20T10:00:00.000Z',
  });
  const base = handler({ [text]: [row] });
  renderWithProviders(<DataBlock text={text} />, (path, input) => {
    if (path === 'user.getSettings') return { timezone: 'Europe/Moscow' };
    if (path === 'entity.get' && (input as { id: string }).id === CATEGORY) {
      return { entity: wireEntity({ id: CATEGORY, title: 'Еда' }), registryVersion: 'v' };
    }
    return base(path, input);
  });
  const table = await screen.findByRole('table');
  await waitFor(() => expect(within(table).getByText('Еда')).toBeInTheDocument());
  const cells = within(table)
    .getAllByRole('cell')
    .map((c) => c.textContent);
  // «Изменена» — поле строки `updatedAt` (в `props` core-значений нет никогда), в поясе владельца.
  expect(cells).toEqual(['Отчёт', '20 сент. 2026 г., 13:00', '18 июл.', 'Еда']);
  expect(cells.join(' ')).not.toContain(CATEGORY);
});

test('table с columns: деньги — с валютой привязки суммы (C1-I2)', async () => {
  const text = 'aspect=orbis/financial, display=table, columns=orbis/amount';
  const row = wireEntity({
    id: 'Обед',
    title: 'Обед',
    aspects: ['orbis/financial'],
    props: { 'orbis/amount': '1500.00', 'orbis/currency': 'USD', 'orbis/direction': 'expense' },
  });
  renderWithProviders(<DataBlock text={text} />, handler({ [text]: [row] }));
  const table = await screen.findByRole('table');
  await waitFor(() => expect(within(table).getByText('1 500.00 $')).toBeInTheDocument());
});

/**
 * «Закрыто» в формах блока — признак СЕРВЕРА (`closedIds`, Б-2 №78 п. 42), а не проекция строки:
 * набор `closed`, заданный условием, строка не вычисляет (`setClasses` отдаёт `[]`), и зачёркивание
 * по проекции расходилось бы с фильтром блока. Реестр ниже — встроенный, но с предикатным набором.
 */
const PREDICATE_CLOSED_REGISTRY = {
  ...BUILTIN_REGISTRY,
  contracts: BUILTIN_REGISTRY.contracts.map((c) =>
    c.id === 'orbis/completable' && c.kind === 'slots'
      ? { ...c, sets: { ...c.sets, closed: { op: '==', args: [{ slot: 'status' }, 'done'] } } }
      : c,
  ),
};
const closedHandler =
  (text: string, rows: unknown[], closedIds: string[], predicate: boolean): MockHandler =>
  (path, input) =>
    path === 'registry.effective'
      ? predicate
        ? PREDICATE_CLOSED_REGISTRY
        : BUILTIN_REGISTRY
      : (blocksReply({
          [text]: { ok: true, kind: 'rows', rows: rows as never, more: 0, closedIds },
        })(path, input) ?? {});

for (const display of ['list', 'compact', 'table'] as const) {
  test(`${display}: строка из closedIds зачёркнута, хотя проекция «открыто» (предикатный набор)`, async () => {
    const text = `aspect=orbis/task, display=${display}`;
    renderWithProviders(
      <DataBlock text={text} />,
      closedHandler(
        text,
        [
          task('Закрыта', { 'orbis/task_status': 'done', 'orbis/due_date': '2026-07-18' }),
          task('Открыта', { 'orbis/due_date': '2026-07-19' }),
        ],
        ['Закрыта'],
        true,
      ),
    );
    if (display !== 'compact') await screen.findByText('18 июл.');
    expect(await screen.findByText('Закрыта')).toHaveClass('line-through');
    expect(screen.getByText('Открыта')).not.toHaveClass('line-through');
  });

  test(`${display}: строка вне closedIds не зачёркнута, хотя проекция «закрыто»`, async () => {
    const text = `aspect=orbis/task, display=${display}`;
    renderWithProviders(
      <DataBlock text={text} />,
      closedHandler(
        text,
        [task('Сделана', { 'orbis/task_status': 'done', 'orbis/due_date': '2026-07-18' })],
        [],
        false,
      ),
    );
    if (display !== 'compact') await screen.findByText('18 июл.');
    expect(await screen.findByText('Сделана')).not.toHaveClass('line-through');
  });
}

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

// Сумма по валютам (спека 1в §3.6, РП-7): провод несёт суммы раздельно в порядке «валюта владельца,
// прочие по алфавиту, без валюты — последней». Плитка: одна — «12 000 ₽»; две–три — через « · » в
// порядке провода; больше трёх — плашка «разные валюты» с их перечнем.
const SUM_TEXT =
  'aspect=orbis/financial, display=tile, aggregate=sum:orbis/amount, title=Потрачено';

async function sumTile(sums: { currency: string | null; sum: string; count: number }[]) {
  renderWithProviders(
    <DataBlock text={SUM_TEXT} />,
    handler({
      [SUM_TEXT]: { ok: true, kind: 'sum', count: sums.reduce((n, s) => n + s.count, 0), sums },
    }),
  );
  return screen.findByTestId('qb-tile');
}

test('tile sum — одна валюта: сумма с символом (RUB → ₽), плашки нет', async () => {
  const tile = await sumTile([{ currency: 'RUB', sum: '12000', count: 3 }]);
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent(/^12 000 ₽$/);
  expect(tile).toHaveTextContent('Потрачено');
  expect(screen.queryByTestId('qb-currencies')).toBeNull();
});

test('tile sum — две и три валюты: через « · » в порядке провода, плашки нет', async () => {
  const tile = await sumTile([
    { currency: 'RUB', sum: '12000', count: 1 },
    { currency: 'USD', sum: '50', count: 1 },
  ]);
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent(/^12 000 ₽ · 50 \$$/);
  expect(screen.queryByTestId('qb-currencies')).toBeNull();
});

test('tile sum — три валюты одной строкой', async () => {
  const tile = await sumTile([
    { currency: 'RUB', sum: '12000', count: 1 },
    { currency: 'EUR', sum: '20', count: 1 },
    { currency: 'USD', sum: '50', count: 1 },
  ]);
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent(/^12 000 ₽ · 20 € · 50 \$$/);
  expect(screen.queryByTestId('qb-currencies')).toBeNull();
});

test('tile sum — больше трёх валют: плашка «разные валюты» с перечнем, суммы не склеены', async () => {
  const tile = await sumTile([
    { currency: 'RUB', sum: '12000', count: 1 },
    { currency: 'EUR', sum: '20', count: 1 },
    { currency: 'KZT', sum: '5', count: 1 },
    { currency: 'USD', sum: '50', count: 1 },
  ]);
  expect(screen.getByTestId('qb-currencies')).toHaveTextContent(
    'разные валюты: RUB, EUR, KZT, USD',
  );
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent('4 валюты');
  expect(within(tile).getByTestId('qb-tile-value')).not.toHaveTextContent('12 000');
});

test('tile sum — не денежные строки (валюта null): число без символа в той же строке', async () => {
  const tile = await sumTile([
    { currency: 'RUB', sum: '12000', count: 1 },
    { currency: null, sum: '100', count: 1 },
  ]);
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent(/^12 000 ₽ · 100$/);
});

// Порог «больше трёх» считает ВАЛЮТЫ (спека 1в §3.6): не денежная сумма валютой не является.
test('tile sum — три валюты и не денежное число: одной строкой, плашки нет', async () => {
  const tile = await sumTile([
    { currency: 'RUB', sum: '12000', count: 1 },
    { currency: 'EUR', sum: '20', count: 1 },
    { currency: 'USD', sum: '50', count: 1 },
    { currency: null, sum: '100', count: 1 },
  ]);
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent(
    /^12 000 ₽ · 20 € · 50 \$ · 100$/,
  );
  expect(screen.queryByTestId('qb-currencies')).toBeNull();
});

test('tile sum — четыре валюты и не денежное число: «4 валюты · 100», в плашке только валюты', async () => {
  const tile = await sumTile([
    { currency: 'RUB', sum: '12000', count: 1 },
    { currency: 'EUR', sum: '20', count: 1 },
    { currency: 'KZT', sum: '5', count: 1 },
    { currency: 'USD', sum: '50', count: 1 },
    { currency: null, sum: '100', count: 1 },
  ]);
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent(/^4 валюты · 100$/);
  expect(screen.getByTestId('qb-currencies')).toHaveTextContent(
    /^разные валюты: RUB, EUR, KZT, USD$/,
  );
});

test('tile sum — пустая выборка: «0»', async () => {
  const tile = await sumTile([]);
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent(/^0$/);
});

test('tile latest — значение (не денежное — без символа)', async () => {
  const text =
    'aspect=orbis/financial, display=tile, aggregate=latest:orbis/amount, title=Последняя';
  renderWithProviders(
    <DataBlock text={text} />,
    handler({ [text]: { ok: true, kind: 'latest', value: '72.5', currency: null } }),
  );
  const tile = await screen.findByTestId('qb-tile');
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent(/^72.5$/);
});

test('tile latest денежное — с символом валюты (спека 1в §3.7)', async () => {
  const text =
    'aspect=orbis/financial, display=tile, aggregate=latest:orbis/amount, sortBy=orbis/occurred_on:desc';
  renderWithProviders(
    <DataBlock text={text} />,
    handler({ [text]: { ok: true, kind: 'latest', value: '12000', currency: 'RUB' } }),
  );
  const tile = await screen.findByTestId('qb-tile');
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent(/^12 000 ₽$/);
});

// Обходчик `web-tile-form` (спека 1в, рулинг R-4): `latest` над адресом контракта — значение без
// поиска свойства по строке-ключу; плитка рисуется, а не падает. Денежное — с валютой провода.
test('tile latest по адресу слота — значение, без падения; валюта — с провода', async () => {
  const text =
    'aspect=orbis/financial, display=tile, aggregate=latest:orbis/money-movement.amount, title=Последняя';
  renderWithProviders(
    <DataBlock text={text} />,
    handler({ [text]: { ok: true, kind: 'latest', value: '72.5', currency: 'USD' } }),
  );
  const tile = await screen.findByTestId('qb-tile');
  expect(within(tile).getByTestId('qb-tile-value')).toHaveTextContent(/^72.5 \$$/);
});

test('«ещё 2» раскрывается на месте — второй вызов пачкой из одного с бо́льшим limit', async () => {
  const text = 'aspect=orbis/task, limit=3';
  const rows = ['р1', 'р2', 'р3', 'р4', 'р5'].map((id) => task(id));
  const { calls } = renderWithProviders(
    <DataBlock text={text} />,
    handler({
      [text]: (b) =>
        b.limit === undefined
          ? { ok: true, kind: 'rows', rows: rows.slice(0, 3) as never, more: 2, closedIds: [] }
          : {
              ok: true,
              kind: 'rows',
              rows: rows.slice(0, b.limit) as never,
              more: 0,
              closedIds: [],
            },
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

test('раскрытое «ещё N» не переживает смену записи `this` (C1-M2): соседняя запись — свёрнутой', async () => {
  const text = 'aspect=orbis/task, limit=3';
  const rows = ['р1', 'р2', 'р3', 'р4', 'р5'].map((id) => task(id));
  const A = '00000000-0000-4000-8000-00000000a001';
  const B = '00000000-0000-4000-8000-00000000b002';
  // Экран записи монтируется без key: переход на соседнюю запись с тем же шаблоном меняет только
  // `this` у того же блока.
  function Screen() {
    const [id, setId] = useState(A);
    return (
      <>
        <button type="button" onClick={() => setId(B)}>
          соседняя
        </button>
        <ThisEntityProvider id={id}>
          <DataBlock text={text} />
        </ThisEntityProvider>
      </>
    );
  }
  renderWithProviders(
    <Screen />,
    handler({
      [text]: (b) =>
        b.limit === undefined
          ? { ok: true, kind: 'rows', rows: rows.slice(0, 3) as never, more: 2, closedIds: [] }
          : {
              ok: true,
              kind: 'rows',
              rows: rows.slice(0, b.limit) as never,
              more: 0,
              closedIds: [],
            },
    }),
  );
  await waitFor(() => expect(screen.getAllByTestId('qb-item')).toHaveLength(3));
  fireEvent.click(screen.getByRole('button', { name: 'ещё 2' }));
  await waitFor(() => expect(screen.getAllByTestId('qb-item')).toHaveLength(5));
  fireEvent.click(screen.getByRole('button', { name: 'соседняя' }));
  expect(await screen.findByRole('button', { name: 'ещё 2' })).toBeInTheDocument();
  expect(screen.getAllByTestId('qb-item')).toHaveLength(3);
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

test('бейджи разделов (badgeOf) — одной пачкой entity.blocks, без entity.count (срез 1б §9.3, РП-8)', async () => {
  const pages = ['901', '902', '903'].map((n) => `00000000-0000-4000-8000-000000000${n}`);
  function Badge({ id }: { id: string }) {
    const { badge } = useBadgeData(id);
    return <span data-testid={`badge-${id}`}>{badge ?? '—'}</span>;
  }
  const counts = [150, 0, 7];
  const { calls } = renderWithProviders(
    pages.map((id) => <Badge key={id} id={id} />),
    (path, input) => {
      if (path === 'entity.blocks') {
        const items = (input as { blocks: { key: string; badgeOf: string }[] }).blocks;
        return {
          results: Object.fromEntries(
            items.map((b): [string, BlockResult] => [
              b.key,
              { ok: true, kind: 'count', count: counts[pages.indexOf(b.badgeOf)] ?? 0 },
            ]),
          ),
          today: BLOCKS_TODAY,
          timeZone: BLOCKS_TIME_ZONE,
        } satisfies EntityBlocksResult;
      }
      return registryReply(path) ?? {};
    },
  );
  await waitFor(() => expect(screen.getByTestId(`badge-${pages[0]}`)).toHaveTextContent('99+'));
  // Ноль — не бейдж.
  expect(screen.getByTestId(`badge-${pages[1]}`)).toHaveTextContent('—');
  expect(screen.getByTestId(`badge-${pages[2]}`)).toHaveTextContent('7');
  const sent = batches(calls);
  expect(sent).toHaveLength(1);
  expect(
    (sent[0]?.input as { blocks: { badgeOf: string }[] }).blocks.map((b) => b.badgeOf),
  ).toEqual(pages);
  expect(calls.some((c) => c.path === 'entity.count')).toBe(false);
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
    handler({ [text]: { ok: true, kind: 'rows', rows: rows as never, more: 3, closedIds: [] } }),
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

test('реестр не загрузился — плашка с причиной, а не вечная «Загрузка…» (C1-I3, §6.5)', async () => {
  const { calls } = renderWithProviders(
    <DataBlock text="aspect=orbis/task" onConfigure={() => {}} />,
    (path) => {
      if (path === 'registry.effective') throw trpcError('INTERNAL_SERVER_ERROR');
      return {};
    },
  );
  const plaque = await screen.findByTestId('qb-error');
  expect(plaque).toHaveTextContent(REGISTRY_FAILED_MESSAGE);
  // Кнопка «Настроить» у плашки остаётся — блок можно поправить и без данных.
  expect(within(plaque).getByTestId('qb-configure')).toBeInTheDocument();
  expect(screen.queryByText('Загрузка…')).toBeNull();
  expect(calls.filter((c) => c.path === 'entity.blocks')).toEqual([]);
});
