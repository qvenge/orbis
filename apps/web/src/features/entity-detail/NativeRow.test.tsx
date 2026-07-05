import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
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

test('financial: сумма с минусом и тоном danger', () => {
  render(
    <NativeRow
      entity={
        {
          ...base,
          aspects: {
            'orbis/financial': { amount: '340.00', direction: 'expense', category_ref: 'cat-food' },
          },
        } as never
      }
      onToggleTask={() => {}}
    />,
  );
  const amount = screen.getByTestId('native-amount');
  expect(amount.textContent?.startsWith('−')).toBe(true);
  expect(amount.className).toContain('text-danger');
});

test('financial: income → плюс и позитивный тон', () => {
  render(
    <NativeRow
      entity={
        {
          ...base,
          aspects: {
            'orbis/financial': {
              amount: '340.00',
              direction: 'income',
              category_ref: 'cat-salary',
            },
          },
        } as never
      }
      onToggleTask={() => {}}
    />,
  );
  const amount = screen.getByTestId('native-amount');
  expect(amount.textContent?.startsWith('+')).toBe(true);
  expect(amount.className).toContain('text-accent');
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
