import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { renderWithProviders, trpcError } from '../../test/harness';
import { Toaster } from '../../ui/Toast';
import { useToastStore } from '../../ui/toast-store';

beforeEach(() => {
  for (const t of useToastStore.getState().toasts) useToastStore.getState().dismiss(t.id);
});

import { CONTINUE_UNDO, offerUndo, reportUndoOutcome } from './undo-toast';

const details = {
  action: { id: 'a1', title: 'Правка агента' },
  continuation: { kind: 'here' as const },
  entries: [
    {
      entityId: 'e1',
      title: 'Заметка',
      actorKind: 'owner' as const,
      actorLabel: null,
      at: new Date().toISOString(),
    },
  ],
};
test('причина с продолжением, один force запрос и подпись страховочной версии', async () => {
  let count = 0;
  const { calls } = renderWithProviders(<Toaster />, (path) => {
    if (path !== 'ai.undo') return {};
    if (++count === 1)
      throw trpcError('CONFLICT', 'сырой секрет', { code: 'UNDO_TEXT_CHANGED', details });
    return {
      actionId: 'u1',
      undone: { id: 'a1', title: 'Правка агента' },
      pinnedVersions: [{ entityId: 'e1', versionId: 'v1', label: 'перед отменой: Правка агента' }],
      bodyRevisions: [],
    };
  });
  act(() => offerUndo({ title: 'Правка агента', actionId: 'a1', entityIds: [] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
  expect(
    await screen.findByText(/^Текст изменён после этой правки: вы, \d{2}:\d{2}$/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: CONTINUE_UNDO }));
  expect(await screen.findByText('Отменено: Правка агента')).toBeInTheDocument();
  expect(
    screen.getByText('ваш текст — в версии «перед отменой: Правка агента» (Детали → Версии)'),
  ).toBeInTheDocument();
  expect(calls.filter((c) => c.path === 'ai.undo').map((c) => c.input)).toEqual([
    { actionId: 'a1' },
    { actionId: 'a1', force: true },
  ]);
});
test('нет места продолжения — нет кнопки; actorLabel и несколько записей видны', () => {
  renderWithProviders(<Toaster />, () => ({}));
  act(() =>
    reportUndoOutcome(
      {
        kind: 'refused',
        details: {
          ...details,
          continuation: { kind: 'none' },
          entries: [
            details.entries[0]!,
            { ...details.entries[0]!, entityId: 'e2', title: 'План', actorLabel: 'Телефон' },
          ],
        },
      },
      () => {},
    ),
  );
  expect(screen.queryByRole('button', { name: CONTINUE_UNDO })).toBeNull();
  expect(screen.getByText(/записей: 2/)).toBeInTheDocument();
  expect(screen.getByText('«Заметка», «План»')).toBeInTheDocument();
});

test('поздний отказ старой отмены не вытесняет предложение следующей правки', async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  renderWithProviders(<Toaster />, async (path) => {
    if (path === 'ai.undo') {
      await wait;
      throw trpcError('CONFLICT', 'отказ', { code: 'UNDO_TEXT_CHANGED', details });
    }
    return {};
  });
  act(() => offerUndo({ title: 'Первая правка', actionId: 'a1', entityIds: [] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
  act(() => offerUndo({ title: 'Следующая правка', actionId: 'a2', entityIds: [] }));
  await act(async () => {
    release();
    await wait;
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(await screen.findByText(/^Текст изменён после этой правки:/)).toBeInTheDocument();
  expect(screen.getByText('Следующая правка')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: CONTINUE_UNDO })).toBeNull();
  expect(screen.getByText(/^Текст изменён после этой правки:/)).toBeInTheDocument();
});
