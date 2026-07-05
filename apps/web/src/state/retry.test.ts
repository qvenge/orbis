import { beforeEach, expect, test } from 'vitest';
import { registerRetrySend, useRetryBuffer } from './retry';

beforeEach(() => {
  localStorage.clear();
  // сброс подписанного send между тестами
  registerRetrySend(async () => 'transport_failure');
});

test('enqueueCreate увеличивает size и pending (бейдж-счётчик)', () => {
  useRetryBuffer.getState().enqueueCreate({ title: 'обед', tags: [] }, 'fast_path');
  expect(useRetryBuffer.getState().size).toBe(1);
  expect(useRetryBuffer.getState().pending).toHaveLength(1);
});

test('cancel убирает операцию из буфера', () => {
  const op = useRetryBuffer.getState().enqueueCreate({ title: 'x', tags: [] }, 'fast_path');
  useRetryBuffer.getState().cancel(op.clientId);
  expect(useRetryBuffer.getState().size).toBe(0);
});

test('flushNow: confirmed удаляет; transport_failure оставляет', async () => {
  registerRetrySend(async () => 'confirmed');
  useRetryBuffer.getState().enqueueCreate({ title: 'a', tags: [] }, 'fast_path');
  await useRetryBuffer.getState().flushNow();
  expect(useRetryBuffer.getState().size).toBe(0);

  registerRetrySend(async () => 'transport_failure');
  useRetryBuffer.getState().enqueueCreate({ title: 'b', tags: [] }, 'fast_path');
  await useRetryBuffer.getState().flushNow();
  expect(useRetryBuffer.getState().size).toBe(1);
});
