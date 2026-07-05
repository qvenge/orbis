import { expect, test, vi } from 'vitest';
import type { QueuedCreate } from '../lib/retry-buffer';
import { trpcError } from '../test/harness';
import { makeRetrySend, mapSendError } from './retry-send';

test('mapSendError: CONFLICT (id_conflict) → confirmed (идемпотентно)', () => {
  expect(mapSendError(trpcError('CONFLICT'))).toBe('confirmed');
});

test('mapSendError: бизнес-коды → business_rejection', () => {
  expect(mapSendError(trpcError('BAD_REQUEST'))).toBe('business_rejection');
  expect(mapSendError(trpcError('UNPROCESSABLE_CONTENT'))).toBe('business_rejection');
  expect(mapSendError(trpcError('TOO_MANY_REQUESTS'))).toBe('business_rejection');
  expect(mapSendError(trpcError('FORBIDDEN'))).toBe('business_rejection');
  expect(mapSendError(trpcError('NOT_FOUND'))).toBe('business_rejection');
});

test('mapSendError: сеть/неизвестное → transport_failure', () => {
  expect(mapSendError(new Error('network down'))).toBe('transport_failure');
  expect(mapSendError(trpcError('INTERNAL_SERVER_ERROR'))).toBe('transport_failure');
});

test('makeRetrySend: успешный create → confirmed; шлёт id=clientId и source', async () => {
  const mutate = vi.fn().mockResolvedValue({ id: 'x' });
  // biome-ignore lint/suspicious/noExplicitAny: мок vanilla-клиента tRPC для юнит-теста
  const client = { entity: { create: { mutate } } } as any;
  const send = makeRetrySend(client);
  const op: QueuedCreate = {
    clientId: 'cid7',
    tool: 'entity.create',
    payload: { input: { title: 'обед', tags: [] }, source: 'fast_path' },
    createdAt: 'now',
  };
  expect(await send(op)).toBe('confirmed');
  expect(mutate).toHaveBeenCalledWith({
    input: { title: 'обед', tags: [], id: 'cid7' },
    source: 'fast_path',
  });
});

test('makeRetrySend: ошибка мапится через mapSendError', async () => {
  const mutate = vi.fn().mockRejectedValue(trpcError('BAD_REQUEST'));
  // biome-ignore lint/suspicious/noExplicitAny: мок vanilla-клиента tRPC для юнит-теста
  const client = { entity: { create: { mutate } } } as any;
  const send = makeRetrySend(client);
  const op: QueuedCreate = {
    clientId: 'c1',
    tool: 'entity.create',
    payload: { input: { title: 't', tags: [] }, source: 'fast_path' },
    createdAt: 'now',
  };
  expect(await send(op)).toBe('business_rejection');
});
