import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { ExportButton } from './ExportButton';
import { GeneralForm } from './GeneralForm';
import { SettingsScreen } from './SettingsScreen';

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

test('GeneralForm сабмитит частичный апдейт (только изменённый timezone)', async () => {
  const { calls } = renderWithProviders(<GeneralForm settings={settings as never} />, (path) =>
    path === 'user.updateSettings' ? settings : {},
  );
  fireEvent.change(screen.getByLabelText(/таймзона/i), { target: { value: 'UTC' } });
  fireEvent.submit(screen.getByTestId('general-form'));
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'user.updateSettings');
    // Строгий toEqual: стережёт «шлём только изменённые поля» — упал бы при регрессе на полный объект.
    expect(c?.input).toEqual({ timezone: 'UTC' });
  });
});

test('сегмент темы: клик «Тёмная» → data-theme + localStorage, в patch тема НЕ попадает', async () => {
  localStorage.removeItem('orbis:theme');
  document.documentElement.removeAttribute('data-theme');
  const { calls } = renderWithProviders(<GeneralForm settings={settings as never} />, (path) =>
    path === 'user.updateSettings' ? settings : {},
  );
  fireEvent.click(screen.getByRole('button', { name: 'Тёмная' }));
  expect(localStorage.getItem('orbis:theme')).toBe('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');

  // Сабмит без изменений полей формы → мутация с пустым patch, без ключа темы.
  fireEvent.submit(screen.getByTestId('general-form'));
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'user.updateSettings');
    expect(c?.input).toEqual({});
  });
});

// Вкладка «Агенты» (§9.3) — единственный вход к отзыву выданных доступов: без неё
// компонент есть, а владельцу недоступен.
test('вкладка «Агенты» открывает список выданных доступов', async () => {
  renderWithProviders(<SettingsScreen />, (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'oauth.listGrants')
      return [
        {
          id: 'g1',
          kind: 'oauth',
          label: 'Claude Code',
          connected: true,
          createdAt: '2026-08-01T10:00:00.000Z',
          lastUsedAt: null,
          revokedAt: null,
        },
      ];
    return {};
  });
  // Дожидаемся САМИХ вкладок: до загрузки настроек экран рисует скелетон, и проверка
  // «списка ещё нет» на пустом дереве проходила бы при любой реализации.
  const tab = await screen.findByRole('tab', { name: 'Агенты' });
  // Содержимое активной вкладки на месте — то есть дерево вкладок отрисовано целиком,
  // и пустота ниже означает именно «неактивная вкладка не смонтирована», а не «экран ещё
  // не готов». Без этой строки проверка ничего бы не устанавливала.
  expect(screen.getByTestId('general-form')).toBeInTheDocument();
  expect(screen.queryByText('Claude Code')).toBeNull();
  fireEvent.click(tab);
  expect(await screen.findByText('Claude Code')).toBeInTheDocument();
});

// Задача 15 сделала `keepMounted` опцией вкладки — и настройки её не берут. Проверка на
// ЗАПРОСАХ, а не на разметке: содержимое неактивной вкладки можно и спрятать (тогда пустота
// на экране ничего не доказывает), а вот сеть врать не умеет — экран настроек с шестью
// вкладками разослал бы их запросы разом при каждом входе (ревью Б8).
test('настройки не монтируют неактивные вкладки: их запросы в сеть не уходят', async () => {
  const { calls } = renderWithProviders(<SettingsScreen />, (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'oauth.listGrants') return [];
    if (path === 'aspect.list') return [];
    if (path === 'view.list') return [];
    return {};
  });
  // Ждём САМИ вкладки: до загрузки настроек экран рисует скелетон, и пустой список запросов
  // на нём проходил бы при любой реализации.
  await screen.findByRole('tab', { name: 'Агенты' });
  expect(screen.getByTestId('general-form')).toBeInTheDocument();

  const paths = () => calls.map((c) => c.path);
  expect(paths()).toEqual(['user.getSettings']);

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: открытая вкладка свой запрос ШЛЁТ — иначе молчание
  // выше означало бы лишь, что эти вкладки не спрашивают ничего и никогда.
  fireEvent.click(screen.getByRole('tab', { name: 'Аспекты' }));
  await waitFor(() => expect(paths()).toContain('aspect.list'));
  expect(paths()).not.toContain('oauth.listGrants');
});

beforeEach(() => {
  // jsdom не имеет createObjectURL
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:x'),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
});

test('ExportButton формирует Blob с format:orbis-export', async () => {
  const createObjectURL = URL.createObjectURL as ReturnType<typeof vi.fn>;
  renderWithProviders(<ExportButton />, (path) =>
    path === 'user.exportData'
      ? {
          format: 'orbis-export',
          version: 1,
          exportedAt: 'x',
          entities: [],
          relations: [],
          chatThreads: [],
          chatMessages: [],
          userSettings: settings,
          aspectDefinitions: [],
        }
      : {},
  );
  fireEvent.click(screen.getByRole('button', { name: /экспорт/i }));
  await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
  const text = await blob.text();
  expect(JSON.parse(text).format).toBe('orbis-export');
});
