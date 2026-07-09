import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ChatMessage } from './useChatThread';
import { MessageList } from './MessageList';

// jsdom не реализует scrollIntoView — мокаем на прототипе, иначе вызов бросил бы.
const scrollSpy = vi.fn();

beforeEach(() => {
  Element.prototype.scrollIntoView = scrollSpy;
  scrollSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function msg(id: string, content: string): ChatMessage {
  return {
    id,
    threadId: 't1',
    role: 'assistant',
    content,
    metadata: {},
    createdAt: '2026-07-05T12:00:00.000Z',
  } as ChatMessage;
}

test('автоскролл при монтировании: scrollIntoView вызван с behavior auto', () => {
  render(<MessageList messages={[msg('a', 'привет')]} isTyping={false} />);
  expect(scrollSpy).toHaveBeenCalled();
  expect(scrollSpy).toHaveBeenLastCalledWith(
    expect.objectContaining({ behavior: 'auto', block: 'end' }),
  );
});

test('автоскролл при добавлении сообщения: повторный scrollIntoView (behavior smooth)', () => {
  const { rerender } = render(
    <MessageList messages={[msg('a', 'первое')]} isTyping={false} />,
  );
  scrollSpy.mockClear();
  // Новое сообщение (в DESC — в начало) → длина изменилась → эффект автоскролла.
  rerender(
    <MessageList messages={[msg('b', 'второе'), msg('a', 'первое')]} isTyping={false} />,
  );
  expect(scrollSpy).toHaveBeenCalled();
  expect(scrollSpy).toHaveBeenLastCalledWith(
    expect.objectContaining({ behavior: 'smooth', block: 'end' }),
  );
});
