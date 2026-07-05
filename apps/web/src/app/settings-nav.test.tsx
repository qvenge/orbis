import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { App } from '../App';
import { useNav } from '../state/navigation';
import { renderWithProviders } from '../test/harness';

// §9.4: настройки/экспорт достижимы через сквозную кнопку-шестерёнку поверх активного таба.
const settings = {
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 'monday',
  pinnedEntities: [],
};

afterEach(() => {
  localStorage.clear();
  // Сброс in-memory nav-стора (persist держит стеки между тестами файла).
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

test('клик по шестерёнке открывает SettingsScreen поверх активного таба', async () => {
  renderWithProviders(<App />, (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'chat.ensureThread') return { threadId: 't1' };
    if (path === 'chat.listMessages') return [];
    return {};
  });

  // До клика настроек нет — доказывает, что именно аффорданса приводит к экрану (не тавтология).
  expect(screen.queryByTestId('general-form')).toBeNull();

  fireEvent.click(screen.getByTestId('open-settings'));

  // Экран настроек виден (форма «Общие») → SettingsScreen смонтирован через роутер.
  await waitFor(() => expect(screen.getByTestId('general-form')).toBeInTheDocument());
});
