import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { useToastStore } from '../../ui/toast-store';
import { useAppAction } from '../apps/useAppAction';
import { QuickCapture } from '../browser/QuickCapture';
import { useUpdateBatch } from '../page/useUpdateBatch';
import { useSetExtensionEnabled } from '../settings/useDisabledExtensions';
import { useSupplyAction } from '../supply/useSupply';
import { resetUndoSession } from './undo-epoch';
import { peekUndoable } from './undo-stack';

function Probe() {
  const app = useAppAction();
  const batch = useUpdateBatch();
  const ext = useSetExtensionEnabled();
  const supply = useSupplyAction();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void app({ kind: 'disable', appId: 'app', title: 'Приложение', extensions: [] })
        }
      >
        Приложение
      </button>
      <button
        type="button"
        onClick={() =>
          void batch([{ tool: 'entity_update', input: { id: 'e1', archived: true } }], 'Пачка')
        }
      >
        Пачка
      </button>
      <button type="button" onClick={() => void ext('finance', false)}>
        Расширение
      </button>
      <button type="button" onClick={() => void supply({ kind: 'accept-all' })}>
        Поставка
      </button>
    </>
  );
}
beforeEach(resetUndoSession);
for (const name of ['Приложение', 'Пачка', 'Расширение', 'Поставка']) {
  test(`vanilla ${name}: late owner response не возвращает действие`, async () => {
    let finish!: (value: unknown) => void;
    const { calls } = renderWithProviders(
      <Probe />,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByText(name));
    await waitFor(() => expect(calls).toHaveLength(1));
    resetUndoSession();
    await act(async () => {
      finish({ actionId: 'old', consequences: false, accepted: [] });
      await vi.dynamicImportSettled();
    });
    expect(peekUndoable()).toBeUndefined();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
  test(`vanilla ${name}: current реальный Ref предлагает одну отмену; actionId alone не подходит`, async () => {
    let ref = true;
    renderWithProviders(<Probe />, () => ({
      actionId: 'current',
      ...(ref && { consequences: false }),
      accepted: [{}],
    }));
    fireEvent.click(screen.getByText(name));
    await waitFor(() => expect(peekUndoable()?.actionId).toBe('current'));
    resetUndoSession();
    ref = false;
    fireEvent.click(screen.getByText(name));
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(peekUndoable()).toBeUndefined();
  });
}
test('QuickCapture: late response не очищает ввод следующей сессии', async () => {
  let finish!: (value: unknown) => void;
  const { calls } = renderWithProviders(
    <QuickCapture context={{ kind: 'root' }} />,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const field = screen.getByLabelText('Быстрая запись');
  fireEvent.change(field, { target: { value: 'Старая' } });
  fireEvent.click(screen.getByLabelText('Добавить'));
  await waitFor(() => expect(calls).toHaveLength(1));
  resetUndoSession();
  fireEvent.change(field, { target: { value: 'Новая' } });
  await act(async () => {
    finish({ actionId: 'old', consequences: false });
    await vi.dynamicImportSettled();
  });
  expect(field).toHaveValue('Новая');
  expect(peekUndoable()).toBeUndefined();
});
