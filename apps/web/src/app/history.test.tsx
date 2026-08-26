import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { App } from '../App';
import { closeToBudgetOverview, useNav } from '../state/navigation';
import { renderWithProviders } from '../test/harness';
import { installHistorySync } from './history';

// D18: история браузера — носитель пути навигации. Системный жест «назад» и кнопка шапки
// обязаны означать одно и то же, а адресная строка — показывать текущий экран.
//
// ВАЖНО про jsdom: сессионная история ОДНА на весь файл и между тестами не сбрасывается
// (window.history.length копится). Поэтому длину меряем дельтой, а текущую запись
// в beforeEach канонизируем replaceState — тогда стартовая позиция теста известна.

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
  aspectsMap: {},
  props: {},
  aspects: [],
  queryRefs: [],
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

beforeEach(() => {
  localStorage.clear();
  resetNav();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  localStorage.clear();
  resetNav();
});

test('push пишет запись истории, popstate снимает верхний экран', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('browser');
  useNav.getState().push('browser', { kind: 'entity', id: E1 });
  expect(window.location.pathname).toBe(`/entity/${E1}`);

  // Эмуляция системного жеста «назад»
  window.history.back();
  await waitFor(() => expect(useNav.getState().stacks.browser).toHaveLength(0));
  expect(window.location.pathname).toBe('/browser');
  uninstall();
});

test('D18: back на корне вкладки возвращает на вкладку, с которой пришли', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('chat');
  useNav.getState().switchTab('budget');
  expect(window.location.pathname).toBe('/budget');

  window.history.back();
  await waitFor(() => expect(useNav.getState().activeTab).toBe('chat'));
  uninstall();
});

test('применение popstate не порождает новых записей истории', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('browser');
  useNav.getState().push('browser', { kind: 'entity', id: E1 });
  const lenBefore = window.history.length;
  window.history.back();
  await waitFor(() => expect(useNav.getState().stacks.browser).toHaveLength(0));

  // ЧЕСТНО про этот ассерт: сам по себе он слабее, чем звучит. ОДИНОЧНЫЙ лишний pushState
  // внутри обработчика popstate длину НЕ меняет — усечение forward-хвоста и добавление
  // записи гасят друг друга. Оставляем его сторожем грубых случаев (несколько записей
  // за одно применение), но ловит петлю не он.
  expect(window.history.length).toBe(lenBefore);

  // Вот настоящий детектор: петля затирает forward-хвост, и «вперёд» становится некуда —
  // при петле здесь остался бы /browser и пустой стек.
  window.history.forward();
  await waitFor(() => expect(window.location.pathname).toBe(`/entity/${E1}`));
  expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: E1 }]);
  uninstall();
});

test('push в НЕактивную вкладку не пишет запись истории', () => {
  const uninstall = installHistorySync();
  const lenBefore = window.history.length;
  const pathBefore = window.location.pathname;
  // Видимая позиция (вкладка + глубина её стека) не изменилась — писать нечего.
  useNav.getState().push('budget', { kind: 'budget-transactions' });
  expect(window.history.length).toBe(lenBefore);
  expect(window.location.pathname).toBe(pathBefore);
  uninstall();
});

test('шаг стека без собственного маршрута тоже переживает back', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('budget');
  // У «Транзакций» нет внешней ссылки: путь остаётся корнем вкладки, а шаг стека
  // держит запись истории — иначе back с них ничего бы не снял.
  useNav.getState().push('budget', { kind: 'budget-transactions' });
  expect(window.location.pathname).toBe('/budget');

  window.history.back();
  await waitFor(() => expect(useNav.getState().stacks.budget).toHaveLength(0));
  expect(useNav.getState().activeTab).toBe('budget');
  uninstall();
});

test('forward восстанавливает экран БЕЗ собственного маршрута, а не корень вкладки', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('budget');
  useNav.getState().push('budget', { kind: 'budget-transactions' });

  window.history.back();
  await waitFor(() => expect(useNav.getState().stacks.budget).toEqual([]));

  // Пути тут не хватило бы: /budget — это и корень вкладки тоже. Экран приезжает
  // из самой записи истории, поэтому «вперёд» возвращает именно «Транзакции».
  window.history.forward();
  await waitFor(() =>
    expect(useNav.getState().stacks.budget).toEqual([{ kind: 'budget-transactions' }]),
  );
  uninstall();
});

test('«назад» после «К бюджету» возвращает на экран импорта, а не в пустоту', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('budget');
  useNav.getState().push('budget', { kind: 'budget-import' });
  // Импорт закрывается переходом ВПЕРЁД на Overview — запись {budget, 1, импорт} остаётся
  // позади. Если бы в ней лежал только путь (/budget — он же корень вкладки), «назад»
  // не менял бы ничего: два мёртвых нажатия подряд.
  closeToBudgetOverview();
  expect(useNav.getState().stacks.budget).toEqual([]);

  window.history.back();
  await waitFor(() => expect(useNav.getState().stacks.budget).toEqual([{ kind: 'budget-import' }]));
  uninstall();
});

test('битая запись истории не ломает стор: фолбэк по пути', async () => {
  const uninstall = installHistorySync();
  // Чужая запись может нести что угодно — экран из неё нельзя брать на веру,
  // иначе роутер получит неизвестный kind и упадёт на renderScreen.
  window.history.pushState(
    { tab: 'browser', depth: 4, screen: { kind: 'нечто-постороннее' } },
    '',
    `/entity/${E1}`,
  );
  useNav.getState().switchTab('budget');

  window.history.back();
  await waitFor(() => expect(useNav.getState().activeTab).toBe('browser'));
  // Запись отброшена целиком, экран восстановлен по пути.
  expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: E1 }]);
  uninstall();
});

test('прыжок через две записи оставляет стор и запись истории согласованными', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('browser');
  useNav.getState().push('browser', { kind: 'entity', id: E1 });
  useNav.getState().push('browser', { kind: 'entity', id: E2 });

  // Так ходят выпадающим списком браузера и долгим тапом по «назад».
  window.history.go(-2);
  await waitFor(() => expect(useNav.getState().stacks.browser).toEqual([]));

  window.history.go(2);
  await waitFor(() =>
    expect(useNav.getState().stacks.browser.at(-1)).toEqual({ kind: 'entity', id: E2 }),
  );

  // Запись обязана описывать то, что РЕАЛЬНО в сторе: глубину, которой в стеке нет,
  // восстановить не из чего, и оставить в записи прежнее число значило бы соврать —
  // следующий «назад» собрал бы стек не из тех экранов.
  const state = window.history.state as { tab: string; depth: number; screen: unknown };
  const stack = useNav.getState().stacks.browser;
  expect(state.tab).toBe('browser');
  expect(state.depth).toBe(stack.length);
  expect(state.screen).toEqual(stack.at(-1) ?? null);

  // И следующий «назад» снимает ровно один уровень.
  window.history.back();
  await waitFor(() =>
    expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: E1 }]),
  );
  uninstall();
});

test('forward восстанавливает снятый экран из записи', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('browser');
  useNav.getState().push('browser', { kind: 'entity', id: E1 });
  useNav.getState().push('browser', { kind: 'entity', id: E2 });

  window.history.back();
  await waitFor(() => expect(useNav.getState().stacks.browser).toHaveLength(1));
  expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: E1 }]);

  window.history.forward();
  await waitFor(() => expect(useNav.getState().stacks.browser).toHaveLength(2));
  expect(useNav.getState().stacks.browser).toEqual([
    { kind: 'entity', id: E1 },
    { kind: 'entity', id: E2 },
  ]);
  uninstall();
});

test('повторная установка (StrictMode) не плодит записи истории и подписки', () => {
  const first = installHistorySync();
  const second = installHistorySync();
  const lenBefore = window.history.length;
  useNav.getState().switchTab('browser');
  // Одна видимая смена позиции — ровно одна новая запись, а не две.
  expect(window.history.length).toBe(lenBefore + 1);
  first();
  second();
});

test('кнопка «Назад» и системный жест дают одинаковый результат', async () => {
  const uninstall = installHistorySync();
  useNav.getState().switchTab('browser');
  useNav.getState().push('browser', { kind: 'entity', id: E1 });
  useNav.getState().push('browser', { kind: 'entity', id: E2 });
  renderWithProviders(<App />, handler);

  // Ветка 1: кнопка шапки
  await waitFor(() => expect(screen.getByTestId('nav-back')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('nav-back'));
  await waitFor(() => expect(useNav.getState().stacks.browser).toHaveLength(1));
  const afterButton = {
    activeTab: useNav.getState().activeTab,
    stack: useNav.getState().stacks.browser,
    path: window.location.pathname,
  };

  // Возврат в ту же позицию и ветка 2: системный жест
  useNav.getState().push('browser', { kind: 'entity', id: E2 });
  await waitFor(() => expect(useNav.getState().stacks.browser).toHaveLength(2));
  window.history.back();
  await waitFor(() => expect(useNav.getState().stacks.browser).toHaveLength(1));
  const afterGesture = {
    activeTab: useNav.getState().activeTab,
    stack: useNav.getState().stacks.browser,
    path: window.location.pathname,
  };

  expect(afterGesture).toEqual(afterButton);
  uninstall();
});
