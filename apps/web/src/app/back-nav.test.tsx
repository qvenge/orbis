import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { App } from '../App';
import { installHistorySync } from '../app/history';
import { useNav } from '../state/navigation';
import { renderWithProviders } from '../test/harness';

// Этап 3: кнопка «Назад» в ScreenHeader — на ОДИН уровень (не сброс до корня).
// Слайс 3 (D18): кнопка ведёт через историю браузера, поэтому стек в тесте набирается
// настоящими push'ами при живой синхронизации — иначе записей истории под экраны нет,
// и «назад» откатывать нечего. Результат жеста асинхронный (popstate следующим тиком).
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';

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

const handler = (path: string, input: unknown) => {
  if (path === 'user.getSettings')
    return {
      timezone: 'Europe/Moscow',
      defaultCurrency: 'RUB',
      weekStartDay: 'monday',
      pinnedEntities: [],
    };
  if (path === 'entity.get') {
    const id = (input as { id: string }).id;
    return { entity: ent(id, `Сущность ${id}`), relations: [], thread: null };
  }
  if (path === 'entity.query') return [];
  if (path === 'entity.count') return { count: 0 };
  if (path === 'chat.ensureThread') return { threadId: 't1' };
  if (path === 'chat.listMessages') return [];
  return {};
};

afterEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

test('«Назад» снимает верхний экран стека (на уровень, не сброс до корня)', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('browser');
  useNav.getState().push('browser', { kind: 'entity', id: E1 });
  useNav.getState().push('browser', { kind: 'entity', id: E2 });
  renderWithProviders(<App />, handler);

  await waitFor(() => expect(screen.getByTestId('nav-back')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('nav-back'));

  // Снят только верхний уровень — E1 остался (не resetTabToRoot).
  await waitFor(() =>
    expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: E1 }]),
  );

  // Ещё раз назад — корень Browser, кнопки «Назад» больше нет.
  await waitFor(() => expect(screen.getByTestId('nav-back')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('nav-back'));
  await waitFor(() => expect(useNav.getState().stacks.browser).toEqual([]));
  await waitFor(() => expect(screen.queryByTestId('nav-back')).toBeNull());
  uninstall();
});

test('на корневом экране кнопка «Назад» не рендерится', async () => {
  renderWithProviders(<App />, handler);
  // Корень Chat: шапка есть, кнопки «Назад» нет.
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Чат' })).toBeInTheDocument());
  expect(screen.queryByTestId('nav-back')).toBeNull();
});
