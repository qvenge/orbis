import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { App } from './App';
import { resetFrame, stubLaunchMode, unstubLaunchMode } from './app/frame/frame-fixtures';
import { useRetryBuffer } from './state/retry';
import { renderWithProviders } from './test/harness';

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
  renderWithProviders(<App />, (path) => (path === 'entity.query' ? [] : {}));
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
