import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { mockEntityUpdateResult, renderWithProviders, wireEntity } from '../../test/harness';
import { navAt } from '../../test/nav';
import { registryReply } from '../../test/registry';
import { Toaster } from '../../ui/Toast';
import { DetailScreen } from './DetailScreen';

const id = '019a0000-0000-7000-8000-000000000060',
  old = '019a0000-0000-7000-8000-000000000061',
  next = '019a0000-0000-7000-8000-000000000062';
test('actual reference picker caption uses prior and next cached labels without extra title requests', async () => {
  navAt(id);
  const entity = wireEntity({
    id,
    title: 'Coffee',
    aspects: ['orbis/financial'],
    props: { 'orbis/finance_category': old },
  });
  const { calls } = renderWithProviders(
    <>
      <DetailScreen entityId={id} />
      <Toaster />
    </>,
    (path) => {
      if (path === 'entity.get') return { entity, relations: [], thread: null };
      if (path === 'entity.query')
        return [
          wireEntity({ id: old, title: 'Old label', aspects: ['orbis/category'] }),
          wireEntity({ id: next, title: 'Next label', aspects: ['orbis/category'] }),
        ];
      if (path === 'entity.update')
        return {
          ...mockEntityUpdateResult(entity),
          actionId: '019a0000-0000-7000-8000-000000000063',
          consequences: false,
        };
      return registryReply(path) ?? {};
    },
  );
  const picker = await screen.findByLabelText('Категория');
  await screen.findByRole('option', { name: 'Next label' });
  fireEvent.change(picker, { target: { value: next } });
  expect(await screen.findByText('Категория: Old label → Next label')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Отменить' })).toBeInTheDocument();
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(1));
  expect(
    calls
      .filter((c) => c.path === 'entity.get')
      .every((c) => (c.input as { id: string }).id === id),
  ).toBe(true);
});
