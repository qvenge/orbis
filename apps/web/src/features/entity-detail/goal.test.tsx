// Прогресс цели на detail-экране (01-architecture §11.3, Task E3). Число считает сервер
// (E2, goals/progress.ts) и кладёт его СОСЕДОМ сущности в ответ entity.get — клиент только
// рисует полосу и объясняет, когда посчитать не вышло.
import { screen, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders } from '../../test/harness';
import { DetailScreen } from './DetailScreen';

const goal = {
  id: 'g1',
  ownerId: 'u',
  title: 'Накопить на отпуск',
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: {
    'orbis/goal': {
      progress_source: {
        query: 'aspect=orbis/financial direction=income',
        aggregate: 'sum',
        field: 'amount',
      },
      target_value: '300000.00',
      unit: '₽',
    },
  },
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  archived: false,
};

/** Хелпера handlerWithGoal в проекте нет — обработчик здесь один и inline (прецедент detail.test.tsx). */
function goalHandler(goalProgress: unknown, entity: unknown = goal): MockHandler {
  return (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], backlinks: [], thread: null, goalProgress };
    if (path === 'aspect.list') return [];
    return {};
  };
}

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'g1' }], agenda: [], budget: [] },
  });
});

test('карточка цели показывает прогресс, единицу и процент', async () => {
  renderWithProviders(
    <DetailScreen entityId="g1" />,
    goalHandler({ current: '150000.00', target: '300000.00', ratio: 0.5 }),
  );
  expect(await screen.findByText('150 000 / 300 000')).toBeInTheDocument();
  // Единица — в самой подписи прогресса: шапка страницы (NativeRow, generic-строка §3.6)
  // печатает сырой `unit: ₽` из реестра и тоже даёт совпадение по '₽'.
  expect(within(screen.getByTestId('goal-progress')).getByText('₽')).toBeInTheDocument();
  const bar = screen.getByRole('progressbar');
  expect(bar).toHaveAttribute('aria-valuenow', '50');
  expect(bar).toHaveAttribute('aria-valuemin', '0');
  expect(bar).toHaveAttribute('aria-valuemax', '100');
  expect(screen.getByTestId('goal-bar')).toHaveStyle({ width: '50%' });
});

// Процент — точный по decimal-строкам, а не floor(ratio*100): 0.29*100 в IEEE-754 даёт
// 28.999999999999996, и полоса врала бы на процент на ровных значениях.
test('процент считается по decimal-строкам, а не по float-доле', async () => {
  renderWithProviders(
    <DetailScreen entityId="g1" />,
    goalHandler({ current: '87000.00', target: '300000.00', ratio: 0.29 }),
  );
  expect(await screen.findByText('29%')).toBeInTheDocument();
});

test('перевыполнение не переполняет полосу, но читается и глазами, и скринридером', async () => {
  renderWithProviders(
    <DetailScreen entityId="g1" />,
    goalHandler({ current: '360000.00', target: '300000.00', ratio: 1.2 }),
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
      goalHandler({ current: '0', target: '300000.00', ratio: 0, unsupported: reason }),
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
      goalHandler({ current: '0', target: '300000.00', ratio: 0, unsupported: reason }),
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

test('объектное поле аспекта показано read-only, а не редактируемым [object Object]', async () => {
  renderWithProviders(
    <DetailScreen entityId="g1" />,
    goalHandler({ current: '0', target: '300000.00', ratio: 0 }),
  );
  // Скалярные поля остаются редактируемыми
  expect(await screen.findByLabelText('orbis/goal target_value')).toBeInTheDocument();
  // Объект — нет инпута и никакого [object Object]
  expect(screen.queryByLabelText('orbis/goal progress_source')).toBeNull();
  expect(screen.queryByDisplayValue('[object Object]')).toBeNull();
  const ro = screen.getByTestId('aspect-value-orbis/goal-progress_source');
  expect(ro.tagName).not.toBe('INPUT');
  // Значение видно целиком: «поправьте query» бессмысленно, если query не показан
  expect(ro.textContent ?? '').toContain('aspect=orbis/financial direction=income');
});

test('массив строк показан списком через запятую, а не Array.toString в инпуте', async () => {
  const category = {
    ...goal,
    aspects: { 'orbis/category': { aliases: ['кофе', 'кофейня'], icon: '☕' } },
  };
  renderWithProviders(<DetailScreen entityId="g1" />, goalHandler(undefined, category));
  expect(await screen.findByLabelText('orbis/category icon')).toBeInTheDocument();
  expect(screen.queryByLabelText('orbis/category aliases')).toBeNull();
  expect(screen.getByTestId('aspect-value-orbis/category-aliases')).toHaveTextContent(
    'кофе, кофейня',
  );
});
