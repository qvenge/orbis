// Task B6: Rollover-экран (03-budget §3.5, §2.6) — превью-таблица факт/carryover/лимит
// по категориям прошлого месяца, редактируемый лимит, обнуление переносов (целиком и
// покатегорийно тапом), [Создать N конв.] → budget.rollover одним batch с client-batchId
// (UUIDv7 ОДИН на открытие экрана: повтор после ошибки шлёт тот же id; CONFLICT —
// честная ошибка + новый id, уроки B4), needsSetup-форма первого месяца (§5 edge case:
// доход + оценки по категориям → те же rows).
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders, trpcError } from '../../test/harness';
import { RolloverScreen } from './RolloverScreen';

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
  ent('cat-2', 'Транспорт', { 'orbis/category': { icon: '🚕' } }),
  ent('cat-3', 'Жильё', { 'orbis/category': {} }),
];

const settings = {
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 1,
  installedViews: ['orbis-budget'],
  pinnedEntities: [],
};

/** Текущий месяц в таймзоне настроек — целевой месяц rollover (§3.5). */
const MONTH = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
}).format(new Date());

const previewRows = [
  {
    categoryId: 'cat-1',
    categoryTitle: 'Еда',
    categoryIcon: '🍔',
    prevSpent: '28800.00',
    carryover: '1200.00',
    suggestedLimit: '30000.00',
  },
  {
    categoryId: 'cat-2',
    categoryTitle: 'Транспорт',
    categoryIcon: '🚕',
    prevSpent: '10100.00',
    carryover: '-1100.00',
    suggestedLimit: '9000.00',
  },
];

const fullPreview = { month: MONTH, rows: previewRows, needsSetup: false };
const setupPreview = { month: MONTH, rows: [], needsSetup: true };
const emptyPreview = { month: MONTH, rows: [], needsSetup: false };

type RolloverBehavior = (input: unknown) => unknown;
const okRollover: RolloverBehavior = () => ({
  actionId: 'act-ro',
  envelopeIds: ['env-a', 'env-b'],
  idempotentReplay: false,
});

const handler =
  (over: { preview?: unknown; rollover?: RolloverBehavior } = {}): MockHandler =>
  (path, input) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'budget.rolloverPreview') return over.preview ?? fullPreview;
    if (path === 'budget.rollover') return (over.rollover ?? okRollover)(input);
    if (path === 'entity.query') {
      const q = (input as { query: string }).query;
      if (q.includes('orbis/category')) return categories;
      return [];
    }
    return {};
  };

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'budget',
    stacks: { chat: [], browser: [], agenda: [], budget: [{ kind: 'budget-rollover' }] },
  });
});

const rolloverCalls = (calls: { path: string; input: unknown }[]) =>
  calls
    .filter((c) => c.path === 'budget.rollover')
    .map(
      (c) =>
        c.input as {
          month: string;
          rows: { categoryId: string; limit: string; carryover: string }[];
          batchId: string;
        },
    );

async function renderReady(over: Parameters<typeof handler>[0] = {}) {
  const r = renderWithProviders(<RolloverScreen />, handler(over));
  await waitFor(() => expect(screen.getAllByTestId('rollover-row').length).toBeGreaterThan(0));
  return r;
}

// --- превью-таблица (§3.5) -------------------------------------------------------------

test('превью: строки категорий с фактом/carryover, лимит — редактируемое поле, кнопка [Создать 2 конв.]', async () => {
  const { calls } = await renderReady();

  // Запрос превью — целевой (текущий) месяц
  expect(calls.find((c) => c.path === 'budget.rolloverPreview')?.input).toEqual({ month: MONTH });

  const rows = screen.getAllByTestId('rollover-row');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('Еда');
  expect(rows[0]).toHaveTextContent('28 800'); // факт прошлого месяца
  expect(rows[0]).toHaveTextContent('+1 200'); // carryover с знаком
  expect(rows[1]).toHaveTextContent('Транспорт');
  expect(rows[1]).toHaveTextContent('10 100');
  expect(rows[1]).toHaveTextContent('−1 100'); // отрицательный перенос (§2.6)

  // Лимит — редактируемое поле с предложением AI
  expect(screen.getByLabelText('Лимит «Еда»')).toHaveValue('30000.00');
  expect(screen.getByLabelText('Лимит «Транспорт»')).toHaveValue('9000.00');

  expect(screen.getByRole('button', { name: 'Создать 2 конв.' })).toBeEnabled();
});

test('правка лимита уходит в мутацию; месяц и untouched-строки — как в превью', async () => {
  const { calls } = await renderReady();

  fireEvent.change(screen.getByLabelText('Лимит «Еда»'), { target: { value: '35000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Создать 2 конв.' }));

  await waitFor(() => expect(rolloverCalls(calls)).toHaveLength(1));
  const call = rolloverCalls(calls)[0];
  expect(call?.month).toBe(MONTH);
  expect(call?.rows).toEqual([
    { categoryId: 'cat-1', limit: '35000.00', carryover: '1200.00' },
    { categoryId: 'cat-2', limit: '9000.00', carryover: '-1100.00' },
  ]);
});

test('невалидный лимит блокирует сабмит; запятая нормализуется в точку', async () => {
  const { calls } = await renderReady();
  const submit = screen.getByRole('button', { name: 'Создать 2 конв.' });

  fireEvent.change(screen.getByLabelText('Лимит «Еда»'), { target: { value: '12..3' } });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Лимит «Еда»'), { target: { value: '30500,5' } });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await waitFor(() => expect(rolloverCalls(calls)).toHaveLength(1));
  expect(rolloverCalls(calls)[0]?.rows[0]?.limit).toBe('30500.50');
});

// --- обнуление переносов (§3.5) --------------------------------------------------------

test('[Обнулить переносы] шлёт все carryover "0.00"', async () => {
  const { calls } = await renderReady();

  fireEvent.click(screen.getByRole('button', { name: 'Обнулить переносы' }));
  fireEvent.click(screen.getByRole('button', { name: 'Создать 2 конв.' }));

  await waitFor(() => expect(rolloverCalls(calls)).toHaveLength(1));
  expect(rolloverCalls(calls)[0]?.rows.map((r) => r.carryover)).toEqual(['0.00', '0.00']);
});

test('покатегорийно: тап по значению carryover обнуляет его, повторный тап возвращает', async () => {
  const { calls } = await renderReady();

  const toggle = screen.getByRole('button', { name: 'Обнулить перенос «Еда»' });
  fireEvent.click(toggle);
  expect(toggle).toHaveTextContent('0'); // визуально обнулён

  // Повторный тап возвращает исходный перенос
  fireEvent.click(toggle);
  expect(toggle).toHaveTextContent('+1 200');

  // Обнуляем только «Еда» и подтверждаем
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: 'Создать 2 конв.' }));
  await waitFor(() => expect(rolloverCalls(calls)).toHaveLength(1));
  expect(rolloverCalls(calls)[0]?.rows.map((r) => r.carryover)).toEqual(['0.00', '-1100.00']);
});

// --- batchId-жизненный-цикл (уроки B4) -------------------------------------------------

test('повторный сабмит после ошибки шлёт ТОТ ЖЕ batchId; экран не закрывается', async () => {
  let failures = 1;
  const { calls } = await renderReady({
    rollover: (input) => {
      if (failures > 0) {
        failures -= 1;
        throw trpcError('INTERNAL_SERVER_ERROR');
      }
      return okRollover(input);
    },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Создать 2 конв.' }));
  await waitFor(() => expect(screen.getByTestId('rollover-error')).toBeInTheDocument());
  expect(useNav.getState().stacks.budget).toHaveLength(1); // ошибка ≠ успех — экран на месте

  fireEvent.click(screen.getByRole('button', { name: 'Создать 2 конв.' }));
  await waitFor(() => expect(rolloverCalls(calls)).toHaveLength(2));
  const [first, second] = rolloverCalls(calls);
  expect(second?.batchId).toBe(first?.batchId);
});

test('CONFLICT — честная ошибка (НЕ успех): экран не закрывается, следующий сабмит с НОВЫМ batchId', async () => {
  let conflicts = 1;
  const { calls } = await renderReady({
    rollover: (input) => {
      if (conflicts > 0) {
        conflicts -= 1;
        throw trpcError('CONFLICT');
      }
      return okRollover(input);
    },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Создать 2 конв.' }));
  await waitFor(() => expect(screen.getByTestId('rollover-error')).toBeInTheDocument());
  expect(useNav.getState().stacks.budget).toHaveLength(1); // не фабрикуем успех

  fireEvent.click(screen.getByRole('button', { name: 'Создать 2 конв.' }));
  await waitFor(() => expect(rolloverCalls(calls)).toHaveLength(2));
  const [first, second] = rolloverCalls(calls);
  expect(second?.batchId).not.toBe(first?.batchId); // batchId непригоден — новый id
  await waitFor(() => expect(useNav.getState().stacks.budget).toHaveLength(0));
});

test('успех: budget.rollover с batchId-UUID, экран закрывается (pop)', async () => {
  const { calls } = await renderReady();

  fireEvent.click(screen.getByRole('button', { name: 'Создать 2 конв.' }));
  await waitFor(() => expect(rolloverCalls(calls)).toHaveLength(1));
  expect(rolloverCalls(calls)[0]?.batchId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUIDv7
  );
  await waitFor(() => expect(useNav.getState().stacks.budget).toHaveLength(0));
});

// --- needsSetup: первый месяц без истории (§3.5, §5 edge case) --------------------------

test('needsSetup: форма дохода и оценок по категориям; заполненные → те же rows с carryover "0.00"', async () => {
  const { calls } = renderWithProviders(<RolloverScreen />, handler({ preview: setupPreview }));
  await waitFor(() => expect(screen.getByLabelText('Оценка «Еда»')).toBeInTheDocument());

  // Оценки — по общему списку категорий
  fireEvent.change(screen.getByLabelText('Оценка «Еда»'), { target: { value: '30000' } });
  fireEvent.change(screen.getByLabelText('Оценка «Транспорт»'), { target: { value: '9000' } });
  // «Жильё» не заполнено → не попадает в rows

  fireEvent.change(screen.getByLabelText('Ожидаемый доход в месяц'), {
    target: { value: '165000' },
  });

  const submit = screen.getByRole('button', { name: 'Создать 2 конв.' });
  fireEvent.click(submit);
  await waitFor(() => expect(rolloverCalls(calls)).toHaveLength(1));
  const call = rolloverCalls(calls)[0];
  expect(call?.month).toBe(MONTH);
  expect(call?.rows).toEqual([
    { categoryId: 'cat-1', limit: '30000.00', carryover: '0.00' },
    { categoryId: 'cat-2', limit: '9000.00', carryover: '0.00' },
  ]);
  await waitFor(() => expect(useNav.getState().stacks.budget).toHaveLength(0));
});

test('needsSetup: без единой оценки сабмит недоступен; доход показывает нераспределённый остаток', async () => {
  renderWithProviders(<RolloverScreen />, handler({ preview: setupPreview }));
  await waitFor(() => expect(screen.getByLabelText('Оценка «Еда»')).toBeInTheDocument());

  expect(screen.getByRole('button', { name: /Создать/ })).toBeDisabled();

  fireEvent.change(screen.getByLabelText('Ожидаемый доход в месяц'), {
    target: { value: '165000' },
  });
  fireEvent.change(screen.getByLabelText('Оценка «Еда»'), { target: { value: '30000' } });
  // Нераспределённое = доход − сумма оценок (точная арифметика, не float)
  expect(screen.getByTestId('setup-unallocated')).toHaveTextContent('135 000');
  expect(screen.getByRole('button', { name: 'Создать 1 конв.' })).toBeEnabled();
});

// --- пустое превью ---------------------------------------------------------------------

test('rows пуст и needsSetup=false → заглушка «переносить нечего», кнопки создания нет', async () => {
  renderWithProviders(<RolloverScreen />, handler({ preview: emptyPreview }));
  await waitFor(() => expect(screen.getByText(/Переносить нечего/)).toBeInTheDocument());
  expect(screen.queryByRole('button', { name: /Создать/ })).toBeNull();
});
