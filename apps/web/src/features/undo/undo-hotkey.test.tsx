import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { renderWithProviders, trpcError } from '../../test/harness';
import { Toaster } from '../../ui/Toast';
import { useToastStore } from '../../ui/toast-store';
import { registerBodyFlush } from '../entity-editor/body-flush';
import { clearUndoStack, peekUndoable, pushUndoable } from './undo-stack';
import { CONTINUE_UNDO, offerUndo } from './undo-toast';
import { useUndoHotkey } from './useUndoHotkey';

function Probe() {
  useUndoHotkey();
  return null;
}
const outcome = (id: string) => ({
  actionId: `undo-${id}`,
  undone: { id, title: id },
  pinnedVersions: [],
  bodyRevisions: [],
});
const chord = (init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', {
    key: 'z',
    code: 'KeyZ',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => target.dispatchEvent(event));
  return event;
};
beforeEach(() => {
  clearUndoStack();
  for (const t of useToastStore.getState().toasts) useToastStore.getState().dismiss(t.id);
});
test('две вкладки: already снимает только верх, следующее нажатие отменяет следующее', async () => {
  pushUndoable({ actionId: 'a1', title: 'Первое', entityIds: [] });
  pushUndoable({ actionId: 'a2', title: 'Второе', entityIds: [] });
  const { calls } = renderWithProviders(
    <>
      <Toaster />
      <Probe />
    </>,
    (path, input) => {
      if (path !== 'ai.undo') return {};
      const id = (input as { actionId: string }).actionId;
      if (id === 'a2')
        throw trpcError('BAD_REQUEST', 'secret', {
          code: 'VALIDATION',
          details: { reason: 'already_undone' },
        });
      return outcome(id);
    },
  );
  expect(chord().defaultPrevented).toBe(true);
  expect(await screen.findByText('Уже отменено с другого устройства: Второе')).toBeInTheDocument();
  expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(1);
  expect(peekUndoable()?.actionId).toBe('a1');
  chord();
  expect(await screen.findByText('Отменено: a1')).toBeInTheDocument();
  expect(peekUndoable()).toBeUndefined();
});
test('два действия требуют два нажатия; русская и нелатинская раскладки', async () => {
  pushUndoable({ actionId: 'a1', title: 'Первое', entityIds: [] });
  pushUndoable({ actionId: 'a2', title: 'Второе', entityIds: [] });
  const { calls } = renderWithProviders(
    <>
      <Toaster />
      <Probe />
    </>,
    (path, input) => (path === 'ai.undo' ? outcome((input as { actionId: string }).actionId) : {}),
  );
  chord({ key: 'я' });
  expect(await screen.findByText('Отменено: a2')).toBeInTheDocument();
  expect(peekUndoable()?.actionId).toBe('a1');
  chord({ key: 'ש' });
  expect(await screen.findByText('Отменено: a1')).toBeInTheDocument();
  expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(2);
  expect(chord().defaultPrevented).toBe(false);
});
test('repeat, Shift, Alt и латинская non-QWERTY не берутся', async () => {
  pushUndoable({ actionId: 'a', title: 'Правка' });
  const { calls } = renderWithProviders(<Probe />, () => outcome('a'));
  for (const init of [{ repeat: true }, { shiftKey: true }, { altKey: true }, { key: 'y' }])
    expect(chord(init).defaultPrevented).toBe(false);
  await vi.dynamicImportSettled();
  expect(calls).toHaveLength(0);
});
test('поля чата, поиска, свойства, ProseMirror и открытые overlays сохраняют native undo', async () => {
  pushUndoable({ actionId: 'a', title: 'Правка' });
  const { calls } = renderWithProviders(
    <>
      <Probe />
      <input aria-label="Сообщение" />
      <input type="search" aria-label="Поиск" />
      <select aria-label="Свойство" />
      <div className="ProseMirror">
        <span data-testid="editor" />
      </div>
    </>,
    () => outcome('a'),
  );
  for (const target of [
    screen.getByLabelText('Сообщение'),
    screen.getByLabelText('Поиск'),
    screen.getByLabelText('Свойство'),
    screen.getByTestId('editor'),
  ])
    expect(chord({}, target).defaultPrevented).toBe(false);
  for (const role of ['dialog', 'alertdialog', 'menu']) {
    const overlay = document.createElement('div');
    overlay.setAttribute('role', role);
    overlay.dataset.state = 'open';
    document.body.append(overlay);
    expect(chord().defaultPrevented).toBe(false);
    overlay.remove();
  }
  await vi.dynamicImportSettled();
  expect(calls).toHaveLength(0);
});
test('отказ сохраняет верх, force снимает после успеха', async () => {
  pushUndoable({ actionId: 'a', title: 'Правка', entityIds: [] });
  let n = 0;
  const { calls } = renderWithProviders(
    <>
      <Toaster />
      <Probe />
    </>,
    (path) => {
      if (path !== 'ai.undo') return {};
      if (++n === 1)
        throw trpcError('CONFLICT', 'secret', {
          code: 'UNDO_TEXT_CHANGED',
          details: {
            action: { id: 'a', title: 'Правка' },
            continuation: { kind: 'here' },
            entries: [],
          },
        });
      return outcome('a');
    },
  );
  chord();
  fireEvent.click(await screen.findByRole('button', { name: CONTINUE_UNDO }));
  expect(peekUndoable()?.actionId).toBe('a');
  expect(await screen.findByText('Отменено: a')).toBeInTheDocument();
  expect(peekUndoable()).toBeUndefined();
  expect(calls.filter((c) => c.path === 'ai.undo').map((c) => c.input)).toEqual([
    { actionId: 'a' },
    { actionId: 'a', force: true },
  ]);
});
test('досыл прежде undo; двойное нажатие в полёте не теряет новую запись', async () => {
  const order: string[] = [];
  const unregister = registerBodyFlush('e1', async () => {
    order.push('flush');
    return 'saved';
  });
  pushUndoable({ actionId: 'a', title: 'Правка', entityIds: ['e1'] });
  let finish!: (value: unknown) => void;
  const { calls } = renderWithProviders(
    <>
      <Toaster />
      <Probe />
    </>,
    (path) => {
      if (path !== 'ai.undo') return {};
      order.push('undo');
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  chord();
  await waitFor(() => expect(order).toEqual(['flush', 'undo']));
  pushUndoable({ actionId: 'b', title: 'Новая', entityIds: [] });
  chord();
  await act(async () => {
    finish(outcome('a'));
  });
  expect(await screen.findByText('Отменено: a')).toBeInTheDocument();
  expect(peekUndoable()?.actionId).toBe('b');
  expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(1);
  unregister();
});
test('плашка кладёт одну запись и снимает только отменённую', async () => {
  renderWithProviders(<Toaster />, (path) => (path === 'ai.undo' ? outcome('a') : {}));
  act(() => offerUndo({ actionId: 'a', title: 'Правка', entityIds: [] }));
  expect(peekUndoable()).toEqual({ actionId: 'a', title: 'Правка', entityIds: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
  await screen.findByText('Отменено: a');
  expect(peekUndoable()).toBeUndefined();
});

import { resetUndoSession } from './undo-epoch';

test('auth смена во время lazy import не отправляет undo и не возвращает плашку', async () => {
  const { calls } = renderWithProviders(
    <>
      <Toaster />
      <Probe />
    </>,
    (path) => (path === 'ai.undo' ? outcome('old') : {}),
  );
  pushUndoable({ actionId: 'old', title: 'Старое', entityIds: [] });
  chord();
  resetUndoSession();
  pushUndoable({ actionId: 'new', title: 'Новое', entityIds: [] });
  await vi.dynamicImportSettled();
  expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(0);
  expect(peekUndoable()?.actionId).toBe('new');
  expect(screen.queryByText('Отменено: old')).not.toBeInTheDocument();
});
test('auth смена во время ответа и старого force не трогает новую запись', async () => {
  let finish!: (value: unknown) => void;
  let n = 0;
  const { calls } = renderWithProviders(
    <>
      <Toaster />
      <Probe />
    </>,
    (path) => {
      if (path !== 'ai.undo') return {};
      if (++n === 1)
        throw trpcError('CONFLICT', 'secret', {
          code: 'UNDO_TEXT_CHANGED',
          details: {
            action: { id: 'old', title: 'Старое' },
            continuation: { kind: 'here' },
            entries: [],
          },
        });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  pushUndoable({ actionId: 'old', title: 'Старое', entityIds: [] });
  chord();
  const button = await screen.findByRole('button', { name: CONTINUE_UNDO });
  fireEvent.click(button);
  await waitFor(() => expect(finish).toBeDefined());
  resetUndoSession();
  pushUndoable({ actionId: 'new', title: 'Новое', entityIds: [] });
  await act(async () => finish(outcome('old')));
  expect(peekUndoable()?.actionId).toBe('new');
  expect(screen.queryByText('Отменено: old')).not.toBeInTheDocument();
  fireEvent.click(button);
  expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(2);
});

test('force в полёте удерживает одну отмену и не перехватывает новую плашку продолжением', async () => {
  let finish!: (value: unknown) => void;
  let n = 0;
  const { calls } = renderWithProviders(
    <>
      <Toaster />
      <Probe />
    </>,
    (path) => {
      if (path !== 'ai.undo') return {};
      if (++n === 1)
        throw trpcError('CONFLICT', 'secret', {
          code: 'UNDO_TEXT_CHANGED',
          details: {
            action: { id: 'a', title: 'Правка' },
            continuation: { kind: 'here' },
            entries: [],
          },
        });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  pushUndoable({ actionId: 'a', title: 'Правка', entityIds: [] });
  chord();
  const button = await screen.findByRole('button', { name: CONTINUE_UNDO });
  fireEvent.click(button);
  fireEvent.click(button);
  chord();
  await waitFor(() => expect(finish).toBeDefined());
  expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(2);
  act(() => offerUndo({ actionId: 'b', title: 'Новое', entityIds: [] }));
  await act(async () => finish(outcome('a')));
  expect(peekUndoable()?.actionId).toBe('b');
  expect(screen.getByRole('button', { name: 'Отменить' })).toBeInTheDocument();
});

test('новая сессия может отменять пока ответ прежней сессии висит', async () => {
  const replies: Array<(value: unknown) => void> = [];
  const { calls } = renderWithProviders(
    <>
      <Toaster />
      <Probe />
    </>,
    (path) =>
      path === 'ai.undo'
        ? new Promise((resolve) => {
            replies.push(resolve);
          })
        : {},
  );
  pushUndoable({ actionId: 'old', title: 'Старое', entityIds: [] });
  chord();
  await waitFor(() => expect(replies).toHaveLength(1));
  resetUndoSession();
  pushUndoable({ actionId: 'new', title: 'Новое', entityIds: [] });
  chord();
  await waitFor(() => expect(replies).toHaveLength(2));
  await act(async () => replies[0]?.(outcome('old')));
  chord();
  expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(2);
  await act(async () => replies[1]?.(outcome('new')));
  expect(peekUndoable()).toBeUndefined();
  expect(screen.queryByText('Отменено: old')).not.toBeInTheDocument();
});
