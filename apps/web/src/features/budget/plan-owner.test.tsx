import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders, trpcError } from '../../test/harness';
import { trpc } from '../../trpc';
import { resetUndoSession } from '../undo/undo-epoch';
import { PlannedToFactCard } from './PlannedToFactCard';

const prompt = {
  entityId: '019a0000-0000-7000-8000-000000000040',
  amount: '100.00',
  direction: 'expense' as const,
  categoryRef: null,
};
test.each([
  'current',
  'old-success',
  'old-error',
] as const)('planned card %s keeps external continuation owned', async (mode) => {
  let close = 0;
  let resolve!: (v: unknown) => void;
  let reject!: (v: unknown) => void;
  const { calls } = renderWithProviders(
    <PlannedToFactCard
      prompt={prompt}
      onClose={() => {
        close++;
      }}
    />,
    (path) => {
      if (path === 'user.getSettings') return { timezone: 'UTC' };
      if (path === 'budget.confirmPurchase')
        return new Promise((r, j) => {
          resolve = r;
          reject = j;
        });
      return {};
    },
  );
  fireEvent.click(screen.getByText('Перевести в факт'));
  await waitFor(() => expect(resolve).toBeDefined());
  if (mode !== 'current') act(() => resetUndoSession());
  await act(async () =>
    mode === 'old-error'
      ? reject(trpcError('CONFLICT', 'old failure'))
      : resolve({ actionId: '019a0000-0000-7000-8000-000000000041', consequences: false }),
  );
  await waitFor(() => expect(screen.getByText('Перевести в факт')).toBeEnabled());
  expect(close).toBe(mode === 'current' ? 1 : 0);
  expect(screen.queryByTestId('plan-to-fact-error')).toBeNull();
  expect(calls.filter((c) => c.path === 'budget.confirmPurchase')).toHaveLength(1);
});

test.each([false, true])('budget refresh continuation ownerChanged=%s', async (ownerChanged) => {
  let close = 0;
  let reads = 0;
  let release: ((v: unknown) => void) | undefined;
  function Probe() {
    trpc.budget.alertCount.useQuery({});
    return (
      <PlannedToFactCard
        prompt={prompt}
        onClose={() => {
          close++;
        }}
      />
    );
  }
  renderWithProviders(<Probe />, (path) => {
    if (path === 'user.getSettings') return { timezone: 'UTC' };
    if (path === 'budget.alertCount') {
      reads++;
      return reads === 1
        ? 0
        : new Promise((r) => {
            release = r;
          });
    }
    if (path === 'budget.confirmPurchase')
      return { actionId: '019a0000-0000-7000-8000-000000000042', consequences: false };
    return {};
  });
  await waitFor(() => expect(reads).toBe(1));
  fireEvent.click(screen.getByText('Перевести в факт'));
  await waitFor(() => expect(release).toBeDefined());
  expect(close).toBe(0);
  if (ownerChanged) act(() => resetUndoSession());
  await act(async () => {
    release?.(0);
  });
  await waitFor(() => expect(close).toBe(ownerChanged ? 0 : 1));
  expect(screen.queryByTestId('plan-to-fact-error')).toBeNull();
});
