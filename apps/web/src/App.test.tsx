import { act, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { App } from './App';
import { useRetryBuffer } from './state/retry';
import { renderWithProviders } from './test/harness';

test('рендерит 4 таба, Agenda/Budget задизейблены', () => {
  // App живёт под trpc.Provider (main.tsx); дефолтный таб chat рендерит ChatScreen → нужен контекст.
  renderWithProviders(<App />);
  expect(screen.getByTestId('tab-chat')).toBeEnabled();
  expect(screen.getByTestId('tab-browser')).toBeEnabled();
  expect(screen.getByTestId('tab-agenda')).toBeDisabled();
  expect(screen.getByTestId('tab-budget')).toBeDisabled();
});

// §1.5: бейдж Chat реактивно отражает размер retry-буфера (пусто → нет бейджа).
test('бейдж Chat показывает размер retry-буфера и исчезает при опустошении', () => {
  const op = useRetryBuffer.getState().enqueueCreate({ title: 'Тест', tags: [] }, 'fast_path');
  renderWithProviders(<App />);
  expect(screen.getByTestId('chat-badge')).toHaveTextContent('1');

  act(() => {
    useRetryBuffer.getState().cancel(op.clientId);
  });
  expect(screen.queryByTestId('chat-badge')).toBeNull();

  localStorage.clear();
});
