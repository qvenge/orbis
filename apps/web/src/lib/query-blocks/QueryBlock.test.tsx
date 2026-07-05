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

test('валидный блок → список сущностей + счётчик', async () => {
  renderWithProviders(<QueryBlock body="{{query:tags=work}}" title="Работа" />, (path) => {
    if (path === 'aspect.list') return aspectsResp;
    if (path === 'entity.query') return [ent('a'), ent('b')];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('2'));
  expect(screen.getAllByTestId('qb-item')).toHaveLength(2);
});

test('невалидный блок → красная плашка с позицией, без списка (§6.4)', async () => {
  renderWithProviders(<QueryBlock body="{{query:foo}}" title="Битый" />, (path) => {
    if (path === 'aspect.list') return aspectsResp;
    throw new Error(`unexpected ${path}`); // entity.query не должен вызываться
  });
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  expect(screen.getByTestId('qb-error')).toHaveTextContent(/позиция/i);
  expect(screen.queryByTestId('qb-item')).not.toBeInTheDocument();
});
