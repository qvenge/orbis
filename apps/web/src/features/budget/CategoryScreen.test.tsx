// Task B3: экран категории (03-budget §3.2) — развёрнутая карточка текущего конверта
// (формулы §2.4, фазы §2.9), «Правила» = body категории, [Тред] → тред категории,
// мини-тренд по budget.categoryTrend (простые div-бары + штрих лимита), транзакции
// конверта (children_of, NativeRow §3.6, 🔁 у recurring-инстансов), quick-add с
// предзаданной категорией (B4, §3.6).

import type { CategoryTrendPoint, EnvelopeStatus } from '@orbis/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { App } from '../../App';
import { installHistorySync } from '../../app/history';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders, wireEntity } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { CategoryScreen } from './CategoryScreen';

// --- фикстуры -------------------------------------------------------------------------

/**
 * Строка выдачи в форме ПРОИЗВОДИТЕЛЯ (§А1-1): значения плоско по id свойства, аспекты —
 * списком навешенного. Старой карты «аспект → поля» в wire-форме больше нет (Задача 13c),
 * и фикстура, написанная по ней, описывала бы форму, которой сервер не отдаёт.
 */
const ent = (
  id: string,
  title: string,
  props: Record<string, unknown> = {},
  aspects: string[] = [],
  body = '',
) => wireEntity({ id, title, body, props, aspects });

const category = ent(
  'cat-1',
  'Еда',
  { 'orbis/icon': '🍔' },
  ['orbis/category'],
  'Бизнес-ланчи — сюда, не в Развлечения',
);

// 21 600 / 30 000 = 72% → warn; limit 28 800 + carryover 1 200 = effectiveLimit 30 000 (§2.4)
const envelopeStatus: EnvelopeStatus = {
  envelope: ent(
    'env-1',
    'Конверт «Еда» 2026-07',
    {
      'orbis/finance_category': 'cat-1',
      'orbis/limit': '28800.00',
      'orbis/currency': 'RUB',
      'orbis/period_start': '2026-07-01',
      'orbis/period_end': '2026-07-31',
      'orbis/carryover': '1200.00',
    },
    ['orbis/budget'],
  ),
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
  ent(
    't1',
    'Перекрёсток',
    {
      'orbis/amount': '2340.00',
      'orbis/direction': 'expense',
      'orbis/occurred_on': '2026-07-13',
      'orbis/finance_category': 'cat-1',
    },
    ['orbis/financial'],
  ),
  ent(
    't2',
    'Пятёрочка',
    {
      'orbis/amount': '1890.00',
      'orbis/direction': 'expense',
      'orbis/occurred_on': '2026-07-11',
      'orbis/finance_category': 'cat-1',
      'orbis/recurring': true,
    },
    ['orbis/financial'],
  ),
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
    over: {
      envelope?: EnvelopeStatus | null;
      body?: string;
      trend?: CategoryTrendPoint[];
      transactions?: ReturnType<typeof ent>[];
    } = {},
  ): MockHandler =>
  (path, input) => {
    if (path === 'user.getSettings') return settings;
    // Корень вкладки Budget — куда возвращает «Назад» в router-тесте ниже.
    if (path === 'budget.overview')
      return {
        period: { start: '2026-07-01', end: '2026-07-31' },
        balance: { income: '0.00', expense: '0.00', balance: '0.00' },
        envelopes: [],
        comingUp: [],
        planned: [],
        unbudgeted: [],
        alertCount: 0,
      };
    if (path === 'entity.get')
      return {
        entity: over.body === undefined ? category : { ...category, body: over.body },
        thread: { threadId: 'thr-cat', messages: [] },
      };
    if (path === 'budget.envelopeForCategory')
      return over.envelope === undefined ? envelopeStatus : over.envelope;
    if (path === 'budget.categoryTrend') return over.trend ?? trend;
    if (path === 'entity.query') return over.transactions ?? transactions;
    if (path === 'entity.create') {
      // Эхо wire-сущности (как сервер): карточка результата B4 читает ОТВЕТ, не форму
      const create = (
        input as { input: { id: string; title: string; props?: Record<string, unknown> } }
      ).input;
      return {
        ...ent(create.id, create.title, create.props ?? {}, ['orbis/financial']),
        actionId: 'act-1',
      };
    }
    // Реестр НАСТОЯЩИЙ: по нему строится и подпись поля, и множество пикера ссылки (§А6-1).
    return registryReply(path) ?? {};
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

  // Штрих-линия лимита: у 2026-05 конверта не было (limit=null) — штриха нет.
  // Типовой сценарий «limit = максимум шкалы» (обе точки: 30 000 = max) — позиция
  // клампится внутрь контейнера (calc(100% − 1px)), иначе overflow-hidden срезал бы
  // штрих на left:100% целиком и «(лимит ─ ─ ─)» из мокапа §3.2 не был бы виден.
  const ticks = screen.getAllByTestId('trend-limit');
  expect(ticks).toHaveLength(2);
  expect(ticks.map((t) => t.style.left)).toEqual(['calc(100% - 1px)', 'calc(100% - 1px)']);
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

  // limit — явной клаузой первой страницы (C6), не серверный дефолт 500
  const q = calls.find((c) => c.path === 'entity.query');
  expect(q?.input).toEqual({
    query: 'children_of=env-1, aspect=orbis/financial, sortBy=orbis/occurred_on:desc, limit=200',
  });

  // Заголовок секции — период текущего конверта (мокап §3.2: «Транзакции июня»)
  expect(screen.getByText('Транзакции июля')).toBeInTheDocument();

  const rows = screen.getAllByTestId('tx-row');
  expect(rows[0]).toHaveTextContent('Перекрёсток');
  expect(rows[0]).toHaveTextContent('−2 340'); // native-рендер §3.6: сумма со знаком
  expect(rows[0]).toHaveTextContent('13.07');
  expect(rows[1]).toHaveTextContent('Пятёрочка');

  // 🔁 — только у recurring-инстанса (aspects['orbis/financial'].recurring === true)
  expect(screen.getAllByLabelText('повторяется')).toHaveLength(1);
  expect(rows[1]?.contains(screen.getByLabelText('повторяется'))).toBe(true);

  // Пагинация (C6): записей меньше limit → кнопки нет, счётчик показан
  expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  expect(screen.getByText('Показано 2')).toBeInTheDocument();
});

// --- шаблон повторяющейся операции среди детей конверта (D20, Task A2) --------------------
// Шаблон (задан orbis/schedule.recurrence) не факт траты: сервер не считает его в spent
// даже при висящей parent-связи на конверт (защита в SQL, aggregates.test.ts). Значит и под
// конвертом ему не место — иначе список показывал бы строку, которой нет в spent того же
// конверта. ИНСТАНС шаблона (financial.recurring без recurrence) — операция, остаётся.

const recurringTemplate = ent(
  'tpl',
  'Аренда',
  {
    'orbis/amount': '50000.00',
    'orbis/direction': 'expense',
    'orbis/occurred_on': '2026-07-05',
    'orbis/finance_category': 'cat-1',
    'orbis/recurring': true,
    'orbis/start_at': '2026-07-05T09:00:00Z',
    'orbis/recurrence': { freq: 'monthly', interval: 1 },
  },
  ['orbis/financial', 'orbis/schedule'],
);

test('шаблон recurring среди детей конверта скрыт, его инстанс — виден (D20)', async () => {
  renderWithProviders(
    <CategoryScreen categoryId="cat-1" />,
    handler({ transactions: [recurringTemplate, ...transactions] }),
  );

  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(2));
  expect(screen.queryByText('Аренда')).toBeNull();
  expect(screen.getByText('Пятёрочка')).toBeInTheDocument();
  // 🔁 остаётся ровно у инстанса: у шаблона recurring=true тоже стоит, но строки его нет
  expect(screen.getAllByLabelText('повторяется')).toHaveLength(1);
  // Счётчик считает то, что видно
  expect(screen.getByText('Показано 2')).toBeInTheDocument();
});

// --- пагинация (Task C6): тот же механизм растущего окна, что на экране «Транзакции» ------
// Таймауты щедрее дефолтов: рендер сотен NativeRow в jsdom под параллельными воркерами
// полного прогона не укладывается в 1с (waitFor) / 5с (тест).

test('пагинация (C6): ровно limit детей конверта → «Показать ещё»; клик расширяет окно', {
  timeout: 30_000,
}, async () => {
  const all = Array.from({ length: 250 }, (_, i) =>
    ent(
      `m${i}`,
      `Операция ${i}`,
      {
        'orbis/amount': '10.00',
        'orbis/direction': 'expense',
        'orbis/occurred_on': '2026-07-10',
        'orbis/finance_category': 'cat-1',
      },
      ['orbis/financial'],
    ),
  );
  const base = handler();
  const paged: MockHandler = (path, input) => {
    // Только ТЕКСТОВЫЙ запрос — это список транзакций конверта; выдача по `ast` — множество
    // пикера ссылки (§А6-1), и подменять её страницей операций значило бы отвечать на чужой
    // вопрос (пикер показал бы двести транзакций вместо категорий).
    const q = (input as { query?: string }).query;
    if (path === 'entity.query' && q !== undefined) {
      const limit = Number(/limit=(\d+)/.exec(q)?.[1] ?? all.length);
      return all.slice(0, limit);
    }
    return base(path, input);
  };

  const { calls } = renderWithProviders(<CategoryScreen categoryId="cat-1" />, paged);
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(200), {
    timeout: 10_000,
  });
  expect(screen.getByText('Показано 200')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(250), {
    timeout: 10_000,
  });

  // Второе окно — та же строка children_of, только limit вырос (400)
  const queries = calls
    .filter((c) => c.path === 'entity.query')
    .map((c) => (c.input as { query: string }).query);
  expect(queries).toContain(
    'children_of=env-1, aspect=orbis/financial, sortBy=orbis/occurred_on:desc, limit=400',
  );
  // 250 < 400 → кнопка исчезла, счётчик честный
  expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
  expect(screen.getByText('Показано 250')).toBeInTheDocument();
});

test('произвольный период конверта (§2.9): подзаголовок и заголовок транзакций — диапазон дат', async () => {
  const arbitrary: EnvelopeStatus = {
    ...envelopeStatus,
    envelope: ent(
      'env-1',
      'Конверт «Еда» отпуск',
      {
        'orbis/finance_category': 'cat-1',
        'orbis/limit': '28800.00',
        'orbis/currency': 'RUB',
        'orbis/period_start': '2026-08-10',
        'orbis/period_end': '2026-08-24',
      },
      ['orbis/budget'],
    ),
  } as EnvelopeStatus;
  renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler({ envelope: arbitrary }));
  await waitFor(() => expect(screen.getByTestId('category-envelope')).toBeInTheDocument());

  expect(screen.getByText('10.08 – 24.08')).toBeInTheDocument();
  expect(screen.getByText('Транзакции 10.08 – 24.08')).toBeInTheDocument();
});

test('тап по транзакции пушит detail-экран сущности', async () => {
  renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler());
  await waitFor(() => expect(screen.getAllByTestId('tx-row')).toHaveLength(2));

  const firstRow = screen.getAllByTestId('tx-row')[0];
  if (!firstRow) throw new Error('нет строки транзакции');
  fireEvent.click(firstRow);
  expect(useNav.getState().stacks.budget).toEqual([{ kind: 'entity', id: 't1' }]);
});

// --- quick-add с предзаданной категорией (B4, перенесённый тест B3-Шаг1) --------------------

test('[+ запись] показывает quick-add с зафиксированной категорией', async () => {
  const { calls } = renderWithProviders(<CategoryScreen categoryId="cat-1" />, handler());
  await waitFor(() => expect(screen.getByTestId('category-envelope')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: '+ запись в эту категорию' }));
  expect(screen.getByTestId('quickadd-bar')).toBeInTheDocument();
  // Категория зафиксирована: пилюль и полного выбора нет (§3.2/§3.6)
  expect(screen.queryAllByTestId('category-pill')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Все категории' })).toBeNull();

  // Сабмит уходит с category_ref экрана и title-дефолтом «Еда <сумма>»
  fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '340' } });
  fireEvent.click(screen.getByRole('button', { name: 'Записать' }));
  await waitFor(() => expect(calls.some((c) => c.path === 'entity.create')).toBe(true));
  const call = calls.find((c) => c.path === 'entity.create')?.input as {
    input: { title: string; props: Record<string, unknown>; aspects: string[] };
    source: string;
  };
  expect(call.source).toBe('quick_capture');
  expect(call.input.title).toBe('Еда 340');
  expect(call.input.props).toMatchObject({
    'orbis/amount': '340.00',
    'orbis/direction': 'expense',
    'orbis/finance_category': 'cat-1',
  });
  // Аспект — ЯВНЫМ навешиванием (§А1-1): без него быстрая запись родила бы запись, которой
  // нет ни в списке транзакций, ни в spent конверта.
  expect(call.input.aspects).toEqual(['orbis/financial']);
});

// --- интеграция с router: budget-category в стеке рендерит CategoryScreen -------------------

test('ScreenRef budget-category рендерит CategoryScreen вместо заглушки; «Назад» возвращает', async () => {
  // D18: «Назад» ведёт через историю браузера — экран открываем настоящим push'ем при
  // живой синхронизации, иначе записи истории под него нет и откатывать нечего.
  const uninstall = installHistorySync();
  useNav.getState().push('budget', { kind: 'budget-category', id: 'cat-1' });
  renderWithProviders(<App />, handler());

  await waitFor(() => expect(screen.getByRole('heading', { name: /🍔 Еда/ })).toBeInTheDocument());
  expect(screen.queryByText(/Task B3/)).toBeNull(); // заглушки больше нет

  fireEvent.click(screen.getByTestId('nav-back'));
  await waitFor(() => expect(useNav.getState().stacks.budget).toEqual([]));
  uninstall();
});
