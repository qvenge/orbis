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

// --- Слив сериализован ------------------------------------------------------------------
// Триггеров слива несколько и они срабатывают подряд на плохой сети (useFastPath зовёт
// flushBuffer на КАЖДОМ транспортном сбое, плюс кнопка «Ждут отправки» и событие 'online').
// Цикл слива берёт снимок очереди один раз (lib/retry-buffer/index.ts) и удаляет запись
// только ПОСЛЕ await send(...), поэтому второй параллельный слив видел тот же снимок и слал
// всё заново.

test('два параллельных flushNow шлют каждую операцию ровно один раз', async () => {
  const sent: string[] = [];
  registerRetrySend(async (op) => {
    sent.push(op.clientId);
    // Отправка не мгновенна: без паузы слив всё равно уступил бы на await, но с ней
    // тест ближе к живой сети и не зависит от порядка микрозадач.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return 'confirmed';
  });
  const a = useRetryBuffer.getState().enqueueCreate({ title: 'a', tags: [] }, 'fast_path');
  const b = useRetryBuffer.getState().enqueueCreate({ title: 'b', tags: [] }, 'fast_path');

  await Promise.all([useRetryBuffer.getState().flushNow(), useRetryBuffer.getState().flushNow()]);

  expect(sent).toEqual([a.clientId, b.clientId]);
  expect(useRetryBuffer.getState().size).toBe(0);
});

// Сериализация не должна ронять запись, которая легла в очередь, пока слив шёл: именно так
// работает fast-path (enqueueCreate + сразу flushBuffer). Триггеров слива мало, и без
// доп. прохода такая запись ждала бы следующего.
test('flushNow добирает запись, положенную в очередь во время слива', async () => {
  const sent: string[] = [];
  let late: string | null = null;
  registerRetrySend(async (op) => {
    sent.push(op.clientId);
    if (!late) {
      late = useRetryBuffer
        .getState()
        .enqueueCreate({ title: 'поздняя', tags: [] }, 'fast_path').clientId;
    }
    return 'confirmed';
  });
  useRetryBuffer.getState().enqueueCreate({ title: 'первая', tags: [] }, 'fast_path');

  const confirmed = await useRetryBuffer.getState().flushNow();

  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(late);
  expect(confirmed).toBe(2);
  expect(useRetryBuffer.getState().size).toBe(0);
});

// Обратная сторона доп. прохода: когда сети нет, очередь не пустеет — цикл обязан
// остановиться, а не крутить отправку вечно.
test('flushNow не крутится вхолостую, когда сеть лежит', async () => {
  let attempts = 0;
  registerRetrySend(async () => {
    attempts += 1;
    return 'transport_failure';
  });
  useRetryBuffer.getState().enqueueCreate({ title: 'a', tags: [] }, 'fast_path');
  useRetryBuffer.getState().enqueueCreate({ title: 'b', tags: [] }, 'fast_path');

  expect(await useRetryBuffer.getState().flushNow()).toBe(0);
  expect(attempts).toBe(2);
  expect(useRetryBuffer.getState().size).toBe(2);
});
