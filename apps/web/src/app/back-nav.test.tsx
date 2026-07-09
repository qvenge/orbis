import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { App } from '../App';
import { useNav } from '../state/navigation';
import { renderWithProviders } from '../test/harness';

// Этап 3: кнопка «Назад» в ScreenHeader — pop на ОДИН уровень (не сброс до корня).
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

test('«Назад» снимает верхний экран стека (pop на уровень, не сброс до корня)', async () => {
  useNav.setState({
    activeTab: 'browser',
    stacks: {
      chat: [],
      browser: [
        { kind: 'entity', id: 'e1' },
        { kind: 'entity', id: 'e2' },
      ],
      agenda: [],
      budget: [],
    },
  });
  renderWithProviders(<App />, handler);

  await waitFor(() => expect(screen.getByTestId('nav-back')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('nav-back'));

  // Снят только верхний уровень — e1 остался (pop, не resetTabToRoot).
  expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: 'e1' }]);

  // Ещё раз назад — корень Browser, кнопки «Назад» больше нет.
  await waitFor(() => expect(screen.getByTestId('nav-back')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('nav-back'));
  expect(useNav.getState().stacks.browser).toEqual([]);
  await waitFor(() => expect(screen.queryByTestId('nav-back')).toBeNull());
});

test('на корневом экране кнопка «Назад» не рендерится', async () => {
  renderWithProviders(<App />, handler);
  // Корень Chat: шапка есть, кнопки «Назад» нет.
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Чат' })).toBeInTheDocument());
  expect(screen.queryByTestId('nav-back')).toBeNull();
});
