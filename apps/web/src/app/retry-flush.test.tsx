import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { useNav } from '../state/navigation';
import { registerRetrySend, useRetryBuffer } from '../state/retry';
import { renderWithProviders } from '../test/harness';
import { trpc } from '../trpc';

// §2.6/§5.3: retry-буфер должен сливаться сам — на старте (онлайн) и при offline→online.
const appMocks = (path: string) => {
  if (path === 'chat.ensureThread') return { threadId: 't1' };
  if (path === 'chat.listMessages') return [];
  // Бейдж Agenda (§1.5) смонтирован на любом экране в обеих поверхностях навигации,
  // поэтому App всегда шлёт entity.query — контракт процедуры массив, не {}.
  if (path === 'entity.query') return [];
  return {};
};

const setOnline = (value: boolean) =>
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });

beforeEach(() => {
  localStorage.clear();
  useRetryBuffer.setState({ size: 0, pending: [] });
  useNav.setState({ activeTab: 'chat', stacks: { chat: [], browser: [], agenda: [], budget: [] } });
  setOnline(true);
});
afterEach(() => {
  localStorage.clear();
  setOnline(true);
});

test('старт при онлайне с непустым буфером → автослив (drain)', async () => {
  const send = vi.fn(async () => 'confirmed' as const);
  registerRetrySend(send);
  useRetryBuffer.getState().enqueueCreate({ title: 'x', tags: [] }, 'fast_path');
  expect(useRetryBuffer.getState().size).toBe(1);

  renderWithProviders(<App />, appMocks);

  // Без стартового flush в useRetryFlush size остался бы 1, а send не вызывался бы (не тавтология).
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(useRetryBuffer.getState().size).toBe(0));
});

test('переход offline→online (window "online") → автослив непустого буфера', async () => {
  const send = vi.fn(async () => 'confirmed' as const);
  registerRetrySend(send);

  // Кладём в буфер, будучи офлайн, чтобы стартовый flush НЕ сработал — проверяем именно подписку.
  setOnline(false);
  useRetryBuffer.getState().enqueueCreate({ title: 'y', tags: [] }, 'fast_path');
  expect(useRetryBuffer.getState().size).toBe(1);

  renderWithProviders(<App />, appMocks);
  // Офлайн на старте → стартовый flush пропущен, send пока не звался.
  expect(send).not.toHaveBeenCalled();

  setOnline(true);
  await act(async () => {
    window.dispatchEvent(new Event('online'));
  });

  // Без подписки на 'online' в useRetryFlush событие ничего бы не дренировало (не тавтология).
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(useRetryBuffer.getState().size).toBe(0));
});

// --- Р17 (круг правок 2): слив буфера — единственный путь записи МИМО React Query -------
// Операции уходят vanilla-клиентом, mutation-хука у них нет, и до этой правки после
// «писал офлайн, вернулся в сеть» запись ложилась на сервер, а список на экране её не
// показывал. Пробник держит все три ключа графа — включая entity.count (бейджи
// закреплённых smart-list'ов).

function GraphProbe() {
  trpc.entity.get.useQuery({ id: 'e1' });
  trpc.entity.count.useQuery({ query: 'aspect=orbis/task' });
  return null;
}

/** Слив по событию 'online' с заданным исходом отправки; возвращает счётчик вызовов. */
async function flushWithOutcome(outcome: 'confirmed' | 'business_rejection') {
  const send = vi.fn(async () => outcome);
  registerRetrySend(send);
  setOnline(false);
  useRetryBuffer.getState().enqueueCreate({ title: 'офлайн-запись', tags: [] }, 'fast_path');

  const { calls } = renderWithProviders(
    <>
      <App />
      <GraphProbe />
    </>,
    appMocks,
  );
  // Ждём первого чтения каждого ключа, иначе «прибавилось» считалось бы от нуля.
  await waitFor(() => {
    expect(calls.some((c) => c.path === 'entity.get')).toBe(true);
    expect(calls.some((c) => c.path === 'entity.count')).toBe(true);
  });
  const before = (path: string) => calls.filter((c) => c.path === path).length;
  const snapshot = {
    query: before('entity.query'),
    get: before('entity.get'),
    count: before('entity.count'),
  };

  setOnline(true);
  await act(async () => {
    window.dispatchEvent(new Event('online'));
  });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  return { calls, snapshot, after: before };
}

test('подтверждённый слив буфера перечитывает граф целиком (query + get + count)', async () => {
  const { snapshot, after } = await flushWithOutcome('confirmed');
  await waitFor(() => {
    expect(after('entity.query')).toBeGreaterThan(snapshot.query);
    expect(after('entity.get')).toBeGreaterThan(snapshot.get);
    expect(after('entity.count')).toBeGreaterThan(snapshot.count);
  });
});

// Инвалидация висит на ПОДТВЕРЖДЁННОМ успехе, а не на попытке: бизнес-отказ очередь тоже
// чистит, но графа не меняет — перечит по нему маскировал бы отказ видимостью работы.
test('отклонённая сервером операция граф не перечитывает', async () => {
  const { snapshot, after } = await flushWithOutcome('business_rejection');
  await waitFor(() => expect(useRetryBuffer.getState().size).toBe(0));
  expect(after('entity.query')).toBe(snapshot.query);
  expect(after('entity.get')).toBe(snapshot.get);
  expect(after('entity.count')).toBe(snapshot.count);
});
