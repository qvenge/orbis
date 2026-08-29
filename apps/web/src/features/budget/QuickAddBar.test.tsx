// Task B4: quick-add бар Budget (03-budget §3.6) — быстрый структурированный ввод
// транзакции без чата: переключатель [−расход][+доход], сумма (запятая = точка,
// decimal-строка без float), пилюли 4–5 недавних категорий из последних 20 транзакций,
// полный выбор раскрытием, title опционален (пусто → «<категория> <сумма>»),
// client-UUIDv7 один раз на открытие формы (повтор после ошибки шлёт тот же id),
// успех → карточка-результат с остатком конверта и Undo (actionId из ответа create).
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders, trpcError, wireEntity } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { trpc } from '../../trpc';
import { QuickAddBar } from './QuickAddBar';

// --- фикстуры -------------------------------------------------------------------------

/**
 * Строка выдачи в форме ПРОИЗВОДИТЕЛЯ (§А1-1): значения плоско по id свойства, аспекты —
 * списком навешенного. Старой карты «аспект → поля» в wire-форме больше нет (Задача 13c).
 */
const ent = (
  id: string,
  title: string,
  props: Record<string, unknown> = {},
  aspects: string[] = [],
) => wireEntity({ id, title, props, aspects });

const cat = (id: string, title: string, icon: string | null = null) =>
  ent(id, title, icon ? { 'orbis/icon': icon } : {}, ['orbis/category']);

const categories = [
  cat('cat-1', 'Еда', '🍔'),
  cat('cat-2', 'Транспорт', '🚕'),
  cat('cat-3', 'Развлечения', '🎉'),
  cat('cat-4', 'Жильё', '🏠'),
  cat('cat-5', 'Здоровье'),
  cat('cat-6', 'Прочее'),
];

const tx = (id: string, categoryRef: string) =>
  ent(
    id,
    `tx-${id}`,
    {
      'orbis/amount': '100.00',
      'orbis/direction': 'expense',
      'orbis/occurred_on': '2026-07-20',
      'orbis/finance_category': categoryRef,
    },
    ['orbis/financial'],
  );

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
  envelope: ent(
    'env-1',
    'Конверт «Еда» 2026-07',
    {
      'orbis/finance_category': 'cat-1',
      'orbis/limit': '30000.00',
      'orbis/currency': 'RUB',
      'orbis/period_start': '2026-07-01',
      'orbis/period_end': '2026-07-31',
    },
    ['orbis/budget'],
  ),
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
  (over: { create?: CreateBehavior; envelope?: unknown; undo?: () => unknown } = {}): MockHandler =>
  (path, input) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.query') {
      // Три вопроса, две формы входа: список НЕДАВНИХ операций и список категорий для
      // ПИЛЮЛЬ — боевые тексты смарт-листов, множество ПИКЕРА — Q-AST цели свойства из
      // реестра (§А6-1). Формы разные, и подменять одну другой нельзя: пикер получил бы
      // список операций.
      const { query, ast } = input as { query?: string; ast?: { filter?: { aspect?: string } } };
      if (ast?.filter?.aspect === 'orbis/category') return categories;
      if (query?.includes('orbis/category')) return categories;
      if (query?.includes('orbis/financial')) return recent;
      return [];
    }
    if (path === 'entity.create') return (over.create ?? okCreate)(input);
    if (path === 'budget.envelopeForCategory')
      return over.envelope === undefined ? envelopeStatus : over.envelope;
    if (path === 'ai.undo')
      return over.undo ? over.undo() : { ok: true, actionId: 'act-1', results: [] };
    // Реестр НАСТОЯЩИЙ: по нему пикер узнаёт цель свойства `orbis/finance_category`.
    return registryReply(path) ?? {};
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

/**
 * Свойства отправки — плоско по id (§А1-1). Читаются они здесь ТЕМ ЖЕ адресом, каким их
 * пишет форма: старой карты «аспект → поля» отправитель больше не знает.
 */
function propsOf(call: { input: Record<string, unknown> }) {
  return call.input.props as Record<string, unknown>;
}

/** Аспекты отправки — СПИСОК навешиваемого (§А1-1). */
function aspectsOf(call: { input: Record<string, unknown> }) {
  return call.input.aspects as string[] | undefined;
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
    query: 'aspect=orbis/financial, sortBy=orbis/occurred_on:desc, limit=20',
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
  const props = propsOf(call);
  expect(props).toMatchObject({
    'orbis/amount': '340.00',
    'orbis/direction': 'expense',
    'orbis/currency': 'RUB',
    'orbis/finance_category': 'cat-1',
  });
  expect(String(props['orbis/occurred_on'])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // ЗАПИСЬ С НУЛЯ: аспект навешивается ЯВНО. Старая карта вешала его самим фактом ключа —
  // на этой подмене формы отправитель и терял носитель молча (регрессия жеста 13b), а
  // быстрая запись без `orbis/financial` не попадает ни в список транзакций, ни в spent.
  expect(aspectsOf(call)).toEqual(['orbis/financial']);
});

test('переключатель [+доход] → direction income', async () => {
  const { calls } = renderWithProviders(<QuickAddBar />, handler());
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  fireEvent.click(screen.getByRole('button', { name: '+доход' }));
  expect(screen.getByRole('button', { name: '+доход' })).toHaveAttribute('aria-pressed', 'true');
  await submitAmount('150000', /Еда/);
  await waitFor(() => expect(createCalls(calls)).toHaveLength(1));
  const call = createCalls(calls)[0];
  expect(call && propsOf(call)['orbis/direction']).toBe('income');
});

test('запятая = точка: «12,5» → amount "12.50" (decimal-строка, без float)', async () => {
  const { calls } = renderWithProviders(<QuickAddBar />, handler());
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  await submitAmount('12,5', /Еда/);
  await waitFor(() => expect(createCalls(calls)).toHaveLength(1));
  const call = createCalls(calls)[0];
  expect(call && propsOf(call)['orbis/amount']).toBe('12.50');
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
  const select = await screen.findByLabelText('Категория');
  // + пустой вариант «Не выбрано»: единственный способ снять ссылку из формы.
  await waitFor(() =>
    expect(select.querySelectorAll('option')).toHaveLength(categories.length + 1),
  );

  fireEvent.change(select, { target: { value: 'cat-6' } });
  await submitAmount('99');
  await waitFor(() => expect(createCalls(calls)).toHaveLength(1));
  const call = createCalls(calls)[0];
  expect(call && propsOf(call)['orbis/finance_category']).toBe('cat-6');
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

/**
 * Бар быстрой записи, который можно снять с монтирования, не трогая пробник бюджета.
 *
 * Ровно этот сюжет и ломался: [Отменить] → немедленный уход на другую вкладку → роутер
 * размонтирует Бюджет (рисуется только активная вкладка) → у мутации `ai.undo` не остаётся
 * живых слушателей, а поштучные колбэки `mutate` `@tanstack/query-core` при этом НЕ зовёт
 * (`mutationObserver.js:77`). Гашение агрегатов висело именно там, поэтому конверты и бейдж
 * оставались со СПИСАННОЙ суммой, которой в графе уже нет, — и жили так до перезагрузки:
 * `useBudgetAlertCount` смонтирован в оболочке приложения и сам не протухает.
 */
function BudgetProbe() {
  const q = trpc.budget.alertCount.useQuery({});
  return <span data-testid="budget-probe">{String(q.data ?? '')}</span>;
}

function BarUntilHidden() {
  const [hidden, setHidden] = useState(false);
  return (
    <>
      <BudgetProbe />
      <button type="button" data-testid="leave-screen" onClick={() => setHidden(true)}>
        уйти с экрана
      </button>
      {!hidden && <QuickAddBar />}
    </>
  );
}

test('отмена записи гасит агрегаты, даже если экран размонтирован до ответа ai.undo', async () => {
  // Ответ сервера держим за нитку: отмена обязана уйти, экран — исчезнуть, и только потом
  // мутация оседает. На поштучном `onSuccess` инвалидации в этот момент уже не случается.
  let settle: (value: unknown) => void = () => {};
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  const { calls } = renderWithProviders(
    <BarUntilHidden />,
    handler({ undo: () => pending as unknown }),
  );
  const budgetReads = () => calls.filter((c) => c.path === 'budget.alertCount').length;
  await waitFor(() => expect(budgetReads()).toBe(1));
  await waitFor(() => expect(screen.getAllByTestId('category-pill').length).toBeGreaterThan(0));

  await submitAmount('340', /Еда/);
  await screen.findByTestId('quickadd-result');
  // Успешная запись сама гасит агрегаты — считаем ЭТОТ рубеж, чтобы «перечитали» ниже не
  // засчитало гашение от создания.
  await waitFor(() => expect(budgetReads()).toBeGreaterThan(1));
  const beforeUndo = budgetReads();

  fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
  await waitFor(() => expect(calls.some((c) => c.path === 'ai.undo')).toBe(true));

  // Ушли с экрана ДО ответа: бара больше нет, пробник бюджета жив. Размонтирование —
  // состоянием внутри дерева, а не `rerender` обёртки: тот заменил бы КОРЕНЬ, потеряв
  // провайдеры tRPC вместе с самим кэшем, за которым проба и следит.
  fireEvent.click(screen.getByTestId('leave-screen'));
  expect(screen.queryByTestId('quickadd-bar')).toBeNull();

  await act(async () => {
    settle({ ok: true, actionId: 'act-1', results: [] });
    await pending;
  });
  // Наблюдаемый след оседания — ПЕРЕЧИТЫВАНИЕ бюджета, а не выдержка по часам: на стенных
  // часах проба зеленела бы и под сломанным механизмом при достаточно быстром ответе.
  await waitFor(() => expect(budgetReads()).toBeGreaterThan(beforeUndo));
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
  expect(call && propsOf(call)['orbis/finance_category']).toBe('cat-1');
  expect(call?.input.title).toBe('Еда 340');
});
