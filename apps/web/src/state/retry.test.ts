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

// Смешанный исход — главная ловушка доп. прохода: очередь укоротилась, но упавшая запись
// в ней осталась, и следующий проход обошёл бы ВСЮ очередь, переслав её. Так лишний
// трафик вернулся бы по другой оси: N записей, падающих по разу, дали бы порядка N²/2
// запросов вместо N. Проход добавляется только под НОВУЮ запись.
test('смешанный исход: упавшая запись не пересылается в том же сливе', async () => {
  const sent: string[] = [];
  const a = useRetryBuffer.getState().enqueueCreate({ title: 'упадёт', tags: [] }, 'fast_path');
  const b = useRetryBuffer.getState().enqueueCreate({ title: 'пройдёт', tags: [] }, 'fast_path');
  registerRetrySend(async (op) => {
    sent.push(op.clientId);
    return op.clientId === a.clientId ? 'transport_failure' : 'confirmed';
  });

  expect(await useRetryBuffer.getState().flushNow()).toBe(1);
  expect(sent).toEqual([a.clientId, b.clientId]);
  expect(useRetryBuffer.getState().size).toBe(1);
  expect(useRetryBuffer.getState().pending[0]?.clientId).toBe(a.clientId);
});

// То же на длине, где разница между N и N²/2 уже видна.
test('шесть записей, каждая падает по разу — ровно шесть отправок', async () => {
  const sent: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    useRetryBuffer.getState().enqueueCreate({ title: `op${i}`, tags: [] }, 'fast_path');
  }
  registerRetrySend(async (op) => {
    sent.push(op.clientId);
    return 'transport_failure';
  });

  await useRetryBuffer.getState().flushNow();

  expect(sent).toHaveLength(6);
  expect(useRetryBuffer.getState().size).toBe(6);
});

// Признак слива виден всему приложению, а не одному компоненту: кнопка досыла и автослив
// обязаны знать друг о друге. И он ОБЯЗАН сниматься — иначе кнопка гаснет навсегда.
test('flushing поднят на время слива и снят после', async () => {
  let release!: (outcome: 'confirmed') => void;
  registerRetrySend(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  useRetryBuffer.getState().enqueueCreate({ title: 'долгая', tags: [] }, 'fast_path');
  expect(useRetryBuffer.getState().flushing).toBe(false);

  const flush = useRetryBuffer.getState().flushNow();
  expect(useRetryBuffer.getState().flushing).toBe(true);

  release('confirmed');
  await flush;
  expect(useRetryBuffer.getState().flushing).toBe(false);
});
