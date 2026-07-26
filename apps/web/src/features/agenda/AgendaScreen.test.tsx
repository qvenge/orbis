// Task D1 — Agenda-lite (02-core-os §4). Фикстуры повторяют приёмку §8.1–8.4:
// граница «Просроченного» (чистые события не входят), задача с due_date, дедуп
// task+schedule, дневные секции только по orbis/schedule.
//
// «Сегодня» на клиенте шва не имеет — фикстуры строятся ОТНОСИТЕЛЬНО todayISO(TZ)
// и addDays (прецедент TransactionsScreen.test.tsx), поэтому тест не протухает.
import { addDays } from '@orbis/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { App } from '../../App';
import { ActiveScreen } from '../../app/router';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders, trpcError } from '../../test/harness';
import { todayISO } from '../budget/useBudget';
import { AgendaScreen } from './AgendaScreen';
import {
  AGENDA_DAYS_QUERY,
  AGENDA_OVERDUE_DUE_QUERY,
  AGENDA_OVERDUE_START_QUERY,
} from './useAgenda';

const TZ = 'Europe/Moscow';
const today = todayISO(TZ);
const tomorrow = addDays(today, 1);
const yesterday = addDays(today, -1);

/** Момент 'YYYY-MM-DDTHH:MM:00+03:00' — фиксированное смещение Europe/Moscow. */
const at = (day: string, time: string) => `${day}T${time}:00+03:00`;

/** Ожидаемая подпись даты «24 июл.» — считается независимо от кода экрана. */
const dayLabel = (day: string) =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );

const ent = (id: string, title: string, aspects: Record<string, Record<string, unknown>>) => ({
  id,
  ownerId: 'u',
  title,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects,
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

const settings = {
  timezone: TZ,
  defaultCurrency: 'RUB',
  weekStartDay: 1,
  installedViews: [],
  pinnedEntities: [],
};

type Fixtures = { days?: unknown[]; overdueDue?: unknown[]; overdueStart?: unknown[] };

// Роутинг мока по ТОЧНОЙ строке запроса: несовпадение строки грамматики валит тест
// (unknown query → пустая выдача во всех секциях), а не проходит молча.
const agendaHandler =
  (f: Fixtures): MockHandler =>
  (path, input) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.query') {
      const q = (input as { query: string }).query;
      if (q === AGENDA_DAYS_QUERY) return f.days ?? [];
      if (q === AGENDA_OVERDUE_DUE_QUERY) return f.overdueDue ?? [];
      if (q === AGENDA_OVERDUE_START_QUERY) return f.overdueStart ?? [];
      return [];
    }
    return {};
  };

const overdueSection = () => screen.getByTestId('agenda-overdue');
const daySection = (date: string) => screen.getByTestId(`agenda-day-${date}`);
const rowTitles = (el: HTMLElement) =>
  within(el)
    .queryAllByTestId('agenda-row')
    .map((r) => r.getAttribute('data-title'));

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'agenda',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

// --- строки грамматики (§6.1) ---------------------------------------------------------

test('Agenda шлёт три запроса грамматики §6.1 дословно', async () => {
  const { calls } = renderWithProviders(<AgendaScreen />, agendaHandler({}));

  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'entity.query').length).toBeGreaterThanOrEqual(3),
  );
  const queries = calls
    .filter((c) => c.path === 'entity.query')
    .map((c) => (c.input as { query: string }).query);

  // Окно §4.1: только orbis/schedule, сегодня+7, потолок 200 (K18)
  expect(queries).toContain(
    'aspect=orbis/schedule, start_at=today|next_7d, sortBy=start_at:asc, limit=200',
  );
  // §4.2 п.1 — due_date не материализуемое поле, дешёвый путь, отдельный запрос (K16)
  expect(queries).toContain(
    'aspect=orbis/task, due_date=overdue, status=!done&!cancelled, sortBy=due_date:asc, limit=200',
  );
  // §4.2 п.2 — два aspect= в одном запросе (K14): чистые события сюда не попадают
  expect(queries).toContain(
    'aspect=orbis/task, aspect=orbis/schedule, start_at=overdue, status=!done&!cancelled, sortBy=start_at:asc, limit=200',
  );
});

// --- приёмка §8 -----------------------------------------------------------------------

test('§8.1: прошедшее чистое событие не попадает ни в «Просроченное», ни в дневные секции', async () => {
  // Событие вчера: обе выборки «Просроченного» требуют aspect=orbis/task, поэтому
  // сервер его не отдаст; окно дней клиент режет сам — вчерашний день вне горизонта.
  const past = ent('ev-past', 'Прошедший созвон', {
    'orbis/schedule': { start_at: at(yesterday, '10:00') },
  });
  renderWithProviders(<AgendaScreen />, agendaHandler({ days: [past] }));

  await waitFor(() => expect(daySection(today)).toBeInTheDocument());
  expect(screen.queryByTestId('agenda-overdue')).toBeNull();
  expect(screen.queryByText('Прошедший созвон')).toBeNull();
});

test('§8.2: незакрытая задача с прошедшим due_date — в «Просроченном» и не в дневных секциях', async () => {
  const task = ent('t1', 'Закончить API', {
    'orbis/task': { status: 'in_progress', due_date: yesterday },
  });
  renderWithProviders(<AgendaScreen />, agendaHandler({ overdueDue: [task] }));

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  expect(rowTitles(overdueSection())).toEqual(['Закончить API']);
  // §4.1: задачи без orbis/schedule в дневные секции не попадают
  expect(rowTitles(daySection(today))).toEqual([]);
});

test('§8.3: task+schedule с обеими прошедшими датами — одна строка «Просроченного»', async () => {
  const both = ent('t2', 'Подтвердить созвон', {
    'orbis/task': { status: 'planned', due_date: addDays(today, -3) },
    'orbis/schedule': { start_at: at(yesterday, '09:00') },
  });
  // Сущность приходит В ОБЕИХ выборках — слияние по id (§4.2)
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ overdueDue: [both], overdueStart: [both] }),
  );

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  expect(rowTitles(overdueSection())).toEqual(['Подтвердить созвон']);
  expect(screen.getByTestId('agenda-overdue-count')).toHaveTextContent('1');
});

test('§8.3: сортировка «Просроченного» — старейшие сверху по более ранней из дат', async () => {
  // У 'later' due_date новее, но start_at старее — релевантная дата = более ранняя
  const later = ent('t-late', 'Позже по сроку', {
    'orbis/task': { status: 'planned', due_date: addDays(today, -1) },
    'orbis/schedule': { start_at: at(addDays(today, -10), '09:00') },
  });
  const older = ent('t-old', 'Просрочено давно', {
    'orbis/task': { status: 'planned', due_date: addDays(today, -5) },
  });
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ overdueDue: [later, older], overdueStart: [later] }),
  );

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  expect(rowTitles(overdueSection())).toEqual(['Позже по сроку', 'Просрочено давно']);
});

test('§8.4: задача с orbis/schedule попадает в свой день', async () => {
  const scheduled = ent('t3', 'Врач', {
    'orbis/task': { status: 'planned' },
    'orbis/schedule': { start_at: at(tomorrow, '14:00') },
  });
  renderWithProviders(<AgendaScreen />, agendaHandler({ days: [scheduled] }));

  await waitFor(() => expect(rowTitles(daySection(tomorrow))).toEqual(['Врач']));
  expect(rowTitles(daySection(today))).toEqual([]);
  expect(within(daySection(tomorrow)).getByText('14:00')).toBeInTheDocument();
});

// --- §4.1: шаблоны, пустые дни, порядок внутри дня ------------------------------------

test('§4.1: recurring-шаблон скрыт, инстанс виден', async () => {
  const template = ent('tpl', 'Стендап (шаблон)', {
    'orbis/schedule': {
      start_at: at(today, '09:00'),
      recurrence: { freq: 'daily', interval: 1 },
    },
  });
  const instance = ent('inst', 'Стендап', {
    'orbis/schedule': { start_at: at(today, '09:00') },
  });
  renderWithProviders(<AgendaScreen />, agendaHandler({ days: [template, instance] }));

  await waitFor(() => expect(rowTitles(daySection(today))).toEqual(['Стендап']));
  expect(screen.queryByText('Стендап (шаблон)')).toBeNull();
});

test('§4.1: горизонт — 8 секций, пустой день показывает «день свободен»', async () => {
  const event = ent('ev', 'Стендап', { 'orbis/schedule': { start_at: at(today, '09:00') } });
  renderWithProviders(<AgendaScreen />, agendaHandler({ days: [event] }));

  await waitFor(() => expect(screen.getAllByTestId(/^agenda-day-/)).toHaveLength(8));
  expect(daySection(addDays(today, 7))).toBeInTheDocument();
  // Секция дня не скрывается — горизонт читается целиком
  expect(within(daySection(tomorrow)).getByText('день свободен')).toBeInTheDocument();
  expect(within(daySection(today)).queryByText('день свободен')).toBeNull();
});

test('§4.1: all_day — в начале дня с пометкой «весь день», далее по времени start_at', async () => {
  // Сервер уже отсортировал по start_at:asc; all_day поднимается клиентом
  const days = [
    ent('e1', 'Стендап', { 'orbis/schedule': { start_at: at(today, '09:00') } }),
    ent('e2', 'Отпуск: день 1', {
      'orbis/schedule': { start_at: at(today, '00:00'), all_day: true },
    }),
    ent('e3', 'Врач', {
      'orbis/schedule': { start_at: at(today, '14:00'), end_at: at(today, '15:30') },
    }),
  ];
  renderWithProviders(<AgendaScreen />, agendaHandler({ days }));

  await waitFor(() =>
    expect(rowTitles(daySection(today))).toEqual(['Отпуск: день 1', 'Стендап', 'Врач']),
  );
  expect(within(daySection(today)).getByText('весь день')).toBeInTheDocument();
  // Диапазон при end_at (§4.1) — время в таймзоне пользователя
  expect(within(daySection(today)).getByText('14:00–15:30')).toBeInTheDocument();
});

test('§4.2: recurring-шаблон не висит в «Просроченном» (фильтр действует и там)', async () => {
  // Якорный start_at шаблона в прошлом и его due_date старше живой задачи: сними фильтр —
  // шаблон встанет ПЕРВОЙ строкой секции и счётчик покажет 2.
  const template = ent('tpl', 'Стендап (шаблон)', {
    'orbis/task': { status: 'planned', due_date: addDays(today, -3) },
    'orbis/schedule': {
      start_at: at(addDays(today, -10), '09:00'),
      recurrence: { freq: 'daily', interval: 1 },
    },
  });
  const task = ent('t1', 'Закончить API', {
    'orbis/task': { status: 'planned', due_date: yesterday },
  });
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ overdueDue: [template, task], overdueStart: [template] }),
  );

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  expect(rowTitles(overdueSection())).toEqual(['Закончить API']);
  expect(screen.getByTestId('agenda-overdue-count')).toHaveTextContent('1');
});

// --- релевантная дата строки «Просроченного» (мокап §4: «срок был 11.06») --------------

test('§4.2: строка «Просроченного» подписана релевантной датой, а не будущим сроком', async () => {
  // start_at вчера, due_date послезавтра: сущность просрочена по РАСПИСАНИЮ, и подпись
  // строки обязана показывать именно эту дату (EntityRow справа печатает due_date).
  const task = ent('t1', 'Подтвердить созвон', {
    'orbis/task': { status: 'planned', due_date: addDays(today, 2) },
    'orbis/schedule': { start_at: at(yesterday, '09:00') },
  });
  renderWithProviders(<AgendaScreen />, agendaHandler({ overdueStart: [task] }));

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  expect(within(overdueSection()).getByText(`был ${dayLabel(yesterday)}`)).toBeInTheDocument();
  // Task D2b: мета EntityRow подавлена — БУДУЩЕГО срока в красной секции быть не может
  expect(within(overdueSection()).queryByText(dayLabel(addDays(today, 2)))).toBeNull();
});

test('§4.2 (D2b): в строке «Просроченного» дата печатается ровно один раз', async () => {
  // Самая частая строка секции — задача со сроком вчера. Своя подпись слева и мета
  // EntityRow справа печатали ОДНУ И ТУ ЖЕ дату: «был 24 июл. … 24 июл.».
  const task = ent('t1', 'Закончить API', {
    'orbis/task': { status: 'in_progress', due_date: yesterday },
  });
  renderWithProviders(<AgendaScreen />, agendaHandler({ overdueDue: [task] }));

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  expect(within(overdueSection()).getAllByText(`был ${dayLabel(yesterday)}`)).toHaveLength(1);
  // Голая дата отдельным узлом — ровно та вторая печать, которой быть не должно
  expect(within(overdueSection()).queryByText(dayLabel(yesterday))).toBeNull();
});

test('§4.2 (D2c): у просроченного платежа сумма остаётся — подавлять нечего', async () => {
  // EntityRow выбирает мету по приоритету: financial → СУММА (не дата). Дублирования
  // даты в такой строке нет вовсе, поэтому подавление меты D2b здесь только съедало бы
  // сумму — единственное, ради чего строка платежа и открывается.
  const payment = ent('t1', 'Оплатить интернет', {
    'orbis/task': { status: 'planned', due_date: yesterday },
    'orbis/financial': { amount: '1200.00', direction: 'expense' },
  });
  renderWithProviders(<AgendaScreen />, agendaHandler({ overdueDue: [payment] }));

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  // '−' здесь U+2212, разделитель групп — обычный пробел (lib/format.ts formatMoney)
  expect(within(overdueSection()).getByText('−1 200.00')).toBeInTheDocument();
  expect(within(overdueSection()).getByText(`был ${dayLabel(yesterday)}`)).toBeInTheDocument();
  // Дата по-прежнему ровно одна: справа стоит сумма, а не вторая печать срока
  expect(within(overdueSection()).queryByText(dayLabel(yesterday))).toBeNull();
});

test('§4.2 (D2b): мета EntityRow подавлена ТОЛЬКО в «Просроченном» — в дневных секциях она есть', async () => {
  // Дефолт пропа EntityRow общий с Browser: сменить его молча = сломать вторую поверхность.
  // due_date (date-only) форматируется в UTC — узел детерминирован, в отличие от start_at.
  const scheduled = ent('t3', 'Врач', {
    'orbis/task': { status: 'planned', due_date: tomorrow },
    'orbis/schedule': { start_at: at(tomorrow, '14:00') },
  });
  renderWithProviders(<AgendaScreen />, agendaHandler({ days: [scheduled] }));

  await waitFor(() => expect(rowTitles(daySection(tomorrow))).toEqual(['Врач']));
  expect(within(daySection(tomorrow)).getByText(dayLabel(tomorrow))).toBeInTheDocument();
});

// --- пользовательские строки экрана (D2c) ---------------------------------------------

test('D2c: шапка и плашка ошибки называют экран «Повесткой», а не «Agenda»', async () => {
  // Пользователь жмёт вкладку «Повестка» (слово владельца 2026-07-25) — экран, на который
  // он попадает, обязан называться так же. Идентификаторы и testid при этом не меняются.
  renderWithProviders(<AgendaScreen />, (path, input) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.query') {
      const q = (input as { query: string }).query;
      if (q === AGENDA_DAYS_QUERY) throw trpcError('INTERNAL_SERVER_ERROR');
      return [];
    }
    return {};
  });

  expect(screen.getByRole('heading', { level: 1, name: 'Повестка' })).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByText('Не удалось загрузить повестку')).toBeInTheDocument(),
  );
});

// --- таймзона: раскладка ждёт настроек ------------------------------------------------

test('настройки ещё грузятся → скелетон, а не раскладка в таймзоне браузера', async () => {
  // Выборки пришли, user.getSettings висит: группировать по дням и считать локальный
  // день start_at сейчас нечем (§4 «сегодня» — в таймзоне пользователя).
  const event = ent('e1', 'Стендап', { 'orbis/schedule': { start_at: at(today, '09:00') } });
  const task = ent('t1', 'Закончить API', {
    'orbis/task': { status: 'planned', due_date: yesterday },
  });
  const { calls } = renderWithProviders(<AgendaScreen />, (path, input) => {
    if (path === 'user.getSettings') return new Promise(() => {}); // настройки не приходят
    if (path === 'entity.query') {
      const q = (input as { query: string }).query;
      if (q === AGENDA_DAYS_QUERY) return [event];
      if (q === AGENDA_OVERDUE_DUE_QUERY) return [task];
      return [];
    }
    return {};
  });

  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'entity.query').length).toBeGreaterThanOrEqual(3),
  );
  await waitFor(() => expect(screen.getAllByLabelText('Загрузка').length).toBeGreaterThan(0));
  expect(screen.queryAllByTestId(/^agenda-day-/)).toHaveLength(0);
  expect(screen.queryByTestId('agenda-overdue')).toBeNull();
});

// --- потолок выборки (K18, урок C6) ---------------------------------------------------

test('«Просроченное»: при упоре в потолок счётчик показывает «200+», а не молчит', async () => {
  const many = Array.from({ length: 200 }, (_, i) =>
    ent(`t${i}`, `Задача ${i}`, { 'orbis/task': { status: 'planned', due_date: yesterday } }),
  );
  renderWithProviders(<AgendaScreen />, agendaHandler({ overdueDue: many }));

  await waitFor(() => expect(screen.getByTestId('agenda-overdue-count')).toHaveTextContent('200+'));
});

// --- навигация ------------------------------------------------------------------------

test('тап по строке пушит detail в стек вкладки agenda', async () => {
  const event = ent('e1', 'Стендап', { 'orbis/schedule': { start_at: at(today, '09:00') } });
  renderWithProviders(<AgendaScreen />, agendaHandler({ days: [event] }));

  await waitFor(() => expect(rowTitles(daySection(today))).toEqual(['Стендап']));
  fireEvent.click(within(daySection(today)).getAllByTestId('agenda-row')[0] as HTMLElement);

  expect(useNav.getState().stacks.agenda.at(-1)).toEqual({ kind: 'entity', id: 'e1' });
});

// --- §8.2: элемент ПОКИДАЕТ секцию после действия (полный путь через detail) -----------
//
// Единственный способ закрыть/архивировать задачу из Agenda — push detail (§4.2, §1.1).
// Выборки Agenda держат staleTime 60 с (K16) и refetchOnWindowFocus выключен, поэтому
// после «Готово» секция обновится ТОЛЬКО если mutation инвалидирует entity.query.
// Тест гоняет ActiveScreen (реальный роутер), чтобы поймать разрыв между экранами.

/** Мок «живого сервера»: закрытая задача перестаёт попадать в status=!done&!cancelled. */
function overdueRoundTripHandler(task: ReturnType<typeof ent>, state: { closed: boolean }) {
  const handler: MockHandler = (path, input) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.query') {
      const q = (input as { query: string }).query;
      if (q === AGENDA_OVERDUE_DUE_QUERY) return state.closed ? [] : [task];
      return [];
    }
    if (path === 'entity.get')
      return { entity: task, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') {
      state.closed = true;
      return task;
    }
    if (path === 'relation.listFor') return [];
    if (path === 'aspect.list') return [];
    return {};
  };
  return handler;
}

test('§8.2: «Готово» на detail-экране убирает задачу из «Просроченного» после «Назад»', async () => {
  const task = ent('t1', 'Закончить API', {
    'orbis/task': { status: 'in_progress', due_date: yesterday },
  });
  const state = { closed: false };
  renderWithProviders(<ActiveScreen />, overdueRoundTripHandler(task, state));

  await waitFor(() => expect(rowTitles(overdueSection())).toEqual(['Закончить API']));
  fireEvent.click(within(overdueSection()).getAllByTestId('agenda-row')[0] as HTMLElement);

  const checkbox = await screen.findByRole('checkbox', { name: /готово/i });
  fireEvent.click(checkbox);
  await waitFor(() => expect(state.closed).toBe(true));

  fireEvent.click(screen.getByTestId('nav-back'));
  // Секция исчезает целиком: последняя просроченная строка ушла, счётчик обнулился
  await waitFor(() => expect(screen.queryByTestId('agenda-overdue')).toBeNull());
});

test('§8.2: архивация на detail-экране убирает задачу из «Просроченного» после «Назад»', async () => {
  const task = ent('t1', 'Закончить API', {
    'orbis/task': { status: 'in_progress', due_date: yesterday },
  });
  const state = { closed: false }; // архив сервер тоже исключает из выборок
  renderWithProviders(<ActiveScreen />, overdueRoundTripHandler(task, state));

  await waitFor(() => expect(rowTitles(overdueSection())).toEqual(['Закончить API']));
  fireEvent.click(within(overdueSection()).getAllByTestId('agenda-row')[0] as HTMLElement);

  fireEvent.click(await screen.findByRole('button', { name: /архив/i }));
  await waitFor(() => expect(state.closed).toBe(true));

  fireEvent.click(screen.getByTestId('nav-back'));
  await waitFor(() => expect(screen.queryByTestId('agenda-overdue')).toBeNull());
});

// --- Бейдж вкладки Agenda (§1.5, Task D2) ---------------------------------------------
//
// Бейдж смонтирован на ЛЮБОМ экране (K16), поэтому тесты рендерят App с активным табом
// chat: счётчик обязан работать без открытия вкладки. Обе поверхности навигации
// (TabBar и SidebarNav) в jsdom присутствуют одновременно — B1-прецедент бейджа Budget.

/** Активный таб — chat: вкладка Agenda закрыта, бейдж обязан жить сам по себе. */
function onChatTab() {
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
}

const overdueTask = ent('t1', 'Закончить API', {
  'orbis/task': { status: 'in_progress', due_date: yesterday },
});

test('бейдж Agenda: просроченное>0 → число в tab-bar И sidebar, вкладка не открыта', async () => {
  onChatTab();
  renderWithProviders(<App />, agendaHandler({ overdueDue: [overdueTask] }));

  await waitFor(() => expect(screen.getByTestId('agenda-badge')).toHaveTextContent('1'));
  expect(screen.getByTestId('sidebar-agenda-badge')).toHaveTextContent('1');
  // Экран Agenda не смонтирован — источник числа именно бейдж, а не открытая секция
  expect(screen.queryByTestId('agenda-overdue')).toBeNull();
});

test('просроченного нет → бейджа Agenda нет ни в одной поверхности', async () => {
  onChatTab();
  const { calls } = renderWithProviders(<App />, agendaHandler({}));

  await waitFor(() => expect(screen.getByTestId('tab-agenda')).toBeInTheDocument());
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.path === 'entity.query' &&
          (c.input as { query: string }).query === AGENDA_OVERDUE_DUE_QUERY,
      ),
    ).toBe(true),
  );
  expect(screen.queryByTestId('agenda-badge')).toBeNull();
  expect(screen.queryByTestId('sidebar-agenda-badge')).toBeNull();
});

test('ошибка запроса «Просроченного» → бейджа нет, вкладка Agenda жива', async () => {
  onChatTab();
  renderWithProviders(<App />, (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.query') throw trpcError('INTERNAL_SERVER_ERROR');
    return {};
  });

  await waitFor(() => expect(screen.getByTestId('tab-agenda')).toBeInTheDocument());
  expect(screen.getByTestId('sidebar-agenda')).toBeInTheDocument();
  expect(screen.queryByTestId('agenda-badge')).toBeNull();
  expect(screen.queryByTestId('sidebar-agenda-badge')).toBeNull();
});

test('D2b: отказ ОДНОЙ из двух выборок → бейджа нет ни в одной поверхности, вкладка жива', async () => {
  // start_at упал, due_date вернул строку: «1» на бейдже читалось бы как полная картина,
  // хотя часть просроченного не пришла. Заниженный счётчик хуже отсутствующего
  // (прецедент Budget: ошибка alertCount → бейджа нет).
  const task = ent('t1', 'Закончить API', {
    'orbis/task': { status: 'in_progress', due_date: yesterday },
  });
  renderWithProviders(<App />, (path, input) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.query') {
      const q = (input as { query: string }).query;
      if (q === AGENDA_OVERDUE_START_QUERY) throw trpcError('INTERNAL_SERVER_ERROR');
      if (q === AGENDA_OVERDUE_DUE_QUERY) return [task];
      return [];
    }
    return {};
  });

  // Успешная выборка дошла до экрана — значит бейджу было чем занизиться (не тавтология)
  await waitFor(() => expect(rowTitles(overdueSection())).toEqual(['Закончить API']));
  expect(screen.queryByTestId('agenda-badge')).toBeNull();
  expect(screen.queryByTestId('sidebar-agenda-badge')).toBeNull();
  // Плашка неполноты на самой вкладке остаётся: сигнал не теряется, он переезжает
  expect(screen.getByText('Не удалось загрузить просроченное')).toBeInTheDocument();
  expect(screen.getByTestId('tab-agenda')).toBeInTheDocument();
});

test('бейдж при упоре в потолок показывает «200+», а не усечённое число', async () => {
  onChatTab();
  const many = Array.from({ length: 200 }, (_, i) =>
    ent(`t${i}`, `Задача ${i}`, { 'orbis/task': { status: 'planned', due_date: yesterday } }),
  );
  renderWithProviders(<App />, agendaHandler({ overdueDue: many }));

  await waitFor(() => expect(screen.getByTestId('agenda-badge')).toHaveTextContent('200+'));
  expect(screen.getByTestId('sidebar-agenda-badge')).toHaveTextContent('200+');
});

test('бейдж и вкладка делят один источник: второго запроса «Просроченного» нет', async () => {
  // Таб agenda: хук зовут ТРИ компонента (TabBar, SidebarNav, AgendaScreen) — на сервер
  // при этом уходит ровно один запрос на каждую из двух выборок §4.2.
  const { calls } = renderWithProviders(<App />, agendaHandler({ overdueDue: [overdueTask] }));

  await waitFor(() => expect(screen.getByTestId('agenda-badge')).toHaveTextContent('1'));
  expect(rowTitles(overdueSection())).toEqual(['Закончить API']);
  const overdueCalls = calls
    .filter((c) => c.path === 'entity.query')
    .map((c) => (c.input as { query: string }).query)
    .filter((q) => q === AGENDA_OVERDUE_DUE_QUERY || q === AGENDA_OVERDUE_START_QUERY);
  expect(overdueCalls).toHaveLength(2);
});
