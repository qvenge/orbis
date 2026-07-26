import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { NativeRow } from './NativeRow';

const base = {
  id: 'e1',
  ownerId: 'u',
  title: 'Обед',
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
};

// Категория-сущность в форме ответа entity.query (тот же список, что у пикера D3b).
const category = (id: string, title: string) => ({
  ...base,
  id,
  title,
  aspects: { 'orbis/category': { icon: '🍔' } },
});

const financial = (fields: Record<string, unknown>) =>
  ({ ...base, aspects: { 'orbis/financial': fields } }) as never;

const CAT_FOOD = 'a3d6d4b2-7f3a-4a1f-9c1e-2d5b8f0a1c77';

test('financial: сумма с минусом и тоном danger', () => {
  renderWithProviders(
    <NativeRow
      entity={financial({ amount: '340.00', direction: 'expense', category_ref: CAT_FOOD })}
      onToggleTask={() => {}}
    />,
  );
  const amount = screen.getByTestId('native-amount');
  expect(amount.textContent?.startsWith('−')).toBe(true);
  expect(amount.className).toContain('text-danger');
});

test('financial: income → плюс и позитивный тон', () => {
  renderWithProviders(
    <NativeRow
      entity={financial({ amount: '340.00', direction: 'income', category_ref: 'cat-salary' })}
      onToggleTask={() => {}}
    />,
  );
  const amount = screen.getByTestId('native-amount');
  expect(amount.textContent?.startsWith('+')).toBe(true);
  expect(amount.className).toContain('text-success');
});

// D6c п.2 (живой смоук D6b): в шапке detail печатался сырой category_ref — для
// транзакции без конверта пользователь не видел названия категории вообще.
test('financial: бейдж — НАЗВАНИЕ категории, а не uuid (D6c п.2)', async () => {
  const { calls } = renderWithProviders(
    <NativeRow
      entity={financial({ amount: '340.00', direction: 'expense', category_ref: CAT_FOOD })}
      onToggleTask={() => {}}
    />,
    (path) => (path === 'entity.query' ? [category(CAT_FOOD, 'Еда')] : {}),
  );
  expect(await screen.findByText('Еда')).toBeInTheDocument();
  expect(screen.queryByText(CAT_FOOD)).toBeNull();
  // Источник категорий — тот же запрос (и тот же кэш), что у пикера D3b: второго нет
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({
    query: 'aspect=orbis/category, sortBy=title:asc, limit=200',
  });
});

test('financial: категории нет в списке → uuid как запасной вариант (D6c п.2)', async () => {
  renderWithProviders(
    <NativeRow
      entity={financial({ amount: '340.00', direction: 'expense', category_ref: CAT_FOOD })}
      onToggleTask={() => {}}
    />,
    (path) => (path === 'entity.query' ? [category('другая', 'Развлечения')] : {}),
  );
  await screen.findByText(CAT_FOOD);
});

test('нефинансовая строка список категорий не запрашивает', async () => {
  const { calls } = renderWithProviders(
    <NativeRow
      entity={{ ...base, aspects: { 'orbis/task': { status: 'inbox' } } } as never}
      onToggleTask={() => {}}
    />,
  );
  await screen.findByRole('checkbox');
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
});

test('task: рендерит чекбокс', () => {
  render(
    <NativeRow
      entity={
        { ...base, aspects: { 'orbis/task': { status: 'inbox', priority: 'high' } } } as never
      }
      onToggleTask={() => {}}
    />,
  );
  expect(screen.getByRole('checkbox')).toBeInTheDocument();
});

test('generic: 2-3 keyFields из реестра', () => {
  render(
    <NativeRow
      entity={
        { ...base, aspects: { 'orbis/note': { content_type: 'text', pinned: true } } } as never
      }
      onToggleTask={() => {}}
    />,
  );
  expect(screen.getByTestId('native-generic')).toBeInTheDocument();
});
