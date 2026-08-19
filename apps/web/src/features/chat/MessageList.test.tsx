import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useNav } from '../../state/navigation';
import { renderWithProviders } from '../../test/harness';
import { MessageList } from './MessageList';
import type { ChatMessage } from './useChatThread';

// jsdom не реализует scrollIntoView — мокаем на прототипе, иначе вызов бросил бы.
const scrollSpy = vi.fn();

const emptyStacks = () => ({ chat: [], browser: [], agenda: [], budget: [] });

beforeEach(() => {
  Element.prototype.scrollIntoView = scrollSpy;
  scrollSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  // Стор навигации глобальный и переживает файл теста: кто его трогает, тот и прибирает,
  // иначе следующему тесту ленты достанется чужой activeTab (образец — RolloverScreen.test).
  useNav.setState({ activeTab: 'chat', stacks: emptyStacks() });
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

test('двойной тап по чипу отправляет сообщение один раз', () => {
  // На ChatScreen fast-path до первого await не меняет состояния (useFastPath: loadCtx
  // при холодном кэше идёт в сеть), поэтому «ряд успеет исчезнуть сам» — не защита:
  // второй тап уехал бы вторым сообщением и вторым вызовом модели.
  const onPick = vi.fn();
  render(
    <MessageList
      messages={[assistantWith('a', 'создал задачу', ['поставить срок'])]}
      isTyping={false}
      onPick={onPick}
    />,
  );
  const chip = screen.getByRole('button', { name: 'поставить срок' });
  fireEvent.click(chip);
  fireEvent.click(chip);
  expect(onPick).toHaveBeenCalledTimes(1);
});

test('погашен ряд только своего сообщения: у следующего ответа чипы снова живые', () => {
  const onPick = vi.fn();
  const { rerender } = render(
    <MessageList
      messages={[assistantWith('a', 'записал', ['что по бюджету?'])]}
      isTyping={false}
      onPick={onPick}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'что по бюджету?' }));
  expect(screen.queryByRole('button', { name: 'что по бюджету?' })).not.toBeInTheDocument();
  // Новый ответ модели с ТЕМ ЖЕ текстом продолжения: ряд принадлежит сообщению, не тексту.
  rerender(
    <MessageList
      messages={[
        assistantWith('b', 'и это записал', ['что по бюджету?']),
        assistantWith('a', 'записал', ['что по бюджету?']),
      ]}
      isTyping={false}
      onPick={onPick}
    />,
  );
  expect(screen.getByRole('button', { name: 'что по бюджету?' })).toBeInTheDocument();
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

// --- C3: audit-сообщение действия в ленте --------------------------------------------
// Сервер пишет audit-строку с content = заголовку записи и той же строкой в заголовке
// карточки (apps/server/src/executor/journal.ts) — до правила ниже лента печатала
// «Кофе» абзацем и «Кофе» карточкой подряд. Тесты идут через настоящий путь ленты
// (MessageList → renderCards → EntityCard), а не через renderCards напрямую.

const auditMsg = (content: string, cards: unknown[]): ChatMessage =>
  ({ ...msg('s1', content), role: 'system', metadata: { cards } }) as ChatMessage;

const entityCard = (title: string) => ({
  kind: 'entity_card',
  entityId: 'e1',
  title,
  aspects: [],
  keyFields: {},
  undoActionId: 'a1',
});

test('audit fast-path из истории: карточка отрисована, а заголовок напечатан ОДИН раз', () => {
  renderWithProviders(
    <MessageList messages={[auditMsg('Кофе', [entityCard('Кофе')])]} isTyping={false} />,
  );
  expect(screen.getByTestId('entity-card')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /отменить/i })).toBeInTheDocument();
  const hits = screen.getAllByText('Кофе');
  expect(hits).toHaveLength(1);
  // Уцелевший заголовок — тот, что внутри карточки (а не абзац вместо карточки).
  expect(screen.getByTestId('entity-card')).toContainElement(hits[0] ?? null);
});

test('историческая карточка без kind не отрисовалась → текст ОСТАЁТСЯ (иначе потеря содержимого)', () => {
  // Форма до C3 (executor/types.ts ActionCard): renderCards уходит в default → null.
  renderWithProviders(
    <MessageList
      messages={[auditMsg('Кофе', [{ tool: 'entity_create', entity_id: 'e1', title: 'Кофе' }])]}
      isTyping={false}
    />,
  );
  expect(screen.queryByTestId('entity-card')).toBeNull();
  expect(screen.getByText('Кофе')).toBeInTheDocument();
});

test('неизвестный kind с тем же заголовком: текст ОСТАЁТСЯ (правило смотрит на факт рендера)', () => {
  renderWithProviders(
    <MessageList
      messages={[auditMsg('Кофе', [{ kind: 'card_from_the_future', title: 'Кофе' }])]}
      isTyping={false}
    />,
  );
  expect(screen.getByText('Кофе')).toBeInTheDocument();
});

test('текст сообщения ≠ заголовку карточки: печатаются оба', () => {
  renderWithProviders(
    <MessageList messages={[auditMsg('Записал без AI', [entityCard('Кофе')])]} isTyping={false} />,
  );
  expect(screen.getByText('Записал без AI')).toBeInTheDocument();
  expect(screen.getByTestId('entity-card')).toHaveTextContent('Кофе');
});

// --- C4a: markdown в ленте -----------------------------------------------------------

const E1 = '019e4466-1111-7000-8000-0123456789ab';

test('ответ ассистента рендерится markdown-разметкой внутри своего <article>', () => {
  render(<MessageList messages={[msg('a', '## Итоги\n\n- раз\n- два')]} isTyping={false} />);
  const heading = screen.getByRole('heading', { level: 2, name: 'Итоги' });
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  // Разметка обязана остаться ВНУТРИ <article data-role>: на этой обёртке держатся
  // и стиль пузыря, и ChatThread.test (getAllByRole('article') + data-role).
  const article = screen.getByRole('article');
  expect(article).toHaveAttribute('data-role', 'assistant');
  expect(article).toContainElement(heading);
});

test('сообщение пользователя тоже markdown (человек пишет им же)', () => {
  render(<MessageList messages={[userMsg('u', 'сделать **срочно**')]} isTyping={false} />);
  expect(screen.getByText('срочно').tagName).toBe('STRONG');
  expect(screen.getByRole('article')).toHaveAttribute('data-role', 'user');
});

test('пост рутины в тред (role user + author_kind ai + routine_id) — НЕ пузырь владельца, а метка «рутина» над текстом (B1-1/D-1)', () => {
  // Сервер пишет пост `thread_post` прогона рутины ролью `user` с metadata
  // {author_kind:'ai', run_id, routine_id} (tools/dispatch.ts runThreadPost). Владелец утром не
  // должен читать «перенёс срок» как СВОИ слова.
  render(
    <MessageList
      messages={[
        {
          ...userMsg('r', 'Перенёс срок, см. план'),
          metadata: { author_kind: 'ai', run_id: 'run-1', routine_id: 'rt-1' },
        } as ChatMessage,
      ]}
      isTyping={false}
    />,
  );
  const article = screen.getByRole('article');
  expect(article).toHaveAttribute('data-author', 'рутина');
  expect(article.className).not.toContain('self-end');
  expect(screen.getByTestId('system-message')).toHaveTextContent('рутина');
  // Текст на месте — внутри помеченного блока
  expect(screen.getByTestId('system-message')).toHaveTextContent('Перенёс срок, см. план');
});

test('посты агента и чат-AI в тред тоже помечены («агент», «AI»); обычная реплика владельца — пузырь без метки', () => {
  render(
    <MessageList
      messages={[
        { ...userMsg('u', 'моя реплика') } as ChatMessage,
        { ...userMsg('ai', 'от внутреннего AI'), metadata: { author_kind: 'ai' } } as ChatMessage,
        {
          ...userMsg('ag', 'от исполнителя'),
          metadata: { author_kind: 'agent', run_id: 'run-9' },
        } as ChatMessage,
      ]}
      isTyping={false}
    />,
  );
  const articles = screen.getAllByRole('article');
  const byText = (text: string) =>
    articles.find((a) => a.textContent?.includes(text)) as HTMLElement;
  expect(byText('моя реплика')).not.toHaveAttribute('data-author');
  expect(byText('моя реплика').className).toContain('self-end');
  expect(byText('от внутреннего AI')).toHaveAttribute('data-author', 'AI');
  expect(byText('от исполнителя')).toHaveAttribute('data-author', 'агент');
  expect(screen.getAllByTestId('system-message')).toHaveLength(2);
});

test('клик по [[entity:…]] открывает запись поверх стека АКТИВНОЙ вкладки', () => {
  // Ровно как тап по карточке в той же ленте (cards/EntityCard): push, без смены вкладки.
  useNav.setState({ activeTab: 'chat', stacks: emptyStacks() });
  render(<MessageList messages={[msg('a', `готово: [[entity:${E1}]]`)]} isTyping={false} />);
  fireEvent.click(screen.getByRole('link'));
  expect(useNav.getState().activeTab).toBe('chat');
  expect(useNav.getState().stacks.chat).toEqual([{ kind: 'entity', id: E1 }]);
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
