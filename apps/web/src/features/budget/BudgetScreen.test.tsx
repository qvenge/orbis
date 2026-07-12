import type { BudgetOverview } from '@orbis/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { App } from '../../App';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders } from '../../test/harness';
import { BudgetScreen } from './BudgetScreen';
import { monthShift } from './useBudget';

const ent = (id: string, title: string) => ({
  id,
  ownerId: 'u',
  title,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: {},
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

const envelope = (
  id: string,
  title: string,
  spent: string,
  limit: string,
): BudgetOverview['envelopes'][number] => ({
  envelope: ent(id, title),
  category: { id: `cat-${id}`, title, icon: null, color: null },
  spent,
  effectiveLimit: limit,
  remaining: '0',
  dailyPace: null,
  phase: 'active',
});

const fullOverview: BudgetOverview = {
  period: { start: '2026-07-01', end: '2026-07-31' },
  balance: { income: '165000.00', expense: '152600.00', balance: '12400.00' },
  envelopes: [
    envelope('env1', 'Еда', '7200.00', '10000.00'),
    envelope('env2', 'Транспорт', '9100.00', '10000.00'),
  ],
  comingUp: [
    {
      entity: ent('r1', 'Netflix'),
      occurredOn: '2026-07-16',
      amount: '599.00',
      direction: 'expense',
    },
  ],
  planned: [{ entity: ent('p1', 'Кроссовки'), amount: '8000.00', categoryTitle: 'Одежда' }],
  unbudgeted: [{ category: { id: 'c9', title: 'Образование', icon: null }, total: '3200.00' }],
  alertCount: 1,
};

const emptyOverview: BudgetOverview = {
  ...fullOverview,
  envelopes: [],
  comingUp: [],
  planned: [],
  unbudgeted: [],
  alertCount: 0,
};

const settings = (views: string[]) => ({
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 1,
  installedViews: views,
  pinnedEntities: [],
});

const budgetHandler =
  (overview: BudgetOverview, views: string[] = ['orbis-budget']): MockHandler =>
  (path) => {
    if (path === 'user.getSettings') return settings(views);
    if (path === 'budget.overview') return overview;
    if (path === 'budget.postDue') return { posted: 0 };
    return {};
  };

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

// --- monthShift: чистая арифметика 'YYYY-MM' без Date --------------------------------

test('monthShift: сдвиг внутри года и через границы года', () => {
  expect(monthShift('2026-06', 1)).toBe('2026-07');
  expect(monthShift('2026-06', -1)).toBe('2026-05');
  expect(monthShift('2026-12', 1)).toBe('2027-01');
  expect(monthShift('2026-01', -1)).toBe('2025-12');
});

// --- Каркас Overview §3.1 -------------------------------------------------------------

test('Overview: баланс, две карточки конвертов, Coming up/Planned/Unbudgeted, [+ конверт]', async () => {
  renderWithProviders(<BudgetScreen />, budgetHandler(fullOverview));

  // Карточка баланса (§2.5): balance со знаком, доход/расход
  await waitFor(() => expect(screen.getByTestId('balance-card')).toBeInTheDocument());
  expect(screen.getByTestId('balance-card')).toHaveTextContent('+12 400');
  expect(screen.getByTestId('balance-card')).toHaveTextContent('Доход 165 000');
  expect(screen.getByTestId('balance-card')).toHaveTextContent('Расход 152 600');

  // Сетка конвертов: заглушка-карточка = имя + spent/limit
  const cards = screen.getAllByTestId('envelope-card');
  expect(cards).toHaveLength(2);
  expect(cards[0]).toHaveTextContent('Еда');
  expect(cards[0]).toHaveTextContent('7 200 / 10 000');
  expect(cards[1]).toHaveTextContent('Транспорт');

  // Кнопка-заглушка создания конверта (Sheet — B2)
  expect(screen.getByRole('button', { name: /\+ конверт/i })).toBeInTheDocument();

  // Секции прогноза и Unbudgeted
  expect(screen.getByText(/Coming up/)).toBeInTheDocument();
  expect(screen.getByText('Netflix')).toBeInTheDocument();
  expect(screen.getByText(/Planned/)).toBeInTheDocument();
  expect(screen.getByText('Кроссовки')).toBeInTheDocument();
  expect(screen.getByText(/Одежда/)).toBeInTheDocument();
  expect(screen.getByText(/Unbudgeted/)).toBeInTheDocument();
  expect(screen.getByText('Образование')).toBeInTheDocument();
});

test('Overview: пустые секции скрываются (конверты/Coming up/Planned/Unbudgeted)', async () => {
  renderWithProviders(<BudgetScreen />, budgetHandler(emptyOverview));
  await waitFor(() => expect(screen.getByTestId('balance-card')).toBeInTheDocument());

  expect(screen.queryAllByTestId('envelope-card')).toHaveLength(0);
  expect(screen.queryByText(/Coming up/)).toBeNull();
  expect(screen.queryByText(/Planned/)).toBeNull();
  expect(screen.queryByText(/Unbudgeted/)).toBeNull();
  // [+ конверт] остаётся — точка входа создания первого конверта
  expect(screen.getByRole('button', { name: /\+ конверт/i })).toBeInTheDocument();
});

test('Overview: Skeleton, пока budget.overview грузится', async () => {
  renderWithProviders(<BudgetScreen />, (path) => {
    if (path === 'user.getSettings') return settings(['orbis-budget']);
    if (path === 'budget.overview') return new Promise(() => {}); // вечный pending
    if (path === 'budget.postDue') return { posted: 0 };
    return {};
  });
  await waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0));
  expect(screen.queryByTestId('balance-card')).toBeNull();
});

test('postDue вызывается один раз на mount', async () => {
  const { calls } = renderWithProviders(<BudgetScreen />, budgetHandler(fullOverview));
  await waitFor(() => expect(screen.getByTestId('balance-card')).toBeInTheDocument());
  expect(calls.filter((c) => c.path === 'budget.postDue')).toHaveLength(1);
});

test('переключатель месяца меняет аргумент budget.overview (◀ и ▶)', async () => {
  const { calls } = renderWithProviders(<BudgetScreen />, budgetHandler(fullOverview));
  await waitFor(() => expect(screen.getByTestId('balance-card')).toBeInTheDocument());

  const overviewCalls = () =>
    calls
      .filter((c) => c.path === 'budget.overview')
      .map((c) => (c.input as { month: string }).month);
  const base = overviewCalls().at(-1);
  if (!base) throw new Error('нет вызова budget.overview');
  expect(base).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/); // дефолт — текущий месяц

  fireEvent.click(screen.getByRole('button', { name: 'Следующий месяц' }));
  await waitFor(() => expect(overviewCalls()).toContain(monthShift(base, 1)));

  fireEvent.click(screen.getByRole('button', { name: 'Предыдущий месяц' }));
  fireEvent.click(screen.getByRole('button', { name: 'Предыдущий месяц' }));
  await waitFor(() => expect(overviewCalls()).toContain(monthShift(base, -1)));
});

// --- Гейт вкладки по installedViews ---------------------------------------------------

test('вкладка budget видна в TabBar при installedViews с orbis-budget и открывает BudgetScreen', async () => {
  renderWithProviders(<App />, budgetHandler(fullOverview, ['orbis-budget']));
  await waitFor(() => expect(screen.getByTestId('tab-budget')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('tab-budget'));
  await waitFor(() => expect(screen.getByText(/^Бюджет · /)).toBeInTheDocument());
});

test('без orbis-budget в installedViews вкладки budget нет', async () => {
  renderWithProviders(<App />, budgetHandler(fullOverview, []));
  // дождаться загрузки настроек, затем убедиться, что вкладка не появилась
  await waitFor(() =>
    expect(
      screen.queryByTestId('tab-budget') ?? screen.getByTestId('tab-chat'),
    ).toBeInTheDocument(),
  );
  expect(screen.queryByTestId('tab-budget')).toBeNull();
});
