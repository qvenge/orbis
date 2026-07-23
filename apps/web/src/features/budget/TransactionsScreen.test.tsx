// Task B5: экран «Транзакции» (03-budget §3.3) — финансовые фильтры (месяц ◀▶,
// категория, направление, planned, диапазон сумм, поиск → buildTxQuery), компактная
// строка (🔁 МЕЖДУ title и суммой, бейдж категории в крайней правой колонке — §3.3
// «визуально различимы»), рекатегоризация (Sheet → entity.update category_ref) и
// «Сделать повторяющейся» (БЕЗ мутации: переход на detail + подсказка — решение
// контролёра B5: инвариант 01-arch §3.3 главнее буквы §3.3, см. комментарий экрана).
// Свайпы — прогрессивное улучшение поверх кнопок-действий (тач-эмуляция в jsdom
// ненадёжна — кнопки первичны).
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { App } from '../../App';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders } from '../../test/harness';
import { useToastStore } from '../../ui/toast-store';
import { TransactionsScreen } from './TransactionsScreen';
import { buildTxQuery } from './txQuery';

// --- фикстуры -------------------------------------------------------------------------

const ent = (id: string, title: string, aspects: Record<string, unknown> = {}) => ({
  id,
  ownerId: 'u',
  title,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects,
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

const categories = [
  ent('cat-1', 'Еда', { 'orbis/category': { icon: '🍔' } }),
  ent('cat-2', 'Транспорт', { 'orbis/category': { icon: '🚕', color: '#8b5cf6' } }),
];

const transactions = [
  ent('t1', 'Перекрёсток', {
    'orbis/financial': {
      amount: '2340.00',
      direction: 'expense',
      occurred_on: '2026-07-13',
      category_ref: 'cat-1',
    },
  }),
  ent('t2', 'Netflix', {
    'orbis/financial': {
      amount: '599.00',
      direction: 'expense',
      occurred_on: '2026-07-12',
      category_ref: 'cat-2',
      recurring: true,
    },
  }),
  ent('t3', 'Зарплата', {
    'orbis/financial': {
      amount: '165000.00',
      direction: 'income',
      occurred_on: '2026-07-10',
      category_ref: 'cat-1',
    },
  }),
];

const settings = {
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 1,
  installedViews: ['orbis-budget'],
  pinnedEntities: [],
};

/** Текущий месяц в таймзоне настроек — дефолт фильтра периода (как Overview). */
const MONTH = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
}).format(new Date());

const handler =
  (over: { transactions?: ReturnType<typeof ent>[] } = {}): MockHandler =>
  (path, input) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.query') {
      const q = (input as { query: string }).query;
      if (q.includes('orbis/category')) return categories;
      return over.transactions ?? transactions;
    }
    if (path === 'entity.update') {
      const upd = input as { id: string };
      const found = transactions.find((t) => t.id === upd.id);
      return { ...(found ?? ent(upd.id, 'x')), actionId: 'act-upd' };
    }
    if (path === 'budget.postDue') return { posted: 0 };
    if (path === 'budget.overview') {
      // Минимальный Overview — для интеграционного теста входа с корня вкладки
      return {
        balance: { income: '0.00', expense: '0.00', balance: '0.00' },
        envelopes: [],
        comingUp: [],
        planned: [],
        unbudgeted: [],
      };
    }
    return {};
  };

beforeEach(() => {
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  useNav.setState({
    activeTab: 'budget',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

const txQueryCalls = (calls: { path: string; input: unknown }[]) =>
  calls
    .filter((c) => c.path === 'entity.query')
    .map((c) => (c.input as { query: string }).query)
    .filter((q) => !q.includes('orbis/category'));

// --- запрос и строки -------------------------------------------------------------------

test('запрос текущего месяца строится buildTxQuery; строки: дата, title, сумма со знаком', async () => {
  const { calls } = renderWithProviders(<TransactionsScreen />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(3));

  expect(txQueryCalls(calls)).toContain(buildTxQuery({ month: MONTH }));

  const rows = screen.getAllByTestId('tx-row');
  expect(rows[0]).toHaveTextContent('Перекрёсток');
  expect(rows[0]).toHaveTextContent('13.07');
  expect(rows[0]).toHaveTextContent('−2 340'); // расход — минус (formatMoney)
  expect(rows[2]).toHaveTextContent('+165 000'); // доход — плюс
});

test('строка §3.3: 🔁 МЕЖДУ title и суммой, бейдж категории — крайняя правая колонка, раздельны', async () => {
  renderWithProviders(<TransactionsScreen />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(3));

  const netflix = screen.getAllByTestId('tx-row')[1] as HTMLElement;
  const marker = within(netflix).getByLabelText('повторяется');
  const amount = within(netflix).getByTestId('tx-amount');
  const badge = within(netflix).getByTestId('tx-category-badge');
  expect(badge).toHaveTextContent('🚕');

  // Порядок в DOM: 🔁 → сумма → бейдж (маркер и бейдж разделены суммой — «не примыкают»)
  expect(marker.compareDocumentPosition(amount) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(amount.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  // 🔁 только у recurring-строки
  expect(screen.getAllByLabelText('повторяется')).toHaveLength(1);
});

test('бейдж категории подкрашен её color (§3.3 icon/color); без color — нейтральный', async () => {
  renderWithProviders(<TransactionsScreen />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(3));

  const rows = screen.getAllByTestId('tx-row');
  // cat-2 (Транспорт, #8b5cf6) — тонирование фона цветом категории
  const colored = within(rows[1] as HTMLElement).getByTestId('tx-category-badge');
  expect(colored.getAttribute('style') ?? '').toContain('background-color');
  // cat-1 (Еда) без color — инлайн-стиля нет, нейтральный фон классом
  const neutral = within(rows[0] as HTMLElement).getByTestId('tx-category-badge');
  expect(neutral.getAttribute('style')).toBeNull();
});

test('тап по строке пушит detail сущности', async () => {
  renderWithProviders(<TransactionsScreen />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(3));
  fireEvent.click(within(screen.getAllByTestId('tx-row')[0] as HTMLElement).getByTestId('tx-main'));
  expect(useNav.getState().stacks.budget).toEqual([{ kind: 'entity', id: 't1' }]);
});

// --- фильтры ---------------------------------------------------------------------------

test('фильтры собирают строку грамматики: категория, направление, planned, суммы, поиск', async () => {
  const { calls } = renderWithProviders(<TransactionsScreen />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(3));

  fireEvent.change(screen.getByLabelText('Категория'), { target: { value: 'cat-1' } });
  await waitFor(() =>
    expect(txQueryCalls(calls)).toContain(buildTxQuery({ month: MONTH, categoryId: 'cat-1' })),
  );

  fireEvent.change(screen.getByLabelText('Направление'), { target: { value: 'expense' } });
  fireEvent.change(screen.getByLabelText('Тип'), { target: { value: 'true' } });
  await waitFor(() =>
    expect(txQueryCalls(calls)).toContain(
      buildTxQuery({ month: MONTH, categoryId: 'cat-1', direction: 'expense', planned: true }),
    ),
  );

  fireEvent.change(screen.getByLabelText('Сумма от'), { target: { value: '500' } });
  fireEvent.change(screen.getByLabelText('Сумма до'), { target: { value: '2000' } });
  fireEvent.change(screen.getByLabelText('Поиск'), { target: { value: 'кофе, круассан' } });
  await waitFor(() => {
    const expected = buildTxQuery({
      month: MONTH,
      categoryId: 'cat-1',
      direction: 'expense',
      planned: true,
      amountFrom: '500',
      amountTo: '2000',
      search: 'кофе, круассан',
    });
    expect(txQueryCalls(calls)).toContain(expected);
  });
});

test('невалидная сумма в запрос не попадает (мусор не дербанит грамматику)', async () => {
  const { calls } = renderWithProviders(<TransactionsScreen />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(3));
  fireEvent.change(screen.getByLabelText('Сумма от'), { target: { value: 'abc' } });
  fireEvent.change(screen.getByLabelText('Поиск'), { target: { value: 'x' } });
  await waitFor(() =>
    expect(txQueryCalls(calls)).toContain(buildTxQuery({ month: MONTH, search: 'x' })),
  );
  expect(txQueryCalls(calls).every((q) => !q.includes('amount'))).toBe(true);
});

test('◀▶ переключают месяц — occurred_on-диапазон сдвигается', async () => {
  const { calls } = renderWithProviders(<TransactionsScreen />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(3));
  fireEvent.click(screen.getByTestId('month-prev'));
  const [y = 0, m = 1] = MONTH.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  await waitFor(() => expect(txQueryCalls(calls)).toContain(buildTxQuery({ month: prev })));
});

// --- рекатегоризация (§3.3, §5) ---------------------------------------------------------

test('рекатегоризация: кнопка строки → Sheet категорий → entity.update с новым category_ref', async () => {
  const { calls } = renderWithProviders(<TransactionsScreen />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(3));

  const row = screen.getAllByTestId('tx-row')[0] as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Сменить категорию' }));

  // Sheet выбора: категории списком
  const sheet = await screen.findByRole('dialog');
  fireEvent.click(within(sheet).getByRole('button', { name: /Транспорт/ }));

  await waitFor(() => expect(calls.some((c) => c.path === 'entity.update')).toBe(true));
  expect(calls.find((c) => c.path === 'entity.update')?.input).toEqual({
    id: 't1',
    aspects: { 'orbis/financial': { category_ref: 'cat-2' } },
  });
  // Sheet закрыт после выбора
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('свайп влево по строке открывает Sheet рекатегоризации (прогрессивное улучшение)', async () => {
  renderWithProviders(<TransactionsScreen />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(3));

  const row = screen.getAllByTestId('tx-row')[0] as HTMLElement;
  fireEvent.touchStart(row, { changedTouches: [{ clientX: 220, clientY: 10 }] });
  fireEvent.touchEnd(row, { changedTouches: [{ clientX: 100, clientY: 12 }] });
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
});

// --- «Сделать повторяющейся» (§3.3; решение контролёра B5) -------------------------------
// entity.update {recurring:true} на обычной транзакции детерминированно отклоняется
// инвариантом 01-arch §3.3 (financial_recurring_requires_recurrence, normalize.ts):
// recurring=true валиден только на шаблоне с orbis/schedule.recurrence или инстансе
// с derived_from. Инвариант главнее буквы 03-budget §3.3 «ставит recurring=true» —
// кнопка/свайп НЕ мутируют: переход на detail + подсказка добавить Schedule.recurrence.

test('«Сделать повторяющейся»: БЕЗ entity.update — подсказка про Schedule + переход на detail', async () => {
  const { calls } = renderWithProviders(<TransactionsScreen />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(3));

  const row = screen.getAllByTestId('tx-row')[0] as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Сделать повторяющейся' }));

  // Никакой мутации: recurring=true без recurrence отклонил бы executor (инвариант §3.3)
  expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(0);
  // Подсказка «завести шаблон» показана (тост)
  expect(useToastStore.getState().toasts.some((t) => t.title.includes('Schedule'))).toBe(true);
  // Переход на detail сущности — там добавляется аспект Schedule с recurrence
  expect(useNav.getState().stacks.budget).toEqual([{ kind: 'entity', id: 't1' }]);
});

test('у recurring-строки кнопки «Сделать повторяющейся» нет (уже шаблон/инстанс)', async () => {
  renderWithProviders(<TransactionsScreen />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(3));
  const netflix = screen.getAllByTestId('tx-row')[1] as HTMLElement;
  expect(within(netflix).queryByRole('button', { name: 'Сделать повторяющейся' })).toBeNull();
  expect(within(netflix).getByRole('button', { name: 'Сменить категорию' })).toBeInTheDocument();
});

// --- вход и роутер -----------------------------------------------------------------------

test('вход §3.3: кнопка «Транзакции» в шапке Overview пушит budget-transactions; роутер рендерит экран', async () => {
  renderWithProviders(<App />, handler());
  await waitFor(() => expect(screen.getByTestId('balance-card')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Транзакции' }));
  expect(useNav.getState().stacks.budget).toEqual([{ kind: 'budget-transactions' }]);

  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(3));
  fireEvent.click(screen.getByTestId('nav-back'));
  expect(useNav.getState().stacks.budget).toEqual([]);
});
