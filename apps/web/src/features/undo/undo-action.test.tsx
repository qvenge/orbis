import { act } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders, trpcError } from '../../test/harness';
import { Toaster } from '../../ui/Toast';
import { registerBodyFlush } from '../entity-editor/body-flush';
import { runUndo, UNDO_BODY_BLOCKED, UNDO_FAILED, UNDO_OFFLINE } from './undo-action';

const result = {
  actionId: 'u1',
  undone: { id: 'a1', title: 'Правка' },
  pinnedVersions: [],
  bodyRevisions: [],
};
test('досыл раньше undo, [] пропускает тела, force проходит тем же путём', async () => {
  const order: string[] = [];
  const remove = registerBodyFlush('e1', async () => {
    order.push('flush:e1');
    return 'saved';
  });
  const { calls } = renderWithProviders(<Toaster />, (path) => {
    order.push(path);
    return result;
  });
  await act(async () => {
    expect(await runUndo('a1', { entityIds: ['e1'] })).toEqual({ kind: 'undone', result });
  });
  expect(order.slice(0, 2)).toEqual(['flush:e1', 'ai.undo']);
  order.length = 0;
  await act(async () => {
    await runUndo('a1', { entityIds: [], force: true });
  });
  expect(order[0]).toBe('ai.undo');
  expect(calls.filter((c) => c.path === 'ai.undo').at(-1)?.input).toEqual({
    actionId: 'a1',
    force: true,
  });
  remove();
});
for (const [state, message] of [
  ['blocked', UNDO_BODY_BLOCKED],
  ['offline', UNDO_OFFLINE],
] as const)
  test(`${state}: запроса нет`, async () => {
    const remove = registerBodyFlush('e1', async () => state);
    const { calls } = renderWithProviders(<Toaster />, () => result);
    expect(await runUndo('a1')).toEqual({ kind: 'failed', message });
    expect(calls).toEqual([]);
    remove();
  });
test('структурный отказ, already и безопасный общий сбой', async () => {
  let error: unknown = trpcError('BAD_REQUEST', 'служебный текст', {
    code: 'VALIDATION',
    details: { reason: 'already_undone' },
  });
  renderWithProviders(<Toaster />, () => {
    throw error;
  });
  expect(await runUndo('a1', { entityIds: [] })).toEqual({ kind: 'already' });
  error = new Error('секрет сервера');
  expect(await runUndo('a1', { entityIds: [] })).toEqual({ kind: 'failed', message: UNDO_FAILED });
});

test('multi-ID blocked освобождает уже взятый затвор, committed undo не меняется от чтения', async () => {
  const finishes: Array<number | undefined> = [];
  const a = registerBodyFlush(
    'a',
    async () => 'saved',
    () => 3,
    () => (r) => {
      finishes.push(r);
    },
  );
  const b = registerBodyFlush('b', async () => 'blocked');
  const { calls } = renderWithProviders(<Toaster />, () => result);
  expect(await runUndo('a1', { entityIds: ['a', 'b'] })).toEqual({
    kind: 'failed',
    message: UNDO_BODY_BLOCKED,
  });
  expect(finishes).toEqual([undefined]);
  expect(calls).toEqual([]);
  a();
  b();
});
