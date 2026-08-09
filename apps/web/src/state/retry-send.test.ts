import { retryCreateId } from '@orbis/shared';
import { expect, test, vi } from 'vitest';
import type { QueuedCreate } from '../lib/retry-buffer';
import { trpcError } from '../test/harness';
import { makeRetrySend, mapSendError, SEND_TIMEOUT_MS } from './retry-send';

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
  // Второй аргумент — сигнал предела ожидания (см. SEND_TIMEOUT_MS): без него зависший
  // запрос заклинивал бы весь сериализованный слив.
  expect(mutate).toHaveBeenCalledWith(
    { input: { title: 'обед', tags: [], id: 'cid7' }, source: 'fast_path' },
    { signal: expect.any(AbortSignal) },
  );
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
  expect(mutate).toHaveBeenCalledWith(
    { input: { id: 'original-uuid', title: 'обед', tags: [] }, source: 'fast_path' },
    { signal: expect.any(AbortSignal) },
  );
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
test('makeRetrySend: CONFLICT → один повтор с ЗАМЕЩАЮЩИМ id → confirmed', async () => {
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
  // Детерминированная производная, а не случайный id: следующий flush после потерянного
  // ответа возьмёт ТОТ ЖЕ id и получит replay-успех вместо второй сущности.
  expect(second.input.id).toBe(retryCreateId('busy-uuid'));
  expect(second.input.title).toBe('обед');
});

test('makeRetrySend: повтор после потерянного ответа берёт ТОТ ЖЕ замещающий id', async () => {
  const seen: string[] = [];
  const mutate = vi.fn().mockImplementation((arg: { input: { id: string } }) => {
    seen.push(arg.input.id);
    if (arg.input.id === 'busy-uuid') return Promise.reject(trpcError('CONFLICT'));
    // Первый повтор «теряется» (сеть), второй — успех
    if (seen.filter((id) => id !== 'busy-uuid').length === 1) {
      return Promise.reject(new Error('network down'));
    }
    return Promise.resolve({ id: arg.input.id });
  });
  // biome-ignore lint/suspicious/noExplicitAny: мок vanilla-клиента tRPC для юнит-теста
  const client = { entity: { create: { mutate } } } as any;
  const send = makeRetrySend(client);
  const op: QueuedCreate = {
    clientId: 'c1',
    tool: 'entity.create',
    payload: { input: { id: 'busy-uuid', title: 'обед', tags: [] }, source: 'fast_path' },
    createdAt: 'now',
  };
  expect(await send(op)).toBe('transport_failure'); // остался в очереди — payload прежний
  expect(await send(op)).toBe('confirmed');
  const replacements = seen.filter((id) => id !== 'busy-uuid');
  expect(new Set(replacements).size).toBe(1); // один и тот же замещающий id, не два разных
  expect(replacements[0]).toBe(retryCreateId('busy-uuid'));
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

// Полуоткрытый сокет и captive portal дают промис, который не оседает НИКОГДА. Слив
// сериализован (state/retry.ts), поэтому такой промис глушил бы весь буфер до перезагрузки
// вместе с кнопкой досыла — единственным средством спасения.
test('makeRetrySend: зависшая отправка оседает по таймауту → transport_failure', async () => {
  vi.useFakeTimers();
  try {
    // Ответа не будет никогда — полуоткрытый сокет.
    const mutate = vi.fn(
      (_input: unknown, _options?: { signal: AbortSignal }) => new Promise(() => {}),
    );
    // biome-ignore lint/suspicious/noExplicitAny: мок vanilla-клиента tRPC для юнит-теста
    const client = { entity: { create: { mutate } } } as any;
    const send = makeRetrySend(client);
    const op: QueuedCreate = {
      clientId: 'c1',
      tool: 'entity.create',
      payload: { input: { title: 'обед', tags: [] }, source: 'fast_path' },
      createdAt: 'now',
    };
    const outcome = send(op);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);

    // transport_failure, а не потеря: запись остаётся в очереди и уйдёт следующим сливом.
    expect(await outcome).toBe('transport_failure');
    // И сокет разорван, а не оставлен висеть до конца сессии.
    const options = mutate.mock.calls[0]?.[1] as { signal: AbortSignal } | undefined;
    expect(options?.signal.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
