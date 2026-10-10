import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { navAt } from '../../test/nav';
import { registryReply } from '../../test/registry';
import { DetailScreen } from './DetailScreen';

const delayed = vi.hoisted(() => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
});
vi.mock('./PinVersionDialog', async (original) => {
  await delayed.gate;
  return original();
});
it('cancel during pin chunk load and forced entity change both prevent late dialog opening', async () => {
  navAt('A');
  vi.stubGlobal('requestIdleCallback', () => 1);
  function Host() {
    const [id, setId] = useState('A');
    return (
      <>
        <button type="button" onClick={() => setId('B')}>
          Force B
        </button>
        <DetailScreen entityId={id} />
      </>
    );
  }
  const { calls } = renderWithProviders(<Host />, (path, input) =>
    path === 'entity.get'
      ? {
          entity: wireEntity({
            id: (input as { id: string }).id,
            title: `Запись ${(input as { id: string }).id}`,
            props: {},
            aspects: [],
          }),
          relations: [],
          thread: null,
        }
      : (registryReply(path) ?? []),
  );
  async function open() {
    fireEvent.click(await screen.findByTestId('screen-menu'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Закрепить версию' }));
    await screen.findByText('Загрузка формы…');
  }
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  expect(screen.queryByText('Загрузка формы…')).toBeNull();
  await open();
  fireEvent.click(screen.getByText('Force B'));
  await screen.findByRole('heading', { name: 'Запись B' });
  delayed.release();
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Закрепить версию' })).toBeNull(),
  );
  expect(calls.filter((call) => call.path === 'version.pin')).toHaveLength(0);
  vi.unstubAllGlobals();
});
