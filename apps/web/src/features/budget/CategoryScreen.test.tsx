// Task B3: экран категории (03-budget §3.2) — развёрнутая карточка текущего конверта
// (формулы §2.4, фазы §2.9), «Правила» = body категории, [Тред] → тред категории,
// мини-тренд по budget.categoryTrend (простые div-бары + штрих лимита), транзакции
// конверта (children_of, NativeRow §3.6, 🔁 у recurring-инстансов), заглушка quick-add (B4).
import type { CategoryTrendPoint, EnvelopeStatus } from '@orbis/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { App } from '../../App';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders } from '../../test/harness';
import { CategoryScreen } from './CategoryScreen';

// --- фикстуры -------------------------------------------------------------------------

const ent = (id: string, title: string, aspects: Record<string, unknown> = {}, body = '') => ({
  id,
  ownerId: 'u',
  title,
  emoji: null,
  body,
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects,
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

const category = ent(
  'cat-1',
  'Еда',
  { 'orbis/category': { icon: '🍔' } },
  'Бизнес-ланчи — сюда, не в Развлечения',
);

// 21 600 / 30 000 = 72% → warn; limit 28 800 + carryover 1 200 = effectiveLimit 30 000 (§2.4)
const envelopeStatus: EnvelopeStatus = {
  envelope: ent('env-1', 'Конверт «Еда» 2026-07', {
    'orbis/budget': {
      category_ref: 'cat-1',
      limit: '28800.00',
      currency: 'RUB',
      period_start: '2026-07-01',
      period_end: '2026-07-31',
      carryover: '1200.00',
    },
  }),
  category: { id: 'cat-1', title: 'Еда', icon: '🍔', color: null },
  spent: '21600.00',
  effectiveLimit: '30000.00',
  remaining: '8400.00',
  dailyPace: '600.00',
  phase: 'active',
} as EnvelopeStatus;

const trend: CategoryTrendPoint[] = [
  { period: '2026-02', spent: '12000.00', limit: '30000.00' },
  { period: '2026-05', spent: '15000.00', limit: null },
  { period: '2026-07', spent: '21600.00', limit: '30000.00' },
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
  ent('t2', 'Пятёрочка', {
    'orbis/financial': {
      amount: '1890.00',
      direction: 'expense',
      occurred_on: '2026-07-11',
      category_ref: 'cat-1',
      recurring: true,
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

const handler =
  (
    over: { envelope?: EnvelopeStatus | null; body?: string; trend?: CategoryTrendPoint[] } = {},
  ): MockHandler =>
  (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.get')
      return {
        entity: over.body === undefined ? category : { ...category, body: over.body },
        thread: { threadId: 'thr-cat', messages: [] },
      };
    if (path === 'budget.envelopeForCategory')
      return over.envelope === undefined ? envelopeStatus : over.envelope;
    if (path === 'budget.categoryTrend') return over.trend ?? trend;
    if (path === 'entity.query') return transactions;
    return {};
  };

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'budget',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

// --- карточка текущего конверта (развёрнутый вид, §3.2 / §2.4) --------------------------

test('шапка: иконка+имя категории; карточка конверта: spent/limit, %, Лимит, carryover, Доступно, темп', async () => {
  renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler());
  await waitFor(() => expect(screen.getByRole('heading', { name: /🍔 Еда/ })).toBeInTheDocument());

  // Подзаголовок периода: конверт на полный календарный месяц → «Июль 2026»
  expect(screen.getByText('Июль 2026')).toBeInTheDocument();

  const card = await screen.findByTestId('category-envelope');
  expect(card).toHaveAttribute('data-level', 'warn'); // 72% → warn (пороги §3.1, без дублирования)
  expect(card).toHaveTextContent('21 600 / 30 000 ₽');
  expect(card).toHaveTextContent('72%');
  expect(card).toHaveTextContent('Лимит 28 800');
  expect(card).toHaveTextContent('↩ +1 200'); // carryover (§2.6)
  expect(card).toHaveTextContent('Доступно 8 400 ₽');
  expect(card).toHaveTextContent('~600 ₽/день');
});

test('envelopeForCategory запрашивается с categoryId и датой YYYY-MM-DD (таймзона пользователя)', async () => {
  const { calls } = renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler());
  await waitFor(() => expect(screen.getByTestId('category-envelope')).toBeInTheDocument());
  const call = calls.find((c) => c.path === 'budget.envelopeForCategory');
  expect(call).toBeDefined();
  const input = call?.input as { categoryId: string; date: string };
  expect(input.categoryId).toBe('cat-1');
  expect(input.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('нет конверта на текущий период: сообщение вместо карточки, транзакции не запрашиваются', async () => {
  const { calls } = renderWithProviders(
    <CategoryScreen categoryId="cat-1" />,
    handler({ envelope: null }),
  );
  await waitFor(() => expect(screen.getByTestId('no-envelope')).toBeInTheDocument());
  expect(screen.queryByTestId('category-envelope')).toBeNull();
  // Список транзакций — дети конверта; без конверта запрос не имеет смысла
  expect(calls.filter((c) => c.path === 'entity.query')).toHaveLength(0);
});

// --- Правила (body категории) и [Тред] ---------------------------------------------------

test('секция «Правила» показывает body категории; при пустом body скрыта', async () => {
  const { unmount } = renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler());
  await waitFor(() =>
    expect(screen.getByText('Бизнес-ланчи — сюда, не в Развлечения')).toBeInTheDocument(),
  );
  expect(screen.getByText('Правила')).toBeInTheDocument();
  unmount();

  renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler({ body: '' }));
  await waitFor(() => expect(screen.getByTestId('category-envelope')).toBeInTheDocument());
  expect(screen.queryByText('Правила')).toBeNull();
});

test('[Тред] пушит тред категории (детерминированный threadId из entity.get)', async () => {
  renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Тред' })).toBeEnabled());

  fireEvent.click(screen.getByRole('button', { name: 'Тред' }));
  expect(useNav.getState().stacks.budget).toEqual([{ kind: 'thread', threadId: 'thr-cat' }]);
});

// --- мини-тренд (§3.2): простые div-бары, штрих лимита ------------------------------------

test('тренд: бар на месяц с шириной от максимума, штрих лимита только при limit≠null', async () => {
  renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler());
  await waitFor(() => expect(screen.getAllByTestId('trend-row')).toHaveLength(3));

  const rows = screen.getAllByTestId('trend-row');
  expect(rows[0]).toHaveTextContent('фев');
  expect(rows[1]).toHaveTextContent('май');
  expect(rows[2]).toHaveTextContent('июл');
  expect(rows[2]).toHaveTextContent('21 600');

  // Максимум шкалы 30 000 → 40% / 50% / 72% (точная BigInt-арифметика, без IEEE-754)
  const bars = screen.getAllByTestId('trend-bar');
  expect(bars.map((b) => b.style.width)).toEqual(['40%', '50%', '72%']);

  // Штрих-линия лимита: у 2026-05 конверта не было (limit=null) — штриха нет
  expect(screen.getAllByTestId('trend-limit')).toHaveLength(2);
});

test('пустой тренд: секция скрыта', async () => {
  renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler({ trend: [] }));
  await waitFor(() => expect(screen.getByTestId('category-envelope')).toBeInTheDocument());
  expect(screen.queryByTestId('trend-row')).toBeNull();
  expect(screen.queryByText(/Тренд/)).toBeNull();
});

// --- транзакции конверта (§3.2): children_of, NativeRow, 🔁, тап → detail ------------------

test('транзакции: entity.query по детям конверта, NativeRow-рендер, 🔁 только у recurring', async () => {
  const { calls } = renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(2));

  const q = calls.find((c) => c.path === 'entity.query');
  expect(q?.input).toEqual({
    query: 'children_of=env-1, aspect=orbis/financial, sortBy=occurred_on:desc',
  });

  const rows = screen.getAllByTestId('tx-row');
  expect(rows[0]).toHaveTextContent('Перекрёсток');
  expect(rows[0]).toHaveTextContent('−2 340'); // native-рендер §3.6: сумма со знаком
  expect(rows[0]).toHaveTextContent('13.07');
  expect(rows[1]).toHaveTextContent('Пятёрочка');

  // 🔁 — только у recurring-инстанса (aspects['orbis/financial'].recurring === true)
  expect(screen.getAllByLabelText('повторяется')).toHaveLength(1);
  expect(rows[1]?.contains(screen.getByLabelText('повторяется'))).toBe(true);
});

test('тап по транзакции пушит detail-экран сущности', async () => {
  renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(2));

  const firstRow = screen.getAllByTestId('tx-row')[0];
  if (!firstRow) throw new Error('нет строки транзакции');
  fireEvent.click(firstRow);
  expect(useNav.getState().stacks.budget).toEqual([{ kind: 'entity', id: 't1' }]);
});

// --- заглушка quick-add (B4) ---------------------------------------------------------------

test('[+ запись в эту категорию] присутствует, но отключена до QuickAddBar (B4)', async () => {
  renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler());
  await waitFor(() => expect(screen.getByTestId('category-envelope')).toBeInTheDocument());
  const btn = screen.getByRole('button', { name: '+ запись в эту категорию' });
  expect(btn).toBeDisabled();
});

// --- интеграция с router: budget-category в стеке рендерит CategoryScreen -------------------

test('ScreenRef budget-category рендерит CategoryScreen вместо заглушки; «Назад» возвращает', async () => {
  useNav.setState({
    activeTab: 'budget',
    stacks: {
      chat: [],
      browser: [],
      agenda: [],
      budget: [{ kind: 'budget-category', id: 'cat-1' }],
    },
  });
  renderWithProviders(<App />, handler());

  await waitFor(() => expect(screen.getByRole('heading', { name: /🍔 Еда/ })).toBeInTheDocument());
  expect(screen.queryByText(/Task B3/)).toBeNull(); // заглушки больше нет

  fireEvent.click(screen.getByTestId('nav-back'));
  expect(useNav.getState().stacks.budget).toEqual([]);
});
