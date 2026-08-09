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
  useRetryBuffer.setState({ size: 0, pending: [], flushing: false });
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

// Признак слива общий, а не покомпонентный: слив, запущенный не этой кнопкой (автослив на
// старте или по 'online'), обязан её гасить — иначе нажатие уходит в тот же промис впустую.
test('кнопка видит ЧУЖОЙ слив (автослив), а не только свой', async () => {
  let finish: ((outcome: 'confirmed') => void) | null = null;
  registerRetrySend(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useRetryBuffer.getState().enqueueCreate({ title: 'долгая', tags: [] }, 'fast_path');

  renderWithProviders(<ChatScreen />, chatMocks);
  await screen.findByTestId('pending-indicator');

  let flush: Promise<number>;
  act(() => {
    flush = useRetryBuffer.getState().flushNow();
  });
  await waitFor(() => expect(screen.getByTestId('pending-indicator')).toBeDisabled());

  await act(async () => {
    finish?.('confirmed');
    await flush;
  });
  await waitFor(() => expect(screen.queryByTestId('pending-indicator')).not.toBeInTheDocument());
});

test('офлайн: досылать нечем — кнопка недоступна, но счётчик читаем', async () => {
  const send = vi.fn(async () => 'confirmed' as const);
  registerRetrySend(send);
  useRetryBuffer.getState().enqueueCreate({ title: 'офлайн-запись', tags: [] }, 'fast_path');
  setOnline(false);

  renderWithProviders(<ChatScreen />, chatMocks);

  const indicator = await screen.findByTestId('pending-indicator');
  expect(indicator).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
  // Цифра — вся информация этой таблетки, и в офлайне она нужна не меньше: неактивность
  // обозначена рамкой, а не приглушением текста.
  expect(indicator).toHaveTextContent('Ждут отправки: 1');
  expect(indicator.className).not.toContain('opacity');
});

// Главный сценарий кнопки — линк живой, API мёртв. navigator.onLine врёт, нажатие ничего
// не меняет, и без явной строки экран отвечал бы молчанием.
test('неудачный досыл говорит об этом строкой состояния', async () => {
  const send = vi.fn(async () => 'transport_failure' as const);
  registerRetrySend(send);
  useRetryBuffer.getState().enqueueCreate({ title: 'не уйдёт', tags: [] }, 'fast_path');

  renderWithProviders(<ChatScreen />, chatMocks);

  const indicator = await screen.findByTestId('pending-indicator');
  expect(screen.queryByTestId('pending-flush-failed')).not.toBeInTheDocument();

  fireEvent.click(indicator);

  const note = await screen.findByTestId('pending-flush-failed');
  expect(note).toHaveAttribute('role', 'status');
  // Запись при этом на месте — сообщение о неудаче, а не о потере.
  expect(useRetryBuffer.getState().size).toBe(1);
  expect(screen.getByTestId('pending-indicator')).toBeEnabled();
});

// Успешный досыл ничего не жалуется — строка появляется только по делу.
test('удачный досыл строки о неудаче не показывает', async () => {
  registerRetrySend(async () => 'confirmed');
  useRetryBuffer.getState().enqueueCreate({ title: 'уйдёт', tags: [] }, 'fast_path');

  renderWithProviders(<ChatScreen />, chatMocks);

  fireEvent.click(await screen.findByTestId('pending-indicator'));

  await waitFor(() => expect(screen.queryByTestId('pending-indicator')).not.toBeInTheDocument());
  expect(screen.queryByTestId('pending-flush-failed')).not.toBeInTheDocument();
});

test('пустая очередь — индикатора нет', async () => {
  renderWithProviders(<ChatScreen />, chatMocks);

  await waitFor(() => expect(screen.getByTestId('message-list')).toBeInTheDocument());
  expect(screen.queryByTestId('pending-indicator')).not.toBeInTheDocument();
});
