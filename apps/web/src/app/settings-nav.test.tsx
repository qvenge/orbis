import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { App } from '../App';
import { useNav } from '../state/navigation';
import { renderWithProviders } from '../test/harness';

// §9.4: настройки/экспорт — сквозной экран поверх активного таба.
// Этап 3: аффордансы — пункт «Настройки» в sidebar (десктоп, data-testid="open-settings",
// ровно один узел) и icon-кнопка в шапке экрана (мобила, "open-settings-mobile").
const settings = {
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 'monday',
  pinnedEntities: [],
};

const handler = (path: string) => {
  if (path === 'user.getSettings') return settings;
  if (path === 'chat.ensureThread') return { threadId: 't1' };
  if (path === 'chat.listMessages') return [];
  return {};
};

afterEach(() => {
  localStorage.clear();
  // Сброс in-memory nav-стора (persist держит стеки между тестами файла).
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

test('пункт «Настройки» в sidebar открывает SettingsScreen поверх активного таба', async () => {
  renderWithProviders(<App />, handler);

  // До клика настроек нет — доказывает, что именно аффорданса приводит к экрану (не тавтология).
  expect(screen.queryByTestId('general-form')).toBeNull();

  // getByTestId упадёт при дублях узла — заодно фиксируем «ровно один open-settings».
  fireEvent.click(screen.getByTestId('open-settings'));

  // Экран настроек виден (форма «Общие») → SettingsScreen смонтирован через роутер.
  await waitFor(() => expect(screen.getByTestId('general-form')).toBeInTheDocument());
});

test('повторный клик по «Настройки» не создаёт дубль settings в стеке', async () => {
  renderWithProviders(<App />, handler);

  fireEvent.click(screen.getByTestId('open-settings'));
  await waitFor(() => expect(screen.getByTestId('general-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('open-settings'));

  expect(useNav.getState().stacks.chat).toEqual([{ kind: 'settings' }]);
});

test('мобильная кнопка настроек в шапке открывает SettingsScreen и пропадает глубже корня', async () => {
  renderWithProviders(<App />, handler);

  // На корневом экране (стек пуст) кнопка есть.
  fireEvent.click(screen.getByTestId('open-settings-mobile'));
  await waitFor(() => expect(screen.getByTestId('general-form')).toBeInTheDocument());

  // Settings всегда в стеке → на экране настроек мобильной кнопки настроек нет.
  expect(screen.queryByTestId('open-settings-mobile')).toBeNull();
  expect(useNav.getState().stacks.chat).toEqual([{ kind: 'settings' }]);
});
