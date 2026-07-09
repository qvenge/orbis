import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { App } from './App';
import { useNav } from './state/navigation';
import { useRetryBuffer } from './state/retry';
import { renderWithProviders } from './test/harness';

afterEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

// Этап 3: двухрежимный layout. jsdom не применяет media queries — в DOM присутствуют
// ОБЕ поверхности (SidebarNav и TabBar), поэтому testid у них разные.
test('навигация: только Чат и Обзор (tab-bar + sidebar); Agenda/Budget нигде нет', () => {
  // App живёт под trpc.Provider (main.tsx); дефолтный таб chat рендерит ChatScreen → нужен контекст.
  renderWithProviders(<App />);
  // Мобильный tab-bar
  expect(screen.getByTestId('tab-chat')).toBeEnabled();
  expect(screen.getByTestId('tab-browser')).toBeEnabled();
  expect(screen.queryByTestId('tab-agenda')).toBeNull();
  expect(screen.queryByTestId('tab-budget')).toBeNull();
  // Десктопный sidebar: навигация + настройки
  expect(screen.getByTestId('sidebar-chat')).toBeInTheDocument();
  expect(screen.getByTestId('sidebar-browser')).toBeInTheDocument();
  expect(screen.getByTestId('open-settings')).toBeInTheDocument();
});

// §1.5: бейдж Chat реактивно отражает размер retry-буфера (пусто → нет бейджа) —
// в обеих поверхностях навигации.
test('бейдж Chat показывает размер retry-буфера в tab-bar и sidebar, исчезает при опустошении', () => {
  const op = useRetryBuffer.getState().enqueueCreate({ title: 'Тест', tags: [] }, 'fast_path');
  renderWithProviders(<App />);
  expect(screen.getByTestId('chat-badge')).toHaveTextContent('1');
  expect(screen.getByTestId('sidebar-chat-badge')).toHaveTextContent('1');

  act(() => {
    useRetryBuffer.getState().cancel(op.clientId);
  });
  expect(screen.queryByTestId('chat-badge')).toBeNull();
  expect(screen.queryByTestId('sidebar-chat-badge')).toBeNull();
});

// Клик по закреплённой в sidebar: активный таб становится browser, entity — наверху
// browser-стека БЕЗ сворачивания существующего стека (switchTab по активному табу
// сворачивает — проверяем, что хелпер это обходит).
test('закреплённая из sidebar открывается в browser-стеке поверх существующего стека', async () => {
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'e0' }], agenda: [], budget: [] },
  });
  renderWithProviders(<App />, (path) => {
    if (path === 'user.getSettings') return { pinnedEntities: [{ id: 'p1', order: 0 }] };
    if (path === 'entity.get')
      return {
        entity: {
          id: 'p1',
          ownerId: 'u',
          title: 'Закреп',
          emoji: null,
          body: '',
          bodyRefs: [],
          tags: [],
          meta: {},
          aspects: {},
          createdAt: 'x',
          updatedAt: 'y',
          archived: false,
        },
        relations: [],
        thread: null,
      };
    if (path === 'entity.query') return [];
    return {};
  });

  await waitFor(() => expect(screen.getByTestId('pinned-p1')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('pinned-p1'));

  expect(useNav.getState().activeTab).toBe('browser');
  expect(useNav.getState().stacks.browser).toEqual([
    { kind: 'entity', id: 'e0' },
    { kind: 'entity', id: 'p1' },
  ]);
});
