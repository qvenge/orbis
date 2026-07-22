// Task B4: quick-add бар Budget (03-budget §3.6) — быстрый структурированный ввод
// транзакции без чата: переключатель [−расход][+доход], сумма (запятая = точка,
// decimal-строка без float), пилюли 4–5 недавних категорий из последних 20 транзакций,
// полный выбор раскрытием, title опционален (пусто → «<категория> <сумма>»),
// client-UUIDv7 один раз на открытие формы (повтор после ошибки шлёт тот же id),
// успех → карточка-результат с остатком конверта и Undo (actionId из ответа create).
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders, trpcError } from '../../test/harness';
import { QuickAddBar } from './QuickAddBar';

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

const cat = (id: string, title: string, icon: string | null = null) =>
  ent(id, title, { 'orbis/category': icon ? { icon } : {} });

const categories = [
  cat('cat-1', 'Еда', '🍔'),
  cat('cat-2', 'Транспорт', '🚕'),
  cat('cat-3', 'Развлечения', '🎉'),
  cat('cat-4', 'Жильё', '🏠'),
  cat('cat-5', 'Здоровье'),
  cat('cat-6', 'Прочее'),
];

const tx = (id: string, categoryRef: string) =>
  ent(id, `tx-${id}`, {
    'orbis/financial': {
      amount: '100.00',
      direction: 'expense',
      occurred_on: '2026-07-20',
      category_ref: categoryRef,
    },
  });

// Последние 20 транзакций: уникальные category_ref по порядку —
// cat-2, cat-1, cat-3, cat-4, cat-5, cat-6 → пилюли берут первые 5 (без «Прочее»).
const recent = [
  tx('t1', 'cat-2'),
  tx('t2', 'cat-1'),
  tx('t3', 'cat-2'),
  tx('t4', 'cat-3'),
  tx('t5', 'cat-1'),
  tx('t6', 'cat-4'),
  tx('t7', 'cat-5'),
  tx('t8', 'cat-6'),
];

const settings = {
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 1,
  installedViews: ['orbis-budget'],
  pinnedEntities: [],
};

const envelopeStatus = {
  envelope: ent('env-1', 'Конверт «Еда» 2026-07', {
    'orbis/budget': {
      category_ref: 'cat-1',
      limit: '30000.00',
      currency: 'RUB',
      period_start: '2026-07-01',
      period_end: '2026-07-31',
    },
  }),
  category: { id: 'cat-1', title: 'Еда', icon: '🍔', color: null },
  spent: '21600.00',
  effectiveLimit: '30000.00',
  remaining: '8400.00',
  dailyPace: '600.00',
  phase: 'active',
};

type CreateBehavior = (input: unknown) => unknown;

const okCreate: CreateBehavior = (input) => {
  const { input: create } = input as { input: { id: string; title: string } };
  return { ...ent(create.id, create.title), actionId: 'act-1' };
};

const handler =
  (over: { create?: CreateBehavior; envelope?: unknown } = {}): MockHandler =>
  (path, input) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.query') {
      const q = (input as { query: string }).query;
      if (q.includes('orbis/category')) return categories;
      if (q.includes('orbis/financial')) return recent;
      return [];
    }
    if (path === 'entity.create') return (over.create ?? okCreate)(input);
    if (path === 'budget.envelopeForCategory')
      return over.envelope === undefined ? envelopeStatus : over.envelope;
    if (path === 'ai.undo') return { ok: true, actionId: 'act-1', results: [] };
    return {};
  };

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'budget',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

// Хелпер: последняя мутация entity.create из журнала вызовов.
function createCalls(calls: { path: string; input: unknown }[]) {
  return calls
    .filter((c) => c.path === 'entity.create')
    .map((c) => c.input as { input: Record<string, unknown>; source: string });
}

function finOf(call: { input: Record<string, unknown> }) {
  return (call.input.aspects as Record<string, Record<string, unknown>>)['orbis/financial'];
}

async function submitAmount(amount: string, pill?: string | RegExp) {
  fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: amount } });
  if (pill) fireEvent.click(screen.getByRole('button', { name: pill }));
  fireEvent.click(screen.getByRole('button', { name: 'Записать' }));
}

// --- пилюли недавних категорий (§3.6) -------------------------------------------------

test('пилюли: уникальные категории из последних 20 транзакций, максимум 5, по порядку', async () => {
  const { calls } = renderWithProviders(<QuickAddBar />, handler());
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  // Запрос недавних транзакций — ровно по брифу
  const q = calls.find(
    (c) =>
      c.path === 'entity.query' &&
      String((c.input as { query: string }).query).includes('orbis/financial'),
  );
  expect(q?.input).toEqual({
    query: 'aspect=orbis/financial, sortBy=occurred_on:desc, limit=20',
  });

  const pills = screen.getAllByTestId('category-pill');
  expect(pills.map((p) => p.textContent)).toEqual([
    '🚕 Транспорт',
    '🍔 Еда',
    '🎉 Развлечения',
    '🏠 Жильё',
    'Здоровье',
  ]);
});

// --- сабмит: структурированный entity_create (§3.6) -----------------------------------

test('ввод «340» + пилюля → entity.create: amount "340.00", expense, quick_capture, occurred_on = сегодня', async () => {
  const { calls } = renderWithProviders(<QuickAddBar />, handler());
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  await submitAmount('340', /Еда/);
  await waitFor(() => expect(createCalls(calls)).toHaveLength(1));

  const call = createCalls(calls)[0];
  if (!call) throw new Error('нет вызова create');
  expect(call.source).toBe('quick_capture');
  expect(typeof call.input.id).toBe('string'); // client-UUID
  const fin = finOf(call);
  expect(fin).toMatchObject({
    amount: '340.00',
    direction: 'expense',
    currency: 'RUB',
    category_ref: 'cat-1',
  });
  expect(String(fin?.occurred_on)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('переключатель [+доход] → direction income', async () => {
  const { calls } = renderWithProviders(<QuickAddBar />, handler());
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  fireEvent.click(screen.getByRole('button', { name: '+доход' }));
  expect(screen.getByRole('button', { name: '+доход' })).toHaveAttribute('aria-pressed', 'true');
  await submitAmount('150000', /Еда/);
  await waitFor(() => expect(createCalls(calls)).toHaveLength(1));
  const call = createCalls(calls)[0];
  expect(call && finOf(call)?.direction).toBe('income');
});

test('запятая = точка: «12,5» → amount "12.50" (decimal-строка, без float)', async () => {
  const { calls } = renderWithProviders(<QuickAddBar />, handler());
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  await submitAmount('12,5', /Еда/);
  await waitFor(() => expect(createCalls(calls)).toHaveLength(1));
  const call = createCalls(calls)[0];
  expect(call && finOf(call)?.amount).toBe('12.50');
});

test('невалидная сумма: [Записать] неактивна без суммы/категории', async () => {
  renderWithProviders(<QuickAddBar />, handler());
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  const submit = screen.getByRole('button', { name: 'Записать' });
  expect(submit).toBeDisabled(); // пусто
  fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '12..3' } });
  fireEvent.click(screen.getByRole('button', { name: /Еда/ }));
  expect(submit).toBeDisabled(); // мусор в сумме
  // Больше двух десятичных знаков — молчаливого обрезания копеек не будет
  fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '12,345' } });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '12.345' } });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Сумма'), { target: { value: '340' } });
  expect(submit).toBeEnabled();
});

// --- title (§3.6): опционален, пусто → «<категория> <сумма>» ---------------------------

test('пустой title → «Еда 340»; заполненный уходит как есть', async () => {
  const { calls } = renderWithProviders(<QuickAddBar />, handler());
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  await submitAmount('340', /Еда/);
  await waitFor(() => expect(createCalls(calls)).toHaveLength(1));
  expect(createCalls(calls)[0]?.input.title).toBe('Еда 340');

  // Второй сабмит — с явным title
  fireEvent.change(screen.getByPlaceholderText('title (опц.)…'), {
    target: { value: 'Обед с командой' },
  });
  await submitAmount('520', /Еда/);
  await waitFor(() => expect(createCalls(calls)).toHaveLength(2));
  expect(createCalls(calls)[1]?.input.title).toBe('Обед с командой');
});

// --- полный выбор категории раскрытием (§3.6) ------------------------------------------

test('«Все категории» раскрывает select со всеми категориями; выбор уходит в create', async () => {
  const { calls } = renderWithProviders(<QuickAddBar />, handler());
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  expect(screen.queryByLabelText('Категория')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Все категории' }));
  const select = screen.getByLabelText('Категория');
  expect(select.querySelectorAll('option')).toHaveLength(categories.length + 1); // + placeholder

  fireEvent.change(select, { target: { value: 'cat-6' } });
  await submitAmount('99');
  await waitFor(() => expect(createCalls(calls)).toHaveLength(1));
  const call = createCalls(calls)[0];
  expect(call && finOf(call)?.category_ref).toBe('cat-6');
});

// --- идемпотентность (урок бэклога): UUID один раз на открытие формы --------------------

test('повторный клик [Записать] после ошибки шлёт ТОТ ЖЕ id; после успеха id новый', async () => {
  let failures = 1;
  const { calls } = renderWithProviders(
    <QuickAddBar />,
    handler({
      create: (input) => {
        if (failures > 0) {
          failures -= 1;
          throw trpcError('INTERNAL_SERVER_ERROR');
        }
        return okCreate(input);
      },
    }),
  );
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  await submitAmount('340', /Еда/);
  await waitFor(() => expect(screen.getByTestId('quickadd-error')).toBeInTheDocument());

  // Повтор после ошибки — тот же client-UUID (идемпотентность §5.3)
  fireEvent.click(screen.getByRole('button', { name: 'Записать' }));
  await waitFor(() => expect(createCalls(calls)).toHaveLength(2));
  const [first, second] = createCalls(calls);
  expect(second?.input.id).toBe(first?.input.id);

  // Успех → форма перезапускается с НОВЫМ id
  await waitFor(() => expect(screen.getByTestId('quickadd-result')).toBeInTheDocument());
  await submitAmount('100', /Еда/);
  await waitFor(() => expect(createCalls(calls)).toHaveLength(3));
  expect(createCalls(calls)[2]?.input.id).not.toBe(first?.input.id);
});

test('CONFLICT — id занят чужой сущностью, запись НЕ создана: ошибка, следующая попытка с НОВЫМ id', async () => {
  // Семантика executor'а (§5.3): честный повтор владельцем того же id — replay-УСПЕХ;
  // CONFLICT кидается только когда id непригоден (чужая/RLS-невидимая строка) —
  // фабриковать карточку успеха нельзя, id надо перегенерировать.
  let conflicts = 1;
  const { calls } = renderWithProviders(
    <QuickAddBar />,
    handler({
      create: (input) => {
        if (conflicts > 0) {
          conflicts -= 1;
          throw trpcError('CONFLICT');
        }
        return okCreate(input);
      },
    }),
  );
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  await submitAmount('340', /Еда/);
  await waitFor(() => expect(screen.getByTestId('quickadd-error')).toBeInTheDocument());
  expect(screen.queryByTestId('quickadd-result')).toBeNull(); // не успех

  fireEvent.click(screen.getByRole('button', { name: 'Записать' }));
  await waitFor(() => expect(createCalls(calls)).toHaveLength(2));
  const [first, second] = createCalls(calls);
  expect(second?.input.id).not.toBe(first?.input.id); // свежий UUID после CONFLICT
  await waitFor(() => expect(screen.getByTestId('quickadd-result')).toBeInTheDocument());
});

test('карточка результата берёт title из ответа сервера (replay после сбоя), не из формы', async () => {
  // Транспортный сбой → пользователь отредактировал поля → повтор того же id вернул
  // replay со СТАРОЙ сущностью: карточка обязана показать записанное, не стейт формы.
  renderWithProviders(
    <QuickAddBar />,
    handler({
      create: (input) => {
        const { input: create } = input as { input: { id: string } };
        return { ...ent(create.id, 'Обед (записан ранее)'), actionId: 'act-1' };
      },
    }),
  );
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  fireEvent.change(screen.getByPlaceholderText('title (опц.)…'), {
    target: { value: 'Новый текст из формы' },
  });
  await submitAmount('340', /Еда/);
  const card = await screen.findByTestId('quickadd-result');
  expect(card).toHaveTextContent('Обед (записан ранее)');
  expect(card).not.toHaveTextContent('Новый текст из формы');
});

// --- успех: остаток конверта + Undo (§3.6) ---------------------------------------------

test('после успеха карточка показывает остаток конверта; envelopeForCategory с categoryId и датой', async () => {
  const { calls } = renderWithProviders(<QuickAddBar />, handler());
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  await submitAmount('340', /Еда/);
  const card = await screen.findByTestId('quickadd-result');
  expect(card).toHaveTextContent('Еда 340');
  expect(card).toHaveTextContent('осталось 8 400 ₽');

  const env = calls.find((c) => c.path === 'budget.envelopeForCategory');
  const input = env?.input as { categoryId: string; date: string };
  expect(input.categoryId).toBe('cat-1');
  expect(input.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('нет конверта на категорию → карточка без остатка («без конверта»)', async () => {
  renderWithProviders(<QuickAddBar />, handler({ envelope: null }));
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  await submitAmount('340', /Еда/);
  const card = await screen.findByTestId('quickadd-result');
  expect(card).toHaveTextContent('без конверта');
  expect(card).not.toHaveTextContent('осталось');
});

test('Undo зовёт ai.undo с actionId из ответа create; карточка помечается «Отменено»', async () => {
  const { calls } = renderWithProviders(<QuickAddBar />, handler());
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  await submitAmount('340', /Еда/);
  await screen.findByTestId('quickadd-result');

  fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
  await waitFor(() =>
    expect(calls.find((c) => c.path === 'ai.undo')?.input).toEqual({ actionId: 'act-1' }),
  );
  await waitFor(() => expect(screen.getByTestId('quickadd-result')).toHaveTextContent('Отменено'));
  expect(screen.queryByRole('button', { name: 'Отменить' })).toBeNull();
});

// --- предзаданная категория (экран категории, §3.2/§3.6) -------------------------------

test('preset: пилюль и запроса недавних нет, category_ref зафиксирован', async () => {
  const { calls } = renderWithProviders(
    <QuickAddBar preset={{ id: 'cat-1', title: 'Еда' }} />,
    handler(),
  );
  await waitFor(() => expect(screen.getByLabelText('Сумма')).toBeInTheDocument());

  expect(screen.queryAllByTestId('category-pill')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Все категории' })).toBeNull();
  expect(
    calls.filter(
      (c) =>
        c.path === 'entity.query' &&
        String((c.input as { query: string }).query).includes('orbis/financial'),
    ),
  ).toHaveLength(0);

  await submitAmount('340');
  await waitFor(() => expect(createCalls(calls)).toHaveLength(1));
  const call = createCalls(calls)[0];
  expect(call && finOf(call)?.category_ref).toBe('cat-1');
  expect(call?.input.title).toBe('Еда 340');
});
