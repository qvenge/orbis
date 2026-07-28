import { expect, test, vi } from 'vitest';
import type { QueuedCreate } from '../lib/retry-buffer';
import { trpcError } from '../test/harness';
import { makeRetrySend, mapSendError } from './retry-send';

// Уборочная фаза (решение 7): прежняя конвенция «CONFLICT = подтверждённый успех»
// противоречила серверу — честный повтор владельца с тем же id executor отдаёт
// replay-УСПЕХОМ (стадия 5 entity_create вне batch), а CONFLICT кидается ровно тогда,
// когда id занят невидимой под RLS чужой строкой: записи владельца на сервере НЕТ.
test('mapSendError: CONFLICT → business_rejection (успех не фабрикуем, повтор бесполезен)', () => {
  expect(mapSendError(trpcError('CONFLICT'))).toBe('business_rejection');
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

// §5.3: если payload несёт id (create, уже отправлявшийся серверу), шлём именно его —
// clientId очереди тут вторичен, иначе повтор создаст вторую сущность.
test('makeRetrySend: id из payload имеет приоритет над clientId', async () => {
  const mutate = vi.fn().mockResolvedValue({ id: 'x' });
  // biome-ignore lint/suspicious/noExplicitAny: мок vanilla-клиента tRPC для юнит-теста
  const client = { entity: { create: { mutate } } } as any;
  const send = makeRetrySend(client);
  const op: QueuedCreate = {
    clientId: 'cid7',
    tool: 'entity.create',
    payload: { input: { id: 'original-uuid', title: 'обед', tags: [] }, source: 'fast_path' },
    createdAt: 'now',
  };
  expect(await send(op)).toBe('confirmed');
  expect(mutate).toHaveBeenCalledWith({
    input: { id: 'original-uuid', title: 'обед', tags: [] },
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

// Ввод при этом не теряется — ради чего буфер и существует: перед тем как признать отказ,
// makeRetrySend делает РОВНО одну попытку со свежим UUID.
test('makeRetrySend: CONFLICT → один повтор со свежим id → confirmed', async () => {
  const mutate = vi
    .fn()
    .mockRejectedValueOnce(trpcError('CONFLICT'))
    .mockResolvedValueOnce({ id: 'x' });
  // biome-ignore lint/suspicious/noExplicitAny: мок vanilla-клиента tRPC для юнит-теста
  const client = { entity: { create: { mutate } } } as any;
  const send = makeRetrySend(client);
  const op: QueuedCreate = {
    clientId: 'c1',
    tool: 'entity.create',
    payload: { input: { id: 'busy-uuid', title: 'обед', tags: [] }, source: 'fast_path' },
    createdAt: 'now',
  };
  expect(await send(op)).toBe('confirmed');
  expect(mutate).toHaveBeenCalledTimes(2);
  const second = mutate.mock.calls[1]?.[0] as { input: { id: string; title: string } };
  expect(second.input.id).not.toBe('busy-uuid');
  expect(second.input.title).toBe('обед');
});

test('makeRetrySend: второй CONFLICT подряд → business_rejection (без бесконечного цикла)', async () => {
  const mutate = vi.fn().mockRejectedValue(trpcError('CONFLICT'));
  // biome-ignore lint/suspicious/noExplicitAny: мок vanilla-клиента tRPC для юнит-теста
  const client = { entity: { create: { mutate } } } as any;
  const send = makeRetrySend(client);
  const op: QueuedCreate = {
    clientId: 'c1',
    tool: 'entity.create',
    payload: { input: { title: 'обед', tags: [] }, source: 'fast_path' },
    createdAt: 'now',
  };
  expect(await send(op)).toBe('business_rejection');
  expect(mutate).toHaveBeenCalledTimes(2);
});

test('makeRetrySend: транспортный сбой повтора со свежим id не делает', async () => {
  const mutate = vi.fn().mockRejectedValue(new Error('network down'));
  // biome-ignore lint/suspicious/noExplicitAny: мок vanilla-клиента tRPC для юнит-теста
  const client = { entity: { create: { mutate } } } as any;
  const send = makeRetrySend(client);
  const op: QueuedCreate = {
    clientId: 'c1',
    tool: 'entity.create',
    payload: { input: { id: 'same-uuid', title: 'обед', tags: [] }, source: 'fast_path' },
    createdAt: 'now',
  };
  expect(await send(op)).toBe('transport_failure');
  expect(mutate).toHaveBeenCalledTimes(1); // тот же id уходит следующим flush'ем
});
