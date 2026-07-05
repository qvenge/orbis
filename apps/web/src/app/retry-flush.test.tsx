import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { useNav } from '../state/navigation';
import { registerRetrySend, useRetryBuffer } from '../state/retry';
import { renderWithProviders } from '../test/harness';

// §2.6/§5.3: retry-буфер должен сливаться сам — на старте (онлайн) и при offline→online.
const appMocks = (path: string) => {
  if (path === 'chat.ensureThread') return { threadId: 't1' };
  if (path === 'chat.listMessages') return [];
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
