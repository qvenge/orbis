import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { QueryBlock } from './QueryBlock';

const aspectsResp = [
  {
    id: 'orbis/task',
    ownerId: null,
    name: 'Task',
    namespace: 'orbis',
    description: null,
    icon: '✅',
    schema: { type: 'object', properties: {} },
    aiInstructions: null,
    tagMappings: [],
    aggregations: null,
    viewConfig: null,
    createdAt: 'x',
  },
];
const ent = (id: string) => ({
  id,
  ownerId: 'u',
  title: id,
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

test('валидный блок → список сущностей + счётчик; entity.query получил inner', async () => {
  const { calls } = renderWithProviders(
    <QueryBlock body="{{query:tags=work}}" title="Работа" />,
    (path) => {
      if (path === 'aspect.list') return aspectsResp;
      if (path === 'entity.query') return [ent('a'), ent('b')];
      return {};
    },
  );
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('2'));
  expect(screen.getAllByTestId('qb-item')).toHaveLength(2);
  // Аргумент запроса — строго inner (обёртка {{query:...}} снята, значение не пустое).
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({ query: 'tags=work' });
});

test('без title (DetailScreen) → счётчик с подписью «Совпадений: N», а не голое число', async () => {
  renderWithProviders(<QueryBlock body="{{query:tags=work}}" />, (path) => {
    if (path === 'aspect.list') return aspectsResp;
    if (path === 'entity.query') return [ent('a'), ent('b')];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('Совпадений: 2'));
});

test('невалидный блок → красная плашка с позицией, без списка и без вызова entity.query (§6.4)', async () => {
  const { calls } = renderWithProviders(
    <QueryBlock body="{{query:foo}}" title="Битый" />,
    (path) => {
      if (path === 'aspect.list') return aspectsResp;
      throw new Error(`unexpected ${path}`); // entity.query не должен вызываться
    },
  );
  // Ждём плашку ошибки: к этому моменту регрессный вызов entity.query успел бы зарегистрироваться.
  await screen.findByTestId('qb-error');
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByTestId('qb-error')).toHaveTextContent('позиция 0');
  expect(screen.getByTestId('qb-error')).toHaveTextContent(/ожидается конструкция/i);
  expect(screen.queryByTestId('qb-item')).not.toBeInTheDocument();
  // §6.4-гейт: при ошибке entity.query не вызывается вовсе (enabled: ok === false).
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
});
