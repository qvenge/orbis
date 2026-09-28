// Экран «Память AI» (02-core-os §2.7, Task D3b): список memory-сущностей + вход из
// настроек. Ключевое поведение, которое стережём: строка запроса ровно одна
// (свой sortBy НЕ добавляем — browserQuery уже дописывает, K10) и запись правила открывается
// из хоста (экран памяти — экран хоста, срез 1б §7.2).
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { App } from '../../App';
import { FrameAppContext } from '../../app/frame/FrameApp';
import { resetNavForTests, useNav } from '../../state/navigation';
import {
  isSupplyRecordsCall,
  renderWithProviders,
  trpcError,
  wireEntity,
} from '../../test/harness';
import { recordAddress, topAddress } from '../../test/nav';
import { registryReply } from '../../test/registry';
import { MemoryScreen } from './MemoryScreen';
import { SettingsScreen } from './SettingsScreen';

const mem = (id: string, title: string, kind: string) =>
  wireEntity({
    id,
    title,
    props: {
      'orbis/memory_kind': kind,
      ...(kind === 'rule' ? { 'orbis/rule_scope': 'orbis/money-movement' } : {}),
    },
    aspects: ['orbis/memory'],
  });

const rule = mem('r1', 'кофе → Развлечения', 'rule');
const fact = mem('f1', 'Работаю из дома по пятницам', 'fact');

const settings = {
  graphId: 'u',
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
  resetNavForTests();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  resetNavForTests();
  window.history.replaceState(null, '', '/');
});

test('MemoryScreen: правило и факт списком, запрос aspect=orbis/memory без второго sortBy', async () => {
  const { calls } = renderWithProviders(<MemoryScreen />, (path) =>
    path === 'entity.query' ? [rule, fact] : {},
  );
  await waitFor(() => expect(screen.getByText('кофе → Развлечения')).toBeInTheDocument());
  expect(screen.getByText('Работаю из дома по пятницам')).toBeInTheDocument();
  // Строка ассертится ТОЧНО: повтор sortBy= — ошибка парсера грамматики (K10).
  // Запрос записей поставки шлёт рамка (присутствие хоста в шапке), не экран памяти.
  expect(calls.find((c) => c.path === 'entity.query' && !isSupplyRecordsCall(c))?.input).toEqual({
    query: 'aspect=orbis/memory, sortBy=orbis/updated_at:desc, limit=50',
  });
});

/**
 * ПОДПИСЬ ПРАВИЛА — ПРОИЗВОДНАЯ, А НЕ КОПИЯ (В7). Экран памяти — единственное место, куда
 * владелец приходит СПЕЦИАЛЬНО ревизовать правила, и до этой правки он был единственной из
 * трёх поверхностей, читавшей сохранённый `title`: после переименования категории он
 * показывал имя, которого в графе уже нет.
 *
 * Заголовок в фикстуре НАМЕРЕННО устарел («… → Кафе», категория давно «Продукты»): пока он
 * лжёт, видно, что строка собрана из свойств, а не взята из колонки.
 */
test('MemoryScreen: строка правила собрана из свойств — образец и АКТУАЛЬНОЕ имя категории', async () => {
  const target = 'a3d6d4b2-7f3a-4a1f-9c1e-2d5b8f0a1c77';
  const stale = wireEntity({
    id: 'r9',
    title: 'пятерочка → Кафе',
    props: {
      'orbis/memory_kind': 'rule',
      'orbis/rule_scope': 'orbis/money-movement',
      'orbis/rule_pattern': 'пятерочка',
      'orbis/rule_target': target,
    },
    aspects: ['orbis/memory'],
  });
  const category = wireEntity({
    id: target,
    title: 'Продукты',
    props: {},
    aspects: ['orbis/category'],
  });
  renderWithProviders(<MemoryScreen />, (path, input) => {
    // Два разных `entity.query`: список памяти идёт строкой грамматики, выдача цели ссылки
    // — деревом (`ast`). Различаем по форме входа, как это делает и сам сервер.
    if (path === 'entity.query') {
      return (input as { query?: string }).query === undefined ? [category] : [stale];
    }
    return registryReply(path) ?? {};
  });
  await waitFor(() => expect(screen.getByTestId('entity-row-rule')).toHaveTextContent('пятерочка'));
  await waitFor(() => expect(screen.getByText('Продукты')).toBeInTheDocument());
  // Устаревшая подпись НЕ показывается — ни целиком, ни именем внутри неё.
  expect(screen.queryByText('пятерочка → Кафе')).toBeNull();
  expect(screen.getByTestId('memory-row').textContent).not.toContain('Кафе');
  // И сырой uuid цели наружу не выходит (D6d п.1).
  expect(screen.getByTestId('memory-row').textContent).not.toContain(target);
});

test('MemoryScreen: пояснение, что AI помнит и как этим управлять', async () => {
  renderWithProviders(<MemoryScreen />, (path) => (path === 'entity.query' ? [rule] : {}));
  await waitFor(() => expect(screen.getByTestId('memory-intro')).toBeInTheDocument());
  expect(screen.getByTestId('memory-intro')).toHaveTextContent(/правил/i);
});

test('MemoryScreen: тап по правилу открывает запись из хоста; экран памяти остаётся под ней (§7.3, финал C1 M-3)', async () => {
  useNav.getState().openHostScreen('memory');
  renderWithProviders(
    <FrameAppContext.Provider value={{ app: 'host', via: 'host-page' }}>
      <MemoryScreen />
    </FrameAppContext.Provider>,
    (path) => (path === 'entity.query' ? [rule] : {}),
  );
  await waitFor(() => expect(screen.getByTestId('memory-row')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('memory-row'));
  expect(topAddress()).toEqual(recordAddress('r1'));
  // Экран памяти не снят: «‹» с правила возвращает в список, а не в раздел под настройками (§7.3
  // снимает экран хоста только у перехода из чата и поиска).
  expect(useNav.getState().model.apps.host?.stacks.home?.map((e) => e.address.kind)).toEqual([
    'home',
    'host-screen',
    'record',
  ]);
});

test('MemoryScreen: пустая память — своё пустое состояние, а не «быстрая запись ниже»', async () => {
  renderWithProviders(<MemoryScreen />, (path) => (path === 'entity.query' ? [] : {}));
  await waitFor(() => expect(screen.getByTestId('memory-empty')).toBeInTheDocument());
  expect(screen.queryByTestId('memory-row')).toBeNull();
  expect(screen.queryByText(/быструю запись/i)).toBeNull();
});

// Отказ выборки и пустая память выглядели одинаково: экран рисовал «AI пока ничего не
// запомнил» и предлагал завести правила заново — то есть врал про состояние памяти.
// Норму держит соседний экран (плашка «Не удалось загрузить» на Повестке).
test('MemoryScreen: отказ запроса — плашка ошибки, а не «AI пока ничего не запомнил»', async () => {
  renderWithProviders(<MemoryScreen />, (path) => {
    if (path === 'entity.query') throw trpcError('INTERNAL_SERVER_ERROR');
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('memory-error')).toBeInTheDocument());
  expect(screen.queryByTestId('memory-empty')).toBeNull();
});

// ЗНАЧКА «ФОРМАТ» БОЛЬШЕ НЕТ, и это не потеря диагностики, а исчезновение класса: он
// показывал правило, записанное и молча мёртвое (заголовок без разделителя), а после В7
// такое правило НЕЗАПИСУЕМО — образец обязателен, категория ссылкой. Признак, который не
// может сработать, — мёртвая ветка; проба стоит, чтобы возврат был заметен.
test('MemoryScreen: пометки «формат» нет ни у одной строки — класс закрыт на записи', async () => {
  const prose = mem('r2', 'кофе это развлечения', 'rule');
  renderWithProviders(<MemoryScreen />, (path) =>
    path === 'entity.query' ? [rule, prose, fact] : {},
  );
  await waitFor(() => expect(screen.getAllByTestId('memory-row')).toHaveLength(3));
  expect(screen.queryAllByTestId('memory-broken')).toHaveLength(0);
});

test('раздел «Память AI» в настройках пушит экран памяти в активный таб', async () => {
  resetNavForTests();
  renderWithProviders(<SettingsScreen />, (path) => {
    if (path === 'user.getSettings') return settings;
    return {};
  });
  fireEvent.click(await screen.findByRole('tab', { name: 'Память AI' }));
  fireEvent.click(await screen.findByRole('button', { name: /открыть память/i }));
  expect(topAddress()).toEqual({ kind: 'host-screen', screen: 'memory' });
});

test('роутер: адрес /settings/memory рисует экран памяти', async () => {
  window.history.replaceState(null, '', '/settings/memory');
  renderWithProviders(<App />, (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'chat.ensureThread') return { threadId: 't1' };
    if (path === 'chat.listMessages') return [];
    if (path === 'entity.query') return [rule];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('memory-intro')).toBeInTheDocument());
});

test('роутер: правило, открытое с /settings/memory, ложится поверх памяти — «‹» вернёт в список (финал C1 M-3)', async () => {
  resetNavForTests();
  window.history.replaceState(null, '', '/settings/memory');
  renderWithProviders(<App />, (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'chat.ensureThread') return { threadId: 't1' };
    if (path === 'chat.listMessages') return [];
    if (path === 'entity.query') return [rule];
    return {};
  });
  fireEvent.click(await screen.findByTestId('memory-row'));
  expect(topAddress()).toEqual(recordAddress('r1'));
  const stack = useNav.getState().model.apps.host?.stacks.home ?? [];
  expect(stack.map((e) => e.address.kind)).toContain('host-screen');
  expect(stack[stack.length - 2]?.address).toEqual({ kind: 'host-screen', screen: 'memory' });
  window.history.replaceState(null, '', '/');
});
