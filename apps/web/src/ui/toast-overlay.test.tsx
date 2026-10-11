import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { Dialog } from './Dialog';
import { Sheet } from './Sheet';
import { Toaster } from './Toast';
import { useToastStore } from './toast-store';

test('presentation приезжает после открытого диалога: Escape закрывает диалог, предложение остаётся', async () => {
  function App() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Dialog open={open} onOpenChange={setOpen} title="Форма">
          <input aria-label="Поле" />
        </Dialog>
        <Toaster />
      </>
    );
  }
  render(<App />);
  const dialog = await screen.findByRole('dialog');
  act(() =>
    useToastStore.getState().show('Правка', 'default', { label: 'Отменить', onSelect: () => {} }),
  );
  await screen.findByText('Правка');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['Правка']);
});

test('Escape в самой плашке закрывает только её', () => {
  render(<Toaster />);
  act(() => useToastStore.getState().show('Следующая правка'));
  const item = screen.getByText('Следующая правка').closest('li')!;
  item.focus();
  fireEvent.keyDown(item, { key: 'Escape' });
  expect(screen.queryByText('Следующая правка')).toBeNull();
});

test('modal Sheet permits a real Undo pointer click without outside dismissal or raw loss', async () => {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <>
      <Sheet open title="Свойства и связи" onOpenChange={onOpenChange}>
        <input aria-label="Черновик" defaultValue="сырой текст" />
      </Sheet>
      <Toaster />
    </>,
  );
  const field = screen.getByLabelText('Черновик');
  field.focus();
  expect(document.body.style.pointerEvents).toBe('none');
  act(() =>
    useToastStore.getState().show('Снята связь', 'default', {
      label: 'Отменить',
      onSelect,
    }),
  );
  // userEvent checks actual inherited pointer-events; fireEvent bypasses hit-testing.
  await userEvent.click(screen.getByText('Отменить'));
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(field).toHaveValue('сырой текст');
  expect(field).toHaveFocus();
});
