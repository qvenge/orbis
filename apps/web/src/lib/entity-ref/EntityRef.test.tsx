import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { renderWithProviders, trpcError } from '../../test/harness';
import { EntityRef } from './EntityRef';

const entity = {
  id: '0f8b1c2d-3e4a-5b6c-7d8e-9f0a1b2c3d4e',
  ownerId: 'u',
  title: 'Обед с командой',
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: {},
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
};

test('loading → skeleton (role=status), success → title', async () => {
  renderWithProviders(<EntityRef id={entity.id} />, (path) => {
    if (path === 'entity.get') return { entity, relations: [] };
    throw new Error(`unexpected ${path}`);
  });
  // Пока запрос в полёте — skeleton.
  expect(screen.getByRole('status', { name: 'Загрузка' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('Обед с командой')).toBeInTheDocument());
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('ошибка запроса → укороченный моноширинный id, не полный UUID', async () => {
  renderWithProviders(<EntityRef id={entity.id} />, (path) => {
    if (path === 'entity.get') throw trpcError('NOT_FOUND');
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getByText('0f8b1c2d…')).toBeInTheDocument());
  expect(screen.queryByText(entity.id)).not.toBeInTheDocument();
});

test('onOpen задан → title кликабелен и зовёт onOpen(id)', async () => {
  const onOpen = vi.fn();
  renderWithProviders(<EntityRef id={entity.id} onOpen={onOpen} />, (path) => {
    if (path === 'entity.get') return { entity, relations: [] };
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Обед с командой' })).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Обед с командой' }));
  expect(onOpen).toHaveBeenCalledWith(entity.id);
});
