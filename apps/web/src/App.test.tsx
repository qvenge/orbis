import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { App } from './App';
import {
  frameHandler,
  HOME,
  resetFrame,
  stubLaunchMode,
  unstubLaunchMode,
} from './app/frame/frame-fixtures';
import { useRetryBuffer } from './state/retry';
import { queryReply, renderWithProviders } from './test/harness';

beforeEach(() => {
  stubLaunchMode('site');
  resetFrame('/');
});

afterEach(() => {
  unstubLaunchMode();
  resetFrame('/');
});

// Срез 1б §6.1–§6.2: нижнего ряда вкладок и сайдбара закреплённых больше нет — сверху присутствие
// хоста, внизу справа кнопки хоста. Сегодня рамка одна на телефон и десктоп (рейка и сайдбар —
// задача 25).
test('рамка: присутствие хоста сверху и кнопки хоста внизу; ни вкладок, ни закреплённых', async () => {
  renderWithProviders(<App />, (path) => (path === 'entity.query' ? queryReply([]) : {}));
  expect(await screen.findByTestId('host-presence')).toBeInTheDocument();
  expect(screen.getByTestId('host-buttons')).toBeInTheDocument();
  expect(screen.queryByRole('tab')).toBeNull();
  expect(screen.queryByText('Закреплённые')).toBeNull();
  expect(screen.queryByTestId('agenda-badge')).toBeNull();
});

// §1.5: бейдж очереди офлайн-записей — теперь на кнопке чата хоста (записи уходят из чата).
test('бейдж чата показывает размер retry-буфера и исчезает при опустошении', async () => {
  const op = useRetryBuffer.getState().enqueueCreate({ title: 'Тест', tags: [] }, 'fast_path');
  renderWithProviders(<App />);
  const buttons = await screen.findByTestId('host-buttons');
  expect(within(buttons).getByTestId('chat-badge')).toHaveTextContent('1');
  // Число — в доступном имени кнопки: иначе про очередь знает только зрячий.
  expect(within(buttons).getByRole('button', { name: 'Чат, 1 ждут отправки' })).toBeInTheDocument();

  act(() => {
    useRetryBuffer.getState().cancel(op.clientId);
  });
  expect(screen.queryByTestId('chat-badge')).toBeNull();
  expect(within(buttons).getByRole('button', { name: 'Чат' })).toBeInTheDocument();
});

test('product bootstrap starts deep-link data and registry while settings are pending', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  resetFrame(`/r/${id}`);
  const { calls } = renderWithProviders(<App gated />, (path) => {
    if (path === 'user.getSettings' || path === 'entity.get' || path === 'registry.effective')
      return new Promise(() => {});
    return {};
  });
  await waitFor(() => {
    expect(calls.map((call) => call.path)).toEqual(
      expect.arrayContaining(['user.getSettings', 'entity.get', 'registry.effective']),
    );
  });
  expect(calls.filter((call) => call.path === 'entity.get')).toEqual([
    { path: 'entity.get', input: expect.objectContaining({ id }) },
  ]);
  expect(screen.getByTestId('onboarding-splash')).toBeVisible();
  expect(screen.queryByTestId('host-buttons')).not.toBeInTheDocument();
});

test('the actual host shell can resolve and start the home detail while settings are pending', async () => {
  const frame = frameHandler();
  const { calls } = renderWithProviders(<App gated />, (path, input, type) => {
    if (path === 'user.getSettings') return new Promise(() => {});
    return frame(path, input, type);
  });
  await waitFor(() =>
    expect(calls).toContainEqual({
      path: 'entity.get',
      input: expect.objectContaining({ id: HOME, include: expect.arrayContaining(['bodyDoc']) }),
    }),
  );
  expect(screen.getByTestId('onboarding-splash')).toBeVisible();
});
