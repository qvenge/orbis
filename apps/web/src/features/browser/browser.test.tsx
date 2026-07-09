import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { useNav } from '../../state/navigation';
import { renderWithProviders, trpcError } from '../../test/harness';
import { Toaster } from '../../ui/Toast';
import { useToastStore } from '../../ui/toast-store';
import { EntityList } from './EntityList';
import { PinnedList } from './PinnedList';
import { QuickCapture } from './QuickCapture';

const ent = (id: string, title: string) => ({
  id,
  ownerId: 'u',
  title,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: {},
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

beforeEach(() => {
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

test('EntityList: первая страница 50 через entity.query; «ещё» шлёт limit=100', async () => {
  const page = Array.from({ length: 50 }, (_, i) => ent(`e${i}`, `T${i}`));
  const { calls } = renderWithProviders(<EntityList />, (path, input) => {
    if (path === 'entity.query') {
      const q = (input as { query: string }).query;
      return q.includes('limit=100') ? [...page, ent('e50', 'T50')] : page;
    }
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getAllByTestId('entity-row')).toHaveLength(50));
  fireEvent.click(screen.getByRole('button', { name: /ещё/i }));
  await waitFor(() =>
    expect(calls.some((c) => (c.input as { query: string }).query.includes('limit=100'))).toBe(
      true,
    ),
  );
});

test('PinnedList: строки pinned, бейдж через entity.count (>99 → «99+»), onOpen с id', async () => {
  const onOpen = vi.fn();
  // §3.2: бейдж считается по первому {{query:...}}-блоку body закреплённой сущности.
  const pinnedEntity = { ...ent('p1', 'Задачи'), body: '{{query:aspect=orbis/task}}' };
  renderWithProviders(<PinnedList onOpen={onOpen} />, (path) => {
    if (path === 'user.getSettings') return { pinnedEntities: [{ id: 'p1', order: 0 }] };
    if (path === 'entity.get') return { entity: pinnedEntity, relations: [] };
    if (path === 'entity.count') return { count: 250 };
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('pin-badge-p1')).toHaveTextContent('99+'));
  expect(screen.getByTestId('pinned-p1')).toHaveTextContent('Задачи');

  fireEvent.click(screen.getByTestId('pinned-p1'));
  expect(onOpen).toHaveBeenCalledWith('p1');
});

test('PinnedList: без закреплённых — muted-строка «Нет закреплённых»', async () => {
  renderWithProviders(<PinnedList onOpen={() => {}} />, (path) => {
    if (path === 'user.getSettings') return { pinnedEntities: [] };
    return {};
  });
  await waitFor(() => expect(screen.getByText('Нет закреплённых')).toBeInTheDocument());
});

test('QuickCapture: title-only через entity.create(source:quick_capture) без интерпретации', async () => {
  const { calls } = renderWithProviders(<QuickCapture context={{ kind: 'root' }} />, (path) =>
    path === 'entity.create' ? ent('new', 'купить молоко 200') : {},
  );
  fireEvent.change(screen.getByLabelText(/быстрая запись/i), {
    target: { value: 'купить молоко 200' },
  });
  fireEvent.submit(screen.getByTestId('quick-capture-form'));
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.create');
    expect(c?.input).toMatchObject({
      source: 'quick_capture',
      input: { title: 'купить молоко 200', tags: [] },
    });
    // никакой интерпретации: нет aspects orbis/financial
    expect((c?.input as { input: { aspects?: unknown } }).input.aspects).toBeUndefined();
  });
});

test('EntityList: загрузка → skeleton-ряды (role=status), не текст «Загрузка…»', () => {
  renderWithProviders(<EntityList />, () => new Promise(() => {})); // запрос висит
  expect(screen.getAllByRole('status', { name: 'Загрузка' }).length).toBeGreaterThanOrEqual(6);
  expect(screen.queryByText(/Загрузка…/)).not.toBeInTheDocument();
});

test('EntityList: пусто → EmptyState «Здесь появятся ваши записи»', async () => {
  renderWithProviders(<EntityList />, (path) => {
    if (path === 'entity.query') return [];
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getByText('Здесь появятся ваши записи')).toBeInTheDocument());
  expect(screen.getByText(/Добавьте первую через быструю запись/)).toBeInTheDocument();
});

test('QuickCapture: ошибка мутации → toast «Не удалось сохранить», ввод сохранён', async () => {
  renderWithProviders(
    <>
      <QuickCapture context={{ kind: 'root' }} />
      <Toaster />
    </>,
    (path) => {
      if (path === 'entity.create') throw trpcError('INTERNAL_SERVER_ERROR');
      return {};
    },
  );
  fireEvent.change(screen.getByLabelText(/быстрая запись/i), {
    target: { value: 'важная заметка' },
  });
  fireEvent.submit(screen.getByTestId('quick-capture-form'));

  await waitFor(() => expect(screen.getByText('Не удалось сохранить')).toBeInTheDocument());
  // Введённый текст НЕ очищен — пользователь может повторить сабмит.
  expect(screen.getByLabelText(/быстрая запись/i)).toHaveValue('важная заметка');
});
