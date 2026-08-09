import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useNav } from '../../state/navigation';
import { registerRetrySend, useRetryBuffer } from '../../state/retry';
import { renderWithProviders } from '../../test/harness';
import { ChatScreen } from './ChatScreen';

const settings = { defaultCurrency: 'RUB', timezone: 'Europe/Moscow', pinnedEntities: [] };

const setOnline = (value: boolean) =>
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });

beforeEach(() => {
  localStorage.clear();
  // Буфер — синглтон на модуль: без сброса store счётчик протекал бы между тестами.
  useRetryBuffer.setState({ size: 0, pending: [] });
  registerRetrySend(async () => 'transport_failure');
  setOnline(true);
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

afterEach(() => {
  localStorage.clear();
  setOnline(true);
});

test('глобальный чат: pending ai.sendMessage → typing-индикатор виден', async () => {
  renderWithProviders(<ChatScreen />, (path) => {
    if (path === 'chat.ensureThread') return { threadId: 't1' };
    if (path === 'chat.listMessages') return [];
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.query') return []; // без категорий fast-path не сработает → LLM-путь
    if (path === 'ai.sendMessage') return new Promise(() => {}); // мутация висит → isSending=true
    throw new Error(`unexpected ${path}`);
  });

  await waitFor(() => expect(screen.getByTestId('message-list')).toBeInTheDocument());
  expect(screen.queryByTestId('typing')).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Сообщение'), { target: { value: 'квакозябра 500' } });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));

  // Пока отправка в LLM висит — индикатор «Ассистент печатает» на экране.
  const typing = await screen.findByTestId('typing');
  expect(typing).toHaveAttribute('role', 'status');
  expect(typing).toHaveAttribute('aria-label', 'Ассистент печатает');
});

// --- «Ждут отправки: N» умеет досылать -------------------------------------------------
// Автослив бывает только на старте приложения и по событию 'online'. Вернувшаяся сеть без
// события (спящий Wi-Fi, прокси, ожившее API при живом линке) оставляла человека с надписью
// о непосланных записях и без единого способа их послать, кроме перезагрузки страницы.

const chatMocks = (path: string) => {
  if (path === 'chat.ensureThread') return { threadId: 't1' };
  if (path === 'chat.listMessages') return [];
  if (path === 'user.getSettings') return settings;
  if (path === 'entity.query') return [];
  throw new Error(`unexpected ${path}`);
};

test('непустая очередь: индикатор — кнопка, нажатие сливает буфер', async () => {
  const send = vi.fn(async () => 'confirmed' as const);
  registerRetrySend(send);
  useRetryBuffer.getState().enqueueCreate({ title: 'офлайн-запись', tags: [] }, 'fast_path');

  renderWithProviders(<ChatScreen />, chatMocks);

  const indicator = await screen.findByTestId('pending-indicator');
  // Именно кнопка: досыл обязан быть достижим с клавиатуры и назван словами.
  expect(indicator.tagName).toBe('BUTTON');
  expect(indicator).toHaveAccessibleName('Ждут отправки: 1. Отправить сейчас');
  expect(indicator).toBeEnabled();
  expect(send).not.toHaveBeenCalled();

  fireEvent.click(indicator);

  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  // Очередь опустела — вместе с ней уходит и индикатор.
  await waitFor(() => expect(screen.queryByTestId('pending-indicator')).not.toBeInTheDocument());
});

test('во время слива кнопка недоступна', async () => {
  let finish: ((outcome: 'confirmed') => void) | null = null;
  registerRetrySend(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useRetryBuffer.getState().enqueueCreate({ title: 'долгая', tags: [] }, 'fast_path');

  renderWithProviders(<ChatScreen />, chatMocks);
  const indicator = await screen.findByTestId('pending-indicator');
  fireEvent.click(indicator);

  await waitFor(() => expect(screen.getByTestId('pending-indicator')).toBeDisabled());

  await act(async () => {
    finish?.('confirmed');
  });
  await waitFor(() => expect(screen.queryByTestId('pending-indicator')).not.toBeInTheDocument());
});

test('офлайн: досылать нечем — кнопка недоступна', async () => {
  const send = vi.fn(async () => 'confirmed' as const);
  registerRetrySend(send);
  useRetryBuffer.getState().enqueueCreate({ title: 'офлайн-запись', tags: [] }, 'fast_path');
  setOnline(false);

  renderWithProviders(<ChatScreen />, chatMocks);

  expect(await screen.findByTestId('pending-indicator')).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
});

test('пустая очередь — индикатора нет', async () => {
  renderWithProviders(<ChatScreen />, chatMocks);

  await waitFor(() => expect(screen.getByTestId('message-list')).toBeInTheDocument());
  expect(screen.queryByTestId('pending-indicator')).not.toBeInTheDocument();
});
