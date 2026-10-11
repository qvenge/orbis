import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import type { BodyGate } from './EntityBody';
import { entity } from './properties-relations/test-fixtures';
import { usePageIdentityActions } from './usePageIdentityActions';

function Actions({ gate = null }: { gate?: BodyGate | null }) {
  const actions = usePageIdentityActions(entity, { current: gate });
  return (
    <>
      <button type="button" onClick={actions.makePage}>
        make
      </button>
      <button type="button" onClick={actions.stopPage}>
        stop
      </button>
    </>
  );
}
it.each([
  { action: 'make', key: 'attach', label: 'Сделать страницей' },
  { action: 'stop', key: 'detach', label: 'Перестать быть страницей' },
])('shared $action preserves exact addressed operation and journal label', async ({
  action,
  key,
  label,
}) => {
  const { calls } = renderWithProviders(<Actions />, () => ({ ok: true }));
  fireEvent.click(screen.getByText(action));
  await waitFor(() =>
    expect(calls.find((call) => call.path === 'entity.updateBatch')?.input).toEqual({
      operations: [
        { tool: 'entity_update', input: { id: entity.id, aspects: { [key]: ['orbis/page'] } } },
      ],
      label,
    }),
  );
});
it.each([false, true])('unsent body blocks page identity; blocked=%s', (blocked) => {
  const flush = vi.fn();
  const { calls } = renderWithProviders(
    <Actions
      gate={{
        hasUnsent: () => true,
        expectedRevision: () => 1,
        blocked: () => blocked,
        flush,
        offline: () => false,
        keptOffline: () => false,
      }}
    />,
  );
  fireEvent.click(screen.getByText('make'));
  fireEvent.click(screen.getByText('stop'));
  expect(calls).toHaveLength(0);
  expect(flush).toHaveBeenCalledTimes(blocked ? 0 : 2);
});
