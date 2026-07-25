// Экран «Память AI» (02-core-os §2.7, Task D3b): список memory-сущностей + вход из
// настроек. Ключевое поведение, которое стережём: строка запроса ровно одна
// (свой sortBy НЕ добавляем — browserQuery уже дописывает, K10) и переход на detail
// идёт в ТЕКУЩЕМ табе (EntityList жёстко пушит в browser — поэтому он не переиспользован).
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { App } from '../../App';
import { useNav } from '../../state/navigation';
import { renderWithProviders } from '../../test/harness';
import { MemoryScreen } from './MemoryScreen';
import { SettingsScreen } from './SettingsScreen';

const mem = (id: string, title: string, kind: 'rule' | 'fact') => ({
  id,
  ownerId: 'u',
  title,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: { 'orbis/memory': kind === 'rule' ? { kind, scope: 'orbis/financial' } : { kind } },
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

const rule = mem('r1', 'кофе → Развлечения', 'rule');
const fact = mem('f1', 'Работаю из дома по пятницам', 'fact');

const settings = {
  ownerId: 'u',
  plan: 'dev',
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 'monday',
  tagColors: {},
  installedViews: [],
  pinnedEntities: [],
  viewPreferences: {},
  updatedAt: 'x',
};

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'chat',
    stacks: {
      chat: [{ kind: 'settings' }, { kind: 'memory' }],
      browser: [],
      agenda: [],
      budget: [],
    },
  });
});

test('MemoryScreen: правило и факт списком, запрос aspect=orbis/memory без второго sortBy', async () => {
  const { calls } = renderWithProviders(<MemoryScreen />, (path) =>
    path === 'entity.query' ? [rule, fact] : {},
  );
  await waitFor(() => expect(screen.getByText('кофе → Развлечения')).toBeInTheDocument());
  expect(screen.getByText('Работаю из дома по пятницам')).toBeInTheDocument();
  // Строка ассертится ТОЧНО: повтор sortBy= — ошибка парсера грамматики (K10).
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({
    query: 'aspect=orbis/memory, sortBy=updated_at:desc, limit=50',
  });
});

test('MemoryScreen: пояснение, что AI помнит и как этим управлять', async () => {
  renderWithProviders(<MemoryScreen />, (path) => (path === 'entity.query' ? [rule] : {}));
  await waitFor(() => expect(screen.getByTestId('memory-intro')).toBeInTheDocument());
  expect(screen.getByTestId('memory-intro')).toHaveTextContent(/правил/i);
});

test('MemoryScreen: тап по правилу открывает detail в ТЕКУЩЕМ табе, а не в browser', async () => {
  renderWithProviders(<MemoryScreen />, (path) => (path === 'entity.query' ? [rule] : {}));
  await waitFor(() => expect(screen.getByTestId('memory-row')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('memory-row'));
  expect(useNav.getState().stacks.chat.at(-1)).toEqual({ kind: 'entity', id: 'r1' });
  expect(useNav.getState().stacks.browser).toEqual([]);
});

test('MemoryScreen: пустая память — своё пустое состояние, а не «быстрая запись ниже»', async () => {
  renderWithProviders(<MemoryScreen />, (path) => (path === 'entity.query' ? [] : {}));
  await waitFor(() => expect(screen.getByTestId('memory-empty')).toBeInTheDocument());
  expect(screen.queryByTestId('memory-row')).toBeNull();
  expect(screen.queryByText(/быструю запись/i)).toBeNull();
});

test('раздел «Память AI» в настройках пушит экран памяти в активный таб', async () => {
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [{ kind: 'settings' }], browser: [], agenda: [], budget: [] },
  });
  renderWithProviders(<SettingsScreen />, (path) => {
    if (path === 'user.getSettings') return settings;
    return {};
  });
  fireEvent.click(await screen.findByRole('tab', { name: 'Память AI' }));
  fireEvent.click(await screen.findByRole('button', { name: /открыть память/i }));
  expect(useNav.getState().stacks.chat.at(-1)).toEqual({ kind: 'memory' });
});

test('router: ScreenRef {kind:memory} рендерит экран памяти', async () => {
  renderWithProviders(<App />, (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'chat.ensureThread') return { threadId: 't1' };
    if (path === 'chat.listMessages') return [];
    if (path === 'entity.query') return [rule];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('memory-intro')).toBeInTheDocument());
});
