// Task D1 — Agenda-lite (02-core-os §4). Фикстуры повторяют приёмку §8.1–8.4:
// граница «Просроченного» (чистые события не входят), задача с due_date, дедуп
// task+schedule, дневные секции только по orbis/schedule.
//
// «Сегодня» на клиенте шва не имеет — фикстуры строятся ОТНОСИТЕЛЬНО todayISO(TZ)
// и addDays (прецедент TransactionsScreen.test.tsx), поэтому тест не протухает.
import { addDays } from '@orbis/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders } from '../../test/harness';
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
