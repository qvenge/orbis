import { fireEvent, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { DetailScreen } from '../features/entity-detail/DetailScreen';
import { type ScreenRef, type Tab, useNav } from '../state/navigation';
import { renderWithProviders, trpcError } from '../test/harness';
import { installHistorySync, openDeepLink } from './history';

// §1.3: вход снаружи. Приложение, открытое по ссылке, показывает нужный экран; ссылка на
// удалённую/чужую запись даёт честный экран «не найдено», а не вечный скелетон.
//
// ВАЖНО про jsdom: сессионная история ОДНА на весь файл и между тестами не сбрасывается.
// Текущую запись канонизируем replaceState в beforeEach — тогда стартовая позиция известна,
// а «сколько записей добавилось» меряем не длиной истории (её усекает forward-хвост
// предыдущего теста), а числом вызовов pushState.

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

const resetNav = () =>
  useNav.setState({ activeTab: 'chat', stacks: { chat: [], browser: [], agenda: [], budget: [] } });

const seedPersist = (state: { activeTab: Tab; stacks: Record<Tab, ScreenRef[]> }) =>
  localStorage.setItem('orbis:nav:v1', JSON.stringify({ version: 0, state }));

beforeEach(() => {
  localStorage.clear();
  resetNav();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetNav();
});

test('вход по ссылке сбрасывает стек целевой вкладки и открывает экран', () => {
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [], browser: [{ kind: 'entity', id: E2 }], agenda: [], budget: [] },
  });

  expect(openDeepLink(`/entity/${E1}`)).toBe(true);
  expect(useNav.getState().activeTab).toBe('browser');
  // Прежний стек целевой вкладки ссылкой не сохраняется (§1.3).
  expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: E1 }]);
});

test('маршрут вкладки открывает её корень и сворачивает стек этой вкладки', () => {
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [], browser: [], agenda: [], budget: [{ kind: 'budget-transactions' }] },
  });

  expect(openDeepLink('/budget')).toBe(true);
  expect(useNav.getState().activeTab).toBe('budget');
  expect(useNav.getState().stacks.budget).toEqual([]);
});

test('неразобранный путь ничего не меняет и возвращает false', () => {
  useNav.setState({
    activeTab: 'agenda',
    stacks: { chat: [], browser: [{ kind: 'entity', id: E2 }], agenda: [], budget: [] },
  });
  const before = useNav.getState();

  // Корень сайта, битый id, чужой путь и путь с query-строкой — маршрутов приложения нет.
  expect(openDeepLink('/')).toBe(false);
  expect(openDeepLink('/entity/не-uuid')).toBe(false);
  expect(openDeepLink('/whatever')).toBe(false);
  expect(openDeepLink('/budget?tab=1')).toBe(false);

  expect(useNav.getState().activeTab).toBe(before.activeTab);
  expect(useNav.getState().stacks).toEqual(before.stacks);
});

test('первый «назад» после входа по ссылке ведёт на корень вкладки, а не из приложения', async () => {
  window.history.replaceState(null, '', `/entity/${E1}`);
  renderWithProviders(<App />, handler);

  await waitFor(() =>
    expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: E1 }]),
  );
  expect(useNav.getState().activeTab).toBe('browser');
  expect(window.location.pathname).toBe(`/entity/${E1}`);

  // У пришедшего по ссылке ровно один жест «назад», и он обязан вести на корень ЦЕЛЕВОЙ
  // вкладки: стек приложения не пуст, уводить с сайта нечестно.
  window.history.back();
  await waitFor(() => expect(useNav.getState().stacks.browser).toEqual([]));
  expect(useNav.getState().activeTab).toBe('browser');
  expect(window.location.pathname).toBe('/browser');
});

test('повторный openDeepLink с тем же путём не плодит записи истории и дубль экрана', () => {
  const uninstall = installHistorySync();
  const pushes = vi.spyOn(window.history, 'pushState');

  expect(openDeepLink(`/entity/${E1}`)).toBe(true);
  expect(openDeepLink(`/entity/${E1}`)).toBe(true);

  // Две записи с ПЕРВОГО вызова (корень вкладки + экран), со второго — ни одной.
  expect(pushes).toHaveBeenCalledTimes(2);
  expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: E1 }]);
  uninstall();
});

test('двойной старт (StrictMode) не плодит записи истории и не дублирует экран', async () => {
  window.history.replaceState(null, '', `/entity/${E1}`);
  const pushes = vi.spyOn(window.history, 'pushState');

  renderWithProviders(
    <StrictMode>
      <App />
    </StrictMode>,
    handler,
  );

  await waitFor(() =>
    expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: E1 }]),
  );
  // Ровно две записи — корень целевой вкладки и сам экран — сколько бы раз StrictMode
  // ни прогнал эффект: повторный вход по тому же пути видит стор уже в целевой позиции.
  expect(pushes).toHaveBeenCalledTimes(2);
});

test('чужой id даёт экран «не найдено» с возвратом на корень вкладки', async () => {
  window.history.replaceState(null, '', `/entity/${E1}`);
  renderWithProviders(<App />, (path, input) => {
    if (path === 'entity.get') throw trpcError('NOT_FOUND');
    return handler(path, input);
  });

  expect(await screen.findByRole('heading', { name: 'Не найдено' })).toBeInTheDocument();
  expect(screen.getByText('Запись удалена или недоступна')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'На главную' }));
  await waitFor(() => expect(useNav.getState().stacks.browser).toHaveLength(0));
  expect(useNav.getState().activeTab).toBe('browser');
});

test('не-NOT_FOUND ошибка экраном «не найдено» не подменяется', async () => {
  // Оба экрана рендерятся вместе и падают в одном такте — это и делает проверку
  // детерминированной: когда «не найдено» появилось у NOT_FOUND-экрана, второй запрос
  // уже упал, и отсутствие второго такого заголовка — факт, а не гонка.
  renderWithProviders(
    <>
      <DetailScreen entityId={E1} />
      <DetailScreen entityId={E2} />
    </>,
    (path, input) => {
      if (path === 'entity.get') {
        const id = (input as { id: string }).id;
        throw trpcError(id === E1 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR');
      }
      return handler(path, input);
    },
  );

  await screen.findByRole('heading', { name: 'Не найдено' });
  expect(screen.getAllByRole('heading', { name: 'Не найдено' })).toHaveLength(1);
  // Сеть и 500 «не найдено» не означают: экран остаётся прежним (скелетон с шапкой «…»).
  expect(screen.getByRole('heading', { name: '…' })).toBeInTheDocument();
});

test('восстановленные из persist стеки переживают обычный старт с синхронизацией', async () => {
  seedPersist({
    activeTab: 'browser',
    stacks: {
      chat: [],
      browser: [{ kind: 'entity', id: E2 }],
      agenda: [],
      budget: [{ kind: 'budget-transactions' }],
    },
  });
  await useNav.persist.rehydrate();
  window.history.replaceState(null, '', '/');

  renderWithProviders(<App />, handler);

  // Адрес '/' маршрутом приложения не является: восстановленная позиция остаётся как есть (§1.4).
  await waitFor(() => expect(window.location.pathname).toBe(`/entity/${E2}`));
  expect(useNav.getState().activeTab).toBe('browser');
  expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: E2 }]);
  expect(useNav.getState().stacks.budget).toEqual([{ kind: 'budget-transactions' }]);
});

test('перезагрузка на адресе экрана не срезает восстановленный стек', async () => {
  seedPersist({
    activeTab: 'browser',
    stacks: {
      chat: [],
      browser: [
        { kind: 'entity', id: E2 },
        { kind: 'entity', id: E1 },
      ],
      agenda: [],
      budget: [],
    },
  });
  await useNav.persist.rehydrate();
  // Так выглядит перезагрузка (F5): адрес — тот же, что канонизировала синхронизация,
  // и НАША запись в history.state никуда не делась (браузеры хранят её между
  // перезагрузками). Это не вход снаружи, и §1.3 к нему не применяется.
  window.history.replaceState(
    { tab: 'browser', depth: 2, screen: { kind: 'entity', id: E1 } },
    '',
    `/entity/${E1}`,
  );

  renderWithProviders(<App />, handler);

  await waitFor(() => expect(screen.getByTestId('tab-content')).toHaveAttribute('data-depth', '2'));
  expect(useNav.getState().stacks.browser).toEqual([
    { kind: 'entity', id: E2 },
    { kind: 'entity', id: E1 },
  ]);
  expect(window.location.pathname).toBe(`/entity/${E1}`);
});

test('вход по ссылке сбрасывает ТОЛЬКО целевую вкладку, чужие стеки из persist целы', async () => {
  seedPersist({
    activeTab: 'chat',
    stacks: {
      chat: [],
      browser: [{ kind: 'entity', id: E2 }],
      agenda: [],
      budget: [{ kind: 'budget-transactions' }],
    },
  });
  await useNav.persist.rehydrate();
  window.history.replaceState(null, '', `/entity/${E1}`);

  renderWithProviders(<App />, handler);

  await waitFor(() =>
    expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: E1 }]),
  );
  // §1.4: остальные вкладки восстановлены из persist и вход по ссылке их не касается.
  expect(useNav.getState().stacks.budget).toEqual([{ kind: 'budget-transactions' }]);
});
