import { createRetryBuffer, type FlushOutcome } from './index';
import type { QueueStorage } from './storage';

function memStorage(): QueueStorage {
  let items: ReturnType<QueueStorage['load']> = [];
  return {
    load: () => items,
    save: (v) => {
      items = v;
    },
  };
}

test('enqueue кладёт запись в очередь; flush(confirmed) удаляет её', async () => {
  const buffer = createRetryBuffer();
  const queued = buffer.enqueue({ tool: 'entity_create', payload: { title: 'Обед 340' } });
  expect(buffer.size()).toBe(1);
  expect(queued.clientId).toBeTruthy();

  await buffer.flush(async () => 'confirmed');

  expect(buffer.size()).toBe(0);
});

test('transport_failure оставляет запись в очереди; business_rejection удаляет её с ошибкой', async () => {
  const buffer = createRetryBuffer();
  buffer.enqueue({ tool: 'entity_create', payload: { title: 'A' } }); // получит transport_failure
  buffer.enqueue({ tool: 'entity_create', payload: { title: 'B' } }); // получит business_rejection

  const outcomes: FlushOutcome[] = ['transport_failure', 'business_rejection'];
  await buffer.flush(async () => outcomes.shift() ?? 'confirmed'); // noUncheckedIndexedAccess-safe

  expect(buffer.size()).toBe(1); // осталась только transport_failure-запись, ретраится следующим flush()
});

test('enqueue генерирует UUIDv7 clientId (версия-нибл = 7)', () => {
  const buf = createRetryBuffer(memStorage());
  const op = buf.enqueue({ tool: 'entity.create', payload: {} });
  // UUIDv7: 15-й символ (индекс 14) = '7'
  expect(op.clientId[14]).toBe('7');
  expect(op.clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i);
});
