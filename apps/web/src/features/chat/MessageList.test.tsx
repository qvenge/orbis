import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MessageList } from './MessageList';
import type { ChatMessage } from './useChatThread';

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

test('пустой глобальный чат: показывает fast-path-подсказку из emptyHint', () => {
  render(
    <MessageList
      messages={[]}
      isTyping={false}
      emptyHint="Например: «обед 340» — Orbis разберёт сам"
    />,
  );
  expect(screen.getByText('Напишите первое сообщение')).toBeInTheDocument();
  expect(screen.getByText(/Orbis разберёт сам/)).toBeInTheDocument();
});

test('пустой тред сущности: без fast-path-подсказки, своя подпись обсуждения', () => {
  render(<MessageList messages={[]} isTyping={false} emptyHint="Обсуждение этой записи" />);
  expect(screen.getByText('Напишите первое сообщение')).toBeInTheDocument();
  expect(screen.getByText('Обсуждение этой записи')).toBeInTheDocument();
  // Регрессия: fast-path-подсказка не должна утекать в тред сущности.
  expect(screen.queryByText(/Orbis разберёт сам/)).not.toBeInTheDocument();
  expect(screen.queryByText(/обед 340/)).not.toBeInTheDocument();
});

test('автоскролл при добавлении сообщения: повторный scrollIntoView (behavior smooth)', () => {
  const { rerender } = render(<MessageList messages={[msg('a', 'первое')]} isTyping={false} />);
  scrollSpy.mockClear();
  // Новое сообщение (в DESC — в начало) → длина изменилась → эффект автоскролла.
  rerender(<MessageList messages={[msg('b', 'второе'), msg('a', 'первое')]} isTyping={false} />);
  expect(scrollSpy).toHaveBeenCalled();
  expect(scrollSpy).toHaveBeenLastCalledWith(
    expect.objectContaining({ behavior: 'smooth', block: 'end' }),
  );
});
