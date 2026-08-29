// Прогресс цели на detail-экране (01-architecture §11.3, Task E3). Число считает сервер
// (E2, goals/progress.ts) и кладёт его СОСЕДОМ сущности в ответ entity.get — клиент только
// рисует полосу и объясняет, когда посчитать не вышло.
import { parseBody } from '@orbis/shared/doc';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders, wireEntity } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { QuickCapture } from '../browser/QuickCapture';
import { DetailScreen } from './DetailScreen';

const goal = wireEntity({
  id: 'g1',
  title: 'Накопить на отпуск',
  // Часть контракта detail (include просит документ всегда): без него редактор не встал бы
  // никогда, и зелень файла держалась бы на состоянии, которого в проде не бывает.
  bodyDoc: parseBody(''),
  props: {
    // Источник прогресса — ДЕРЕВО Q-AST (§А5-2), а не строка грамматики: строку кладёт
    // только переходная обёртка `{text}`, и производитель новой формы её не пишет.
    'orbis/progress_source': {
      query: { filter: { aspect: 'orbis/financial', props: { 'orbis/direction': 'income' } } },
      aggregate: 'sum',
      field: 'orbis/amount',
    },
    'orbis/target_value': '300000.00',
    'orbis/unit': '₽',
  },
  aspects: ['orbis/goal'],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
});

/** Хелпера handlerWithGoal в проекте нет — обработчик здесь один и inline (прецедент detail.test.tsx). */
function goalHandler(goalProgress: unknown, entity: unknown = goal): MockHandler {
  return (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], backlinks: [], thread: null, goalProgress };
    // Реестр НАСТОЯЩИЙ: по нему подписаны и строки свойств, и шапка записи (§А9-2).
    return registryReply(path) ?? {};
  };
}

beforeEach(() => {
  localStorage.clear();
  // Простоя не даём: файл про полосу прогресса и поля аспектов, а редактор, встающий сам по
  // запасному таймеру, менял бы дерево посреди ожиданий (приём editor.test.tsx).
  vi.stubGlobal('requestIdleCallback', () => 1);
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'g1' }], agenda: [], budget: [] },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('карточка цели показывает прогресс, единицу и процент', async () => {
  renderWithProviders(
    <DetailScreen entityId="g1" />,
    goalHandler({ current: '150000.00', target: '300000.00' }),
  );
  expect(await screen.findByText('150 000 / 300 000')).toBeInTheDocument();
  // Единица — в самой подписи прогресса: шапка страницы (NativeRow, generic-строка §3.6)
  // печатает «Единица: ₽» и тоже даёт совпадение по '₽', поэтому ищем внутри полосы.
  expect(within(screen.getByTestId('goal-progress')).getByText('₽')).toBeInTheDocument();
  const bar = screen.getByRole('progressbar');
  expect(bar).toHaveAttribute('aria-valuenow', '50');
  expect(bar).toHaveAttribute('aria-valuemin', '0');
  expect(bar).toHaveAttribute('aria-valuemax', '100');
  expect(screen.getByTestId('goal-bar')).toHaveStyle({ width: '50%' });
});

// Процент — точный по decimal-строкам, а не floor от float-доли: 0.29*100 в IEEE-754 даёт
// 28.999999999999996, и полоса врала бы на процент на ровных значениях. Готовой доли в
// ответе сервера поэтому и нет — в контракте только две строки (goals/progress.ts).
test('процент считается по decimal-строкам, а не по float-доле', async () => {
  renderWithProviders(
    <DetailScreen entityId="g1" />,
    goalHandler({ current: '87000.00', target: '300000.00' }),
  );
  expect(await screen.findByText('29%')).toBeInTheDocument();
});

// Граница «ровно цель» — включительно: 100 % это уже достигнуто, а не «почти».
test('ровно 100 % — полоса полна и цель объявлена достигнутой', async () => {
  renderWithProviders(
    <DetailScreen entityId="g1" />,
    goalHandler({ current: '300000.00', target: '300000.00' }),
  );
  expect(await screen.findByText('100%')).toBeInTheDocument();
  expect(screen.getByTestId('goal-bar')).toHaveStyle({ width: '100%' });
  expect(screen.getByText(/достигнута/i)).toBeInTheDocument();
});

// Вторая сторона той же границы: недобор в копейку — ещё НЕ цель, и округлять вверх
// нельзя (тот же зарок, что у порогов Budget: «не округляем вверх до порога»).
test('99,99 % — это 99 %, а не достигнутая цель', async () => {
  renderWithProviders(
    <DetailScreen entityId="g1" />,
    goalHandler({ current: '299999.00', target: '300000.00' }),
  );
  expect(await screen.findByText('99%')).toBeInTheDocument();
  expect(screen.queryByText(/достигнута/i)).toBeNull();
});

// Отрицательный агрегат (знаковое поле — carryover, поле пользовательского аспекта):
// полоса пуста, но знак в подписи обязан остаться — иначе минус читался бы плюсом.
test('отрицательное текущее значение не теряет знак в подписи', async () => {
  renderWithProviders(
    <DetailScreen entityId="g1" />,
    goalHandler({ current: '-5000.00', target: '300000.00' }),
  );
  expect(await screen.findByText('−5 000 / 300 000')).toBeInTheDocument();
  expect(screen.getByTestId('goal-bar')).toHaveStyle({ width: '0%' });
});

// Полоса принадлежит ЦЕЛИ: обычная сущность её не показывает даже случайно (сервер
// поля goalProgress ей не кладёт вовсе).
test('у не-цели полосы прогресса нет вовсе', async () => {
  const task = {
    ...goal,
    props: { 'orbis/task_status': 'inbox', 'orbis/priority': 'high' },
    aspects: ['orbis/task'],
  };
  renderWithProviders(<DetailScreen entityId="g1" />, goalHandler(undefined, task));
  expect(await screen.findByLabelText('Состояние задачи')).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByTestId('goal-progress')).toBeNull();
});

test('перевыполнение не переполняет полосу, но читается и глазами, и скринридером', async () => {
  renderWithProviders(
    <DetailScreen entityId="g1" />,
    goalHandler({ current: '360000.00', target: '300000.00' }),
  );
  expect(await screen.findByText('120%')).toBeInTheDocument();
  expect(screen.getByTestId('goal-bar')).toHaveStyle({ width: '100%' });
  const bar = screen.getByRole('progressbar');
  expect(bar).toHaveAttribute('aria-valuenow', '100'); // контракт роли: 0..100
  expect(bar.getAttribute('aria-valuetext')).toContain('120%'); // правда — в valuetext
  expect(screen.getByText(/достигнута/i)).toBeInTheDocument();
});

// Четыре причины отказа — четыре РАЗНЫХ объяснения (решение Р20): ограничение механизма
// чинить нечем, а сломанный запрос/поле пользователь чинит сам.
const UNSUPPORTED_CASES: [string, RegExp][] = [
  ['array_field', /не поддерживает/i],
  ['invalid_query', /query/i],
  ['invalid_field', /field/i],
  ['compute_failed', /не удалось посчитать/i],
];

for (const [reason, re] of UNSUPPORTED_CASES) {
  test(`неподдерживаемый источник (${reason}) объясняется своим текстом, а не пустотой`, async () => {
    renderWithProviders(
      <DetailScreen entityId="g1" />,
      goalHandler({ current: '0', target: '300000.00', unsupported: reason }),
    );
    const note = await screen.findByTestId('goal-unsupported');
    expect(note.textContent ?? '').toMatch(re);
    // Полосы нет вовсе: 0% при непосчитанном прогрессе — не «пока ноль», а враньё.
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
}

test('четыре причины не сваливаются в одну фразу', async () => {
  const texts: string[] = [];
  for (const [reason] of UNSUPPORTED_CASES) {
    const { unmount } = renderWithProviders(
      <DetailScreen entityId="g1" />,
      goalHandler({ current: '0', target: '300000.00', unsupported: reason }),
    );
    texts.push((await screen.findByTestId('goal-unsupported')).textContent ?? '');
    unmount();
  }
  expect(new Set(texts).size).toBe(4);
});

// --- Р6: нескалярное значение аспекта не попадает в редактируемый инпут -------------------
// Обязательный у КАЖДОЙ цели объектный progress_source рисовался как [object Object], а blur
// слал строку и получал VALIDATION. Чинится общий случай: массивы (orbis/category.aliases),
// объекты (orbis/schedule.recurrence) — тем же правилом.

test('json-свойство показано read-only, а не редактируемым [object Object]', async () => {
  renderWithProviders(
    <DetailScreen entityId="g1" />,
    goalHandler({ current: '0', target: '300000.00' }),
  );
  // Свойство с набираемым типом (`decimal`) остаётся редактируемым
  expect(await screen.findByLabelText('Целевое значение')).toBeInTheDocument();
  // `json` контролом не набирают: ни инпута, ни [object Object]
  expect(screen.queryByLabelText('Источник прогресса')).toBeNull();
  expect(screen.queryByDisplayValue('[object Object]')).toBeNull();
  const ro = screen.getByTestId('prop-orbis/progress_source');
  expect(ro.tagName).not.toBe('INPUT');
  // Read-only строка подписана ТЕМ ЖЕ источником, что и редактируемая рядом (§А9-2): без
  // этого в одной сетке стояли бы «Целевое значение» и сырой `orbis/progress_source`.
  expect(await screen.findByText('Источник прогресса')).toBeInTheDocument();
  expect(screen.getByText('Целевое значение')).toBeInTheDocument();
  // Значение видно целиком: «поправьте query» бессмысленно, если query не показан
  expect(ro.textContent ?? '').toContain('orbis/direction');
});

test('массив строк показан списком через запятую, а не Array.toString в инпуте', async () => {
  const category = {
    ...goal,
    props: { 'orbis/aliases': ['кофе', 'кофейня'], 'orbis/icon': '☕' },
    aspects: ['orbis/category'],
  };
  renderWithProviders(<DetailScreen entityId="g1" />, goalHandler(undefined, category));
  expect(await screen.findByLabelText('Иконка')).toBeInTheDocument();
  // Список СВОБОДНОГО текста контролом не набирают (однострочной формы у него нет) —
  // показывается перечислением.
  expect(screen.queryByLabelText('Синонимы')).toBeNull();
  expect(screen.getByTestId('prop-orbis/aliases')).toHaveTextContent('кофе, кофейня');
});

// Категория финансовой записи — ЕДИНСТВЕННОЕ поле со своим контролом (пикер вместо инпута),
// и подпись ему ставит тот же реестр, что и соседним строкам: своя ветка рендера — не повод
// для своего словаря. Проба нужна отдельно, потому что мимо `AspectField` этот путь идёт
// целиком.
test('поле со своим контролом (категория) подписано тем же реестром', async () => {
  const tx = {
    ...goal,
    props: { 'orbis/amount': '340.00', 'orbis/finance_category': 'c1' },
    aspects: ['orbis/financial'],
  };
  renderWithProviders(<DetailScreen entityId="g1" />, goalHandler(undefined, tx));
  expect(await screen.findByText('Категория')).toBeInTheDocument();
  expect(screen.queryByText('category_ref')).toBeNull();
  // Соседняя строка того же аспекта — контролом по типу и тоже со словом из реестра.
  expect(screen.getByText('Сумма')).toBeInTheDocument();
});

// Пустой список — «алиасов нет», а не сломанная строка без значения.
test('пустой массив показан прочерком, а не пустотой', async () => {
  const category = {
    ...goal,
    props: { 'orbis/aliases': [], 'orbis/icon': '☕' },
    aspects: ['orbis/category'],
  };
  renderWithProviders(<DetailScreen entityId="g1" />, goalHandler(undefined, category));
  expect(await screen.findByTestId('prop-orbis/aliases')).toHaveTextContent('—');
});

// --- Р17: прогресс обновляется после добавления подходящей сущности -----------------------
// entity.get инвалидировался ТОЛЬКО точечно по id, поэтому открытая цель прогресс не
// обновляла ни после fast-path, ни после quick-add, ни после импорта.

test('прогресс обновляется после создания сущности из другого места экрана', async () => {
  let current = '150000.00';
  const handler: MockHandler = (path) => {
    if (path === 'entity.get')
      return {
        entity: goal,
        relations: [],
        backlinks: [],
        thread: null,
        goalProgress: { current, target: '300000.00' },
      };
    if (path === 'entity.create') {
      current = '200000.00'; // сервер посчитает прогресс заново на следующем чтении
      return { ...goal, id: 'new' };
    }
    if (path === 'aspect.list') return [];
    return {};
  };
  renderWithProviders(
    <>
      <DetailScreen entityId="g1" />
      <QuickCapture context={{ kind: 'root' }} />
    </>,
    handler,
  );
  expect(await screen.findByText('150 000 / 300 000')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Быстрая запись'), { target: { value: 'зарплата' } });
  fireEvent.click(screen.getByLabelText('Добавить'));
  await waitFor(() => expect(screen.getByText('200 000 / 300 000')).toBeInTheDocument());
});
