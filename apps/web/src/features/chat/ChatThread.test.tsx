import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { renderWithProviders, trpcError } from '../../test/harness';
import { ChatThread } from './ChatThread';

// §7.9: тред detail при сбое ai.sendMessage показывает РАБОЧУЮ «Повторить» (регрессия — раньше onRetry не прокидывался).
afterEach(() => localStorage.clear());

const assistantReply = {
  assistantMessage: {
    id: 'r',
    threadId: 't1',
    role: 'assistant',
    content: 'ok',
    metadata: {},
    createdAt: '2026-07-05T12:00:00.000Z',
  },
  actions: [],
  pending: [],
  replayed: false,
};

test('ошибка отправки в треде detail → error_card с рабочей «Повторить», ровно один user-пузырь', async () => {
  let aiCalls = 0;
  renderWithProviders(<ChatThread threadId="t1" />, (path) => {
    if (path === 'chat.listMessages') return [];
    if (path === 'ai.sendMessage') {
      aiCalls += 1;
      if (aiCalls === 1) throw trpcError('LLM_UNAVAILABLE'); // первая отправка падает
      return assistantReply; // повтор проходит
    }
    throw new Error(`unexpected ${path}`);
  });

  await waitFor(() => expect(screen.getByTestId('message-list')).toBeInTheDocument());

  fireEvent.change(screen.getByLabelText('Сообщение'), { target: { value: 'привет' } });
  fireEvent.click(screen.getByText('Отправить'));

  // error_card + кнопка «Повторить». На старом коде (без onRetry) кнопки НЕ было бы → тест падает (не тавтология).
  await waitFor(() => expect(screen.getByTestId('error-card')).toBeInTheDocument());
  const retryBtn = screen.getByText('Повторить');

  fireEvent.click(retryBtn);

  // Повтор снимает устаревший error_card и переотправляет тем же id (dedup) → один user-пузырь.
  await waitFor(() => expect(screen.queryByTestId('error-card')).toBeNull());
  const userBubbles = screen
    .getAllByRole('article')
    .filter((a) => a.getAttribute('data-role') === 'user');
  expect(userBubbles.length).toBe(1);
  expect(aiCalls).toBe(2);
});
