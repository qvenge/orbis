import { createRetryBuffer, type FlushOutcome } from './index';

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
