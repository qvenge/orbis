import { expect, test, vi } from 'vitest';
import { useToastStore } from '../../ui/toast-store';
import { offerUndoLazy } from './undo-lazy';

test('старый lazy import не вытесняет новое действие, появившееся до загрузки', async () => {
  for (const t of useToastStore.getState().toasts) useToastStore.getState().dismiss(t.id);
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  vi.doMock('./undo-toast', async () => {
    await wait;
    return {
      offerUndo: (o: { title: string }) =>
        useToastStore
          .getState()
          .show(o.title, 'default', { label: 'Отменить', onSelect: () => {} }),
    };
  });
  offerUndoLazy({ title: 'Старое', actionId: 'old' });
  useToastStore.getState().show('Новое', 'default', { label: 'Отменить', onSelect: () => {} });
  release();
  await import('./undo-toast');
  await Promise.resolve();
  expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['Новое']);
  vi.doUnmock('./undo-toast');
});

import { resetUndoSession } from './undo-epoch';
import { peekUndoable } from './undo-stack';

test('lazy offer прежнего владельца не возвращает действие после стирания', async () => {
  offerUndoLazy({ title: 'Предыдущий владелец', actionId: 'old' });
  resetUndoSession();
  await vi.dynamicImportSettled();
  expect(peekUndoable()).toBeUndefined();
  expect(useToastStore.getState().toasts).toHaveLength(0);
});

test('две успешные lazy offers сохраняют обе записи, даже если первая плашка уступила новой', async () => {
  offerUndoLazy({ title: 'Первое действие', actionId: 'first', entityIds: [] });
  offerUndoLazy({ title: 'Второе действие', actionId: 'second', entityIds: ['e1'] });
  expect(peekUndoable()?.actionId).toBe('second');
  dropUndoable('second');
  expect(peekUndoable()?.actionId).toBe('first');
  await vi.dynamicImportSettled();
});

import { dropUndoable } from './undo-stack';
