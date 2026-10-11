import { act, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { Toaster } from '../../ui/Toast';
import { useToastStore } from '../../ui/toast-store';
import { recordEditRule, useEntityUpdate } from '../entity-detail/useEntityDetail';
import { journalRefOf } from './journal-ref';

test('journalRef требует настоящий boolean, approval undo не становится действием', () => {
  expect(journalRefOf({ actionId: 'a1' })).toBeNull();
  expect(journalRefOf({ actionId: 'a1', consequences: 'true' })).toBeNull();
  expect(journalRefOf({ actionId: 'a1', consequences: false })).toEqual({
    actionId: 'a1',
    consequences: false,
  });
});
test('галочка без последствий — плашки нет; с последствиями — плашка переживает экран', async () => {
  let hide: (() => void) | undefined;
  let write: (() => void) | undefined;
  function Probe() {
    const { mutation } = useEntityUpdate('e1', { undoToast: recordEditRule });
    write = () => mutation.mutate({ id: 'e1', props: { 'orbis/task_status': 'done' } });
    return null;
  }
  function Tree() {
    const [visible, set] = useState(true);
    hide = () => set(false);
    return (
      <>
        {visible && <Probe />}
        <Toaster />
      </>
    );
  }
  let consequences = false;
  const { calls } = renderWithProviders(<Tree />, (path) =>
    path === 'entity.update'
      ? { ...wireEntity({ id: 'e1', title: 'Купить хлеб' }), actionId: 'a1', consequences }
      : {
          actionId: 'u1',
          undone: { id: 'a1', title: 'Закрытие' },
          pinnedVersions: [],
          bodyRevisions: [],
        },
  );
  await act(async () => {
    write?.();
  });
  await vi.dynamicImportSettled();
  expect(useToastStore.getState().toasts.filter((t) => t.action)).toHaveLength(0);
  consequences = true;
  await act(async () => {
    write?.();
  });
  await vi.dynamicImportSettled();
  expect(await screen.findByRole('button', { name: 'Отменить' })).toBeInTheDocument();
  act(() => hide?.());
  await act(async () => screen.getByRole('button', { name: 'Отменить' }).click());
  expect(calls.some((c) => c.path === 'ai.undo')).toBe(true);
});
