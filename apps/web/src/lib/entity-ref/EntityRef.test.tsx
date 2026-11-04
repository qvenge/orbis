import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { resetNavForTests } from '../../state/navigation';
import { renderWithProviders, trpcError, wireEntity } from '../../test/harness';
import { recordAddress, topAddress } from '../../test/nav';
import { EntityRef } from './EntityRef';

const entity = wireEntity({
  id: '0f8b1c2d-3e4a-5b6c-7d8e-9f0a1b2c3d4e',
  title: 'Обед с командой',
});

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

test('onOpen задан → title становится нативной ссылкой и зовёт onOpen(id)', async () => {
  const onOpen = vi.fn();
  renderWithProviders(<EntityRef id={entity.id} onOpen={onOpen} />, (path) => {
    if (path === 'entity.get') return { entity, relations: [] };
    throw new Error(`unexpected ${path}`);
  });
  const link = await screen.findByRole('link', { name: 'Обед с командой' });
  expect(link).toHaveAttribute('href', `/r/${entity.id}`);
  fireEvent.click(link);
  expect(onOpen).toHaveBeenCalledWith(entity.id);
});

test('link открывает запись в текущей рамке без отдельного callback', async () => {
  resetNavForTests();
  renderWithProviders(<EntityRef id={entity.id} link />, () => ({ entity, relations: [] }));
  const anchor = await screen.findByRole('link', { name: entity.title });
  fireEvent.click(anchor);
  expect(topAddress()).toEqual(recordAddress(entity.id));
});
