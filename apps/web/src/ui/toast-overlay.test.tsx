import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { Dialog } from './Dialog';
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
