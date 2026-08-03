import { fireEvent, render, screen } from '@testing-library/react';
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

// Ответ ассистента с продолжениями разговора (D19: сервер кладёт их в metadata.suggestions).
function assistantWith(id: string, content: string, suggestions: unknown): ChatMessage {
  return { ...msg(id, content), metadata: { suggestions } } as ChatMessage;
}

function userMsg(id: string, content: string): ChatMessage {
  return { ...msg(id, content), role: 'user' } as ChatMessage;
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

// §2.4 — продолжения разговора под последним ответом ассистента.

test('чипы показываются под последним ответом ассистента', () => {
  render(
    <MessageList
      messages={[assistantWith('a', 'записал', ['что по бюджету?'])]}
      isTyping={false}
      onPick={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'что по бюджету?' })).toBeInTheDocument();
});

test('у не-последнего ответа чипов нет', () => {
  // messages в DESC: assistantWith старше user-сообщения — значит не последний в порядке показа.
  render(
    <MessageList
      messages={[userMsg('u', 'привет'), assistantWith('a', 'записал', ['что по бюджету?'])]}
      isTyping={false}
      onPick={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'что по бюджету?' })).not.toBeInTheDocument();
});

test('тап по чипу отправляет его текст обычным сообщением', () => {
  const onPick = vi.fn();
  render(
    <MessageList
      messages={[assistantWith('a', 'создал задачу', ['поставить срок'])]}
      isTyping={false}
      onPick={onPick}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'поставить срок' }));
  expect(onPick).toHaveBeenCalledWith('поставить срок');
});

test('во время ответа модели чипы скрыты', () => {
  render(
    <MessageList
      messages={[assistantWith('a', 'записал', ['что по бюджету?'])]}
      isTyping
      onPick={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'что по бюджету?' })).not.toBeInTheDocument();
});

test('системное сообщение чипов не получает, даже если оно последнее', () => {
  const system = {
    ...assistantWith('s', 'агент закрыл задачу', ['что по бюджету?']),
    role: 'system',
  };
  render(<MessageList messages={[system as ChatMessage]} isTyping={false} onPick={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'что по бюджету?' })).not.toBeInTheDocument();
});

test('без обработчика onPick чипы не рендерятся (кнопка-пустышка хуже её отсутствия)', () => {
  render(
    <MessageList
      messages={[assistantWith('a', 'записал', ['что по бюджету?'])]}
      isTyping={false}
    />,
  );
  expect(screen.queryByRole('button', { name: 'что по бюджету?' })).not.toBeInTheDocument();
});

test('мусор в metadata.suggestions игнорируется, пустые строки отброшены', () => {
  render(
    <MessageList
      messages={[assistantWith('a', 'записал', [42, '  ', null, '  поставить срок  '])]}
      isTyping={false}
      onPick={vi.fn()}
    />,
  );
  const chips = screen.getAllByRole('button');
  expect(chips).toHaveLength(1);
  expect(chips[0]).toHaveAccessibleName('поставить срок');
});
