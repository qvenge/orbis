import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { renderWithProviders } from '../../test/harness';
import { ChatScreen } from './ChatScreen';

const settings = { defaultCurrency: 'RUB', timezone: 'Europe/Moscow', pinnedEntities: [] };

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
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
