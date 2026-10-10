import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PropertiesRelationsSlot } from '../PropertiesRelationsSlot';

const state = vi.hoisted(() => ({ reads: 0 }));
vi.mock('./PropertiesRelationsPanel', () => ({
  get PropertiesRelationsPanel() {
    state.reads++;
    if (state.reads === 1) throw new Error('chunk failed');
    return ({ target }: { target: { entityId: string } }) => <p>{target.entityId}</p>;
  },
}));
it('failed lazy panel boundary explicitly retries a fresh React lazy lifetime for the same frozen id', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(
    <PropertiesRelationsSlot
      target={{ entityId: 'A', readOnly: false }}
      host={{ screenEntityId: 'B', available: new Set(), run: () => {} }}
      onClose={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Повторить загрузку панели' }));
  expect(await screen.findByText('A')).toBeVisible();
  expect(state.reads).toBe(2);
  error.mockRestore();
});
