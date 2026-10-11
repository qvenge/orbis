import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { useDetailedUpdateBatch, useUpdateBatch } from '../features/page/useUpdateBatch';
import { resetUndoSession } from '../features/undo/undo-epoch';
import { renderWithProviders, trpcError, wireEntity } from '../test/harness';
import { trpc } from '../trpc';
import { useToastStore } from '../ui/toast-store';
import { useGraphUndo } from './useGraphUndo';

const actionId = '00000000-0000-4000-8000-000000000100';
const undoResult = {
  actionId: 'undo-receipt',
  undone: { id: actionId, title: 'Записано' },
  pinnedVersions: [],
  bodyRevisions: [],
};
beforeEach(() => resetUndoSession());
afterEach(() => {
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
});
function UndoHost() {
  const [visible, setVisible] = useState(true);
  return (
    <>
      {visible && <UndoProbe />}
      <button type="button" onClick={() => setVisible(false)}>
        Закрыть форму
      </button>
    </>
  );
}
function UndoProbe() {
  const undo = useGraphUndo();
  return (
    <button type="button" onClick={() => undo(actionId, 'Записано')}>
      Тост
    </button>
  );
}
test('confirmed action exposes Undo, whose vanilla write survives unmount', async () => {
  const { calls } = renderWithProviders(<UndoHost />, (path) =>
    path === 'ai.undo' ? undoResult : {},
  );
  fireEvent.click(screen.getByText('Тост'));
  await waitFor(() =>
    expect(useToastStore.getState().toasts.at(-1)?.action?.label).toBe('Отменить'),
  );
  const toast = useToastStore.getState().toasts.at(-1);
  expect(toast?.title).toBe('Записано');
  expect(toast?.action?.label).toBe('Отменить');
  fireEvent.click(screen.getByText('Закрыть форму'));
  act(() => toast?.action?.onSelect());
  await waitFor(() => expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(1));
  expect(calls.find((c) => c.path === 'ai.undo')?.input).toEqual({ actionId });
});
test.each([
  ['CONFLICT', 'Новое изменение не позволяет отмену', 'Не удалось отменить изменения'],
  ['INTERNAL_SERVER_ERROR', 'SQL private details', 'Не удалось отменить изменения'],
  ['SERVICE_UNAVAILABLE', 'unavailable', 'Не удалось отменить изменения'],
])('Undo %s shows its safe outcome without automatic retry', async (code, message, expected) => {
  const { calls } = renderWithProviders(<UndoProbe />, (path) => {
    if (path === 'ai.undo') throw trpcError(code, message);
    return {};
  });
  fireEvent.click(screen.getByText('Тост'));
  await waitFor(() =>
    expect(useToastStore.getState().toasts.at(-1)?.action?.label).toBe('Отменить'),
  );
  act(() => useToastStore.getState().toasts.at(-1)?.action?.onSelect());
  await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.title).toBe(expected));
  expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(1);
  expect(useToastStore.getState().toasts.at(-1)?.action).toBeUndefined();
});
test('double Undo selection during flight is a single mutation', async () => {
  let finish: ((value: unknown) => void) | undefined;
  const { calls } = renderWithProviders(<UndoProbe />, (path) =>
    path === 'ai.undo'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : {},
  );
  fireEvent.click(screen.getByText('Тост'));
  await waitFor(() =>
    expect(useToastStore.getState().toasts.at(-1)?.action?.label).toBe('Отменить'),
  );
  const select = useToastStore.getState().toasts.at(-1)?.action?.onSelect;
  act(() => {
    select?.();
    select?.();
  });
  await waitFor(() => expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(1));
  await act(async () => finish?.(undoResult));
});
function BatchProbe({ detailed = false }: { detailed?: boolean }) {
  const run = useUpdateBatch();
  const detail = useDetailedUpdateBatch();
  const [outcome, setOutcome] = useState<unknown>();
  const operations = [
    {
      tool: 'entity_update' as const,
      input: { id: '00000000-0000-4000-8000-000000000010', props: { 'user/name': 'Новое' } },
    },
  ];
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void (
            detailed
              ? detail(operations, { action: 'Жест' })
              : run(operations, 'Готово', {
                  action: 'Жест',
                  failed: 'Старый отказ',
                  undoFailed: 'Старая отмена',
                })
          ).then(setOutcome)
        }
      >
        Записать
      </button>
      <output>{JSON.stringify(outcome)}</output>
    </>
  );
}
test('legacy boolean wrapper uses one detailed path, action label and the prior success toast', async () => {
  const { calls } = renderWithProviders(<BatchProbe />, (path) =>
    path === 'entity.updateBatch' ? { actionId, consequences: false } : {},
  );
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() => expect(screen.getByText('true')).toBeInTheDocument());
  expect(calls.filter((c) => c.path === 'entity.updateBatch')).toHaveLength(1);
  expect(calls.find((c) => c.path === 'entity.updateBatch')?.input).toMatchObject({
    label: 'Жест',
  });
  await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Готово'));
  expect(useToastStore.getState().toasts.at(-1)?.action?.label).toBe('Отменить');
});
test('legacy boolean refusal keeps its custom generic failure toast and false outcome', async () => {
  renderWithProviders(<BatchProbe />, (path) => {
    if (path === 'entity.updateBatch') throw trpcError('CONFLICT', 'Публичная причина');
    return {};
  });
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() => expect(screen.getByText('false')).toBeInTheDocument());
  expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Старый отказ');
  expect(useToastStore.getState().toasts.at(-1)?.action).toBeUndefined();
});
test('legacy custom Undo failure title is preserved', async () => {
  renderWithProviders(<BatchProbe />, (path) => {
    if (path === 'entity.updateBatch') return { actionId, consequences: false };
    if (path === 'ai.undo') throw trpcError('CONFLICT', 'Публичная причина');
    return {};
  });
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() => expect(screen.getByText('true')).toBeInTheDocument());
  await waitFor(() =>
    expect(useToastStore.getState().toasts.at(-1)?.action?.label).toBe('Отменить'),
  );
  act(() => useToastStore.getState().toasts.at(-1)?.action?.onSelect());
  await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Старая отмена'));
});
test('detailed path returns rejection for the form without a generic toast', async () => {
  renderWithProviders(<BatchProbe detailed />, (path) => {
    if (path === 'entity.updateBatch') throw trpcError('CONFLICT', 'Публичная причина');
    return {};
  });
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() =>
    expect(
      screen.getByText('{"kind":"rejected","message":"Публичная причина"}'),
    ).toBeInTheDocument(),
  );
  expect(useToastStore.getState().toasts).toEqual([]);
});
test('current boolean no-journal response is successful and has no success toast or Undo', async () => {
  renderWithProviders(<BatchProbe />, (path) => (path === 'entity.updateBatch' ? {} : {}));
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() => expect(screen.getByText('true')).toBeInTheDocument());
  expect(useToastStore.getState().toasts).toEqual([]);
});

function RefreshedRead() {
  const read = trpc.entity.get.useQuery({ id: '00000000-0000-4000-8000-000000000010' });
  return <output data-testid="current-read">{read.data?.entity.title}</output>;
}
test.each([
  'CONFLICT',
  'INTERNAL_SERVER_ERROR',
])('Undo %s refreshes cached remote data even on non-confirmation', async (code) => {
  let title = 'До';
  renderWithProviders(
    <>
      <UndoProbe />
      <RefreshedRead />
    </>,
    (path) => {
      if (path === 'ai.undo') {
        title = 'После отказа';
        throw trpcError(code, 'Отмена недоступна');
      }
      if (path === 'entity.get')
        return { entity: wireEntity({ id: '00000000-0000-4000-8000-000000000010', title }) };
      return {};
    },
    { queries: { staleTime: Infinity } },
  );
  await waitFor(() => expect(screen.getByTestId('current-read')).toHaveTextContent('До'));
  fireEvent.click(screen.getByText('Тост'));
  await waitFor(() =>
    expect(useToastStore.getState().toasts.at(-1)?.action?.label).toBe('Отменить'),
  );
  act(() => useToastStore.getState().toasts.at(-1)?.action?.onSelect());
  await waitFor(() => expect(screen.getByTestId('current-read')).toHaveTextContent('После отказа'));
});
test('detailed known refusal refreshes stale entity data without clearing form outcome', async () => {
  let title = 'До';
  renderWithProviders(
    <>
      <BatchProbe detailed />
      <RefreshedRead />
    </>,
    (path) => {
      if (path === 'entity.updateBatch') {
        title = 'После отказа';
        throw trpcError('CONFLICT', 'Состояние изменилось');
      }
      if (path === 'entity.get')
        return { entity: wireEntity({ id: '00000000-0000-4000-8000-000000000010', title }) };
      return {};
    },
    { queries: { staleTime: Infinity } },
  );
  await waitFor(() => expect(screen.getByTestId('current-read')).toHaveTextContent('До'));
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() => expect(screen.getByTestId('current-read')).toHaveTextContent('После отказа'));
  expect(
    screen.getByText('{"kind":"rejected","message":"Состояние изменилось"}'),
  ).toBeInTheDocument();
  expect(useToastStore.getState().toasts).toEqual([]);
});
