// Task D1 — Повестка (02-core-os §4). Фикстуры повторяют приёмку §8.1–8.4: граница
// «Просроченного» (чистые события не входят), задача с due_date, слияние task+schedule,
// дневные секции только по слоту `moment`.
//
// Отбор строк уехал на сервер (§А5-5): фикстура здесь — ОТВЕТ подписки, то есть уже
// разложенные по секциям строки. Что именно попадает в секцию, меряет живая приёмка
// (`apps/server/src/routers/agenda-acceptance.test.ts`); здесь — что экран делает с ответом.
//
// «Сегодня» на клиенте шва не имеет — фикстуры строятся ОТНОСИТЕЛЬНО todayISO(TZ)
// и addDays (прецедент TransactionsScreen.test.tsx), поэтому тест не протухает.
import { type AgendaRow, addDays } from '@orbis/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { App } from '../../App';
import { ActiveScreen } from '../../app/router';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders, trpcError, wireEntity } from '../../test/harness';
import { todayISO } from '../budget/useBudget';
import { AgendaScreen } from './AgendaScreen';

const TZ = 'Europe/Moscow';
const today = todayISO(TZ);
const tomorrow = addDays(today, 1);
const yesterday = addDays(today, -1);

// Меню ⋮ detail (§8.2 ниже проходит через него) Radix позиционирует через floating-ui, а
// тот следит за размерами якоря ResizeObserver'ом — в jsdom его нет вовсе. Заглушка молчит:
// раскладку тут не проверяют, важно лишь, что содержимое меню монтируется, а не падает.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

/** Момент 'YYYY-MM-DDTHH:MM:00+03:00' — фиксированное смещение Europe/Moscow. */
const at = (day: string, time: string) => `${day}T${time}:00+03:00`;

/** Ожидаемая подпись даты «24 июл.» — считается независимо от кода экрана. */
const dayLabel = (day: string) =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );

/**
 * Строка выдачи `entity.query`: значения — плоско в `props` по id свойства, аспекты —
 * СПИСКОМ (§А1-1). Форму собирает фабрика производителя (`wireEntity`), поэтому старая карта
 * в фикстуре — проекция этой же пары, а не второй рукописный источник.
 */
const ent = (id: string, title: string, props: Record<string, unknown>, aspects: string[]) =>
  wireEntity({ id, title, props, aspects });

const settings = {
  timezone: TZ,
  defaultCurrency: 'RUB',
  weekStartDay: 1,
  installedViews: [],
  pinnedEntities: [],
};

type Fixtures = {
  window?: AgendaRow[];
  overdue?: AgendaRow[];
  truncated?: { window: boolean; overdue: boolean };
};

const agendaHandler =
  (f: Fixtures): MockHandler =>
  (path) => {
    if (path === 'user.getSettings') return settings;
    if (path !== 'agenda.list') return {};
    return {
      today,
      timezone: TZ,
      rows: [...(f.window ?? []), ...(f.overdue ?? [])],
      truncated: f.truncated ?? { window: false, overdue: false },
    };
  };

/** Строка окна: `at` — момент как есть, клиент раскладывает по нему день и время. */
const win = (e: ReturnType<typeof ent>, at: string, allDay = false): AgendaRow => ({
  entity: e,
  section: 'window',
  at,
  slot: 'moment',
  allDay,
});
/** Строка просроченного: `at` — релевантная ДАТА, её выбрал сервер минимумом двух. */
const late = (
  e: ReturnType<typeof ent>,
  at: string,
  slot: 'deadline' | 'moment' = 'deadline',
): AgendaRow => ({ entity: e, section: 'overdue', at, slot, allDay: false });

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

// --- граница вкладки (§А5-5) -----------------------------------------------------------

test('Повестка шлёт ОДНУ подписку agenda.list с горизонтом вкладки', async () => {
  const { calls } = renderWithProviders(<AgendaScreen />, agendaHandler({}));
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'agenda.list').length).toBeGreaterThan(0),
  );
  expect(calls.filter((c) => c.path === 'entity.query')).toHaveLength(0);
  expect(calls.find((c) => c.path === 'agenda.list')?.input).toEqual({ days: 8 });
});

// --- приёмка §8 -----------------------------------------------------------------------

test('§8.1: прошедшее чистое событие не попадает ни в «Просроченное», ни в дневные секции', async () => {
  // Событие вчера: обе выборки «Просроченного» требуют aspect=orbis/task, поэтому
  // сервер его не отдаст; окно дней клиент режет сам — вчерашний день вне горизонта.
  const past = ent('ev-past', 'Прошедший созвон', { 'orbis/start_at': at(yesterday, '10:00') }, [
    'orbis/schedule',
  ]);
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ window: [win(past, at(yesterday, '10:00'))] }),
  );

  await waitFor(() => expect(daySection(today)).toBeInTheDocument());
  expect(screen.queryByTestId('agenda-overdue')).toBeNull();
  expect(screen.queryByText('Прошедший созвон')).toBeNull();
});

test('§8.2: незакрытая задача с прошедшим due_date — в «Просроченном» и не в дневных секциях', async () => {
  const task = ent(
    't1',
    'Закончить API',
    { 'orbis/task_status': 'in_progress', 'orbis/due_date': yesterday },
    ['orbis/task'],
  );
  renderWithProviders(<AgendaScreen />, agendaHandler({ overdue: [late(task, yesterday)] }));

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  expect(rowTitles(overdueSection())).toEqual(['Закончить API']);
  // §4.1: строк окна у неё нет — слот `moment` не заполнен
  expect(rowTitles(daySection(today))).toEqual([]);
});

test('§8.3: task+schedule с обеими прошедшими датами — одна строка «Просроченного»', async () => {
  const both = ent(
    't2',
    'Подтвердить созвон',
    {
      'orbis/task_status': 'planned',
      'orbis/due_date': addDays(today, -3),
      'orbis/start_at': at(yesterday, '09:00'),
    },
    ['orbis/task', 'orbis/schedule'],
  );
  // Слияние по id сделал сервер (§Б5-6) — сюда приезжает ОДНА строка секции
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ overdue: [late(both, addDays(today, -3))] }),
  );

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  expect(rowTitles(overdueSection())).toEqual(['Подтвердить созвон']);
  expect(screen.getByTestId('agenda-overdue-count')).toHaveTextContent('1');
});

test('§8.3: сортировка «Просроченного» — старейшие сверху по более ранней из дат', async () => {
  // У 'later' due_date новее, но start_at старее — релевантная дата = более ранняя
  const later = ent(
    't-late',
    'Позже по сроку',
    {
      'orbis/task_status': 'planned',
      'orbis/due_date': addDays(today, -1),
      'orbis/start_at': at(addDays(today, -10), '09:00'),
    },
    ['orbis/task', 'orbis/schedule'],
  );
  const older = ent(
    't-old',
    'Просрочено давно',
    { 'orbis/task_status': 'planned', 'orbis/due_date': addDays(today, -5) },
    ['orbis/task'],
  );
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({
      overdue: [late(later, addDays(today, -10), 'moment'), late(older, addDays(today, -5))],
    }),
  );

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  expect(rowTitles(overdueSection())).toEqual(['Позже по сроку', 'Просрочено давно']);
});

test('§8.4: задача с orbis/schedule попадает в свой день', async () => {
  const scheduled = ent(
    't3',
    'Врач',
    { 'orbis/task_status': 'planned', 'orbis/start_at': at(tomorrow, '14:00') },
    ['orbis/task', 'orbis/schedule'],
  );
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ window: [win(scheduled, at(tomorrow, '14:00'))] }),
  );

  await waitFor(() => expect(rowTitles(daySection(tomorrow))).toEqual(['Врач']));
  expect(rowTitles(daySection(today))).toEqual([]);
  expect(within(daySection(tomorrow)).getByText('14:00')).toBeInTheDocument();
});

// --- §4.1: шаблоны, пустые дни, порядок внутри дня ------------------------------------

test('§4.1: recurring-шаблон скрыт, инстанс виден', async () => {
  const template = ent(
    'tpl',
    'Стендап (шаблон)',
    { 'orbis/start_at': at(today, '09:00'), 'orbis/recurrence': { freq: 'daily', interval: 1 } },
    ['orbis/schedule'],
  );
  const instance = ent('inst', 'Стендап', { 'orbis/start_at': at(today, '09:00') }, [
    'orbis/schedule',
  ]);
  // Шаблон прячет СЕРВЕР (набор `templates`, §Б5-6) — в ответе подписки его нет вовсе
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ window: [win(instance, at(today, '09:00'))] }),
  );

  await waitFor(() => expect(rowTitles(daySection(today))).toEqual(['Стендап']));
  expect(screen.queryByText('Стендап (шаблон)')).toBeNull();
  expect(template.props['orbis/recurrence']).toBeDefined(); // фикстура шаблона осмысленна
});

test('§4.1: горизонт — 8 секций, пустой день показывает «день свободен»', async () => {
  const event = ent('ev', 'Стендап', { 'orbis/start_at': at(today, '09:00') }, ['orbis/schedule']);
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ window: [win(event, at(today, '09:00'))] }),
  );

  await waitFor(() => expect(screen.getAllByTestId(/^agenda-day-/)).toHaveLength(8));
  expect(daySection(addDays(today, 7))).toBeInTheDocument();
  // Секция дня не скрывается — горизонт читается целиком
  expect(within(daySection(tomorrow)).getByText('день свободен')).toBeInTheDocument();
  expect(within(daySection(today)).queryByText('день свободен')).toBeNull();
});

test('§4.1: all_day — в начале дня с пометкой «весь день», далее по времени start_at', async () => {
  // Сервер уже отсортировал по start_at:asc; all_day поднимается клиентом
  // Признак «весь день» приезжает ПОЛЕМ строки (`allDay`), а не читается из props: его
  // выбрал сервер по типу свойства в слоте `moment` либо по сырому `orbis/all_day` (§Б5-6).
  const days = [
    win(
      ent('e1', 'Стендап', { 'orbis/start_at': at(today, '09:00') }, ['orbis/schedule']),
      at(today, '09:00'),
    ),
    win(
      ent('e2', 'Отпуск: день 1', { 'orbis/start_at': at(today, '00:00'), 'orbis/all_day': true }, [
        'orbis/schedule',
      ]),
      at(today, '00:00'),
      true,
    ),
    win(
      ent(
        'e3',
        'Врач',
        { 'orbis/start_at': at(today, '14:00'), 'orbis/end_at': at(today, '15:30') },
        ['orbis/schedule'],
      ),
      at(today, '14:00'),
    ),
  ];
  renderWithProviders(<AgendaScreen />, agendaHandler({ window: days }));

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
  const template = ent(
    'tpl',
    'Стендап (шаблон)',
    {
      'orbis/task_status': 'planned',
      'orbis/due_date': addDays(today, -3),
      'orbis/start_at': at(addDays(today, -10), '09:00'),
      'orbis/recurrence': { freq: 'daily', interval: 1 },
    },
    ['orbis/task', 'orbis/schedule'],
  );
  const task = ent(
    't1',
    'Закончить API',
    { 'orbis/task_status': 'planned', 'orbis/due_date': yesterday },
    ['orbis/task'],
  );
  // Шаблон отсеял сервер набором `templates` — в ответе только живая задача
  renderWithProviders(<AgendaScreen />, agendaHandler({ overdue: [late(task, yesterday)] }));

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  expect(rowTitles(overdueSection())).toEqual(['Закончить API']);
  expect(screen.getByTestId('agenda-overdue-count')).toHaveTextContent('1');
  expect(template.props['orbis/recurrence']).toBeDefined(); // фикстура шаблона осмысленна
});

// --- релевантная дата строки «Просроченного» (мокап §4: «срок был 11.06») --------------

test('§4.2: строка «Просроченного» подписана релевантной датой, а не будущим сроком', async () => {
  // start_at вчера, due_date послезавтра: сущность просрочена по РАСПИСАНИЮ, и подпись
  // строки обязана показывать именно эту дату (EntityRow справа печатает due_date).
  const task = ent(
    't1',
    'Подтвердить созвон',
    {
      'orbis/task_status': 'planned',
      'orbis/due_date': addDays(today, 2),
      'orbis/start_at': at(yesterday, '09:00'),
    },
    ['orbis/task', 'orbis/schedule'],
  );
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ overdue: [late(task, yesterday, 'moment')] }),
  );

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  expect(within(overdueSection()).getByText(`был ${dayLabel(yesterday)}`)).toBeInTheDocument();
  // Task D2b: мета EntityRow подавлена — БУДУЩЕГО срока в красной секции быть не может
  expect(within(overdueSection()).queryByText(dayLabel(addDays(today, 2)))).toBeNull();
});

test('§4.2 (D2b): в строке «Просроченного» дата печатается ровно один раз', async () => {
  // Самая частая строка секции — задача со сроком вчера. Своя подпись слева и мета
  // EntityRow справа печатали ОДНУ И ТУ ЖЕ дату: «был 24 июл. … 24 июл.».
  const task = ent(
    't1',
    'Закончить API',
    { 'orbis/task_status': 'in_progress', 'orbis/due_date': yesterday },
    ['orbis/task'],
  );
  renderWithProviders(<AgendaScreen />, agendaHandler({ overdue: [late(task, yesterday)] }));

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  expect(within(overdueSection()).getAllByText(`был ${dayLabel(yesterday)}`)).toHaveLength(1);
  // Голая дата отдельным узлом — ровно та вторая печать, которой быть не должно
  expect(within(overdueSection()).queryByText(dayLabel(yesterday))).toBeNull();
});

test('§4.2 (D2c): у просроченного платежа сумма остаётся — подавлять нечего', async () => {
  // EntityRow выбирает мету по приоритету: financial → СУММА (не дата). Дублирования
  // даты в такой строке нет вовсе, поэтому подавление меты D2b здесь только съедало бы
  // сумму — единственное, ради чего строка платежа и открывается.
  const payment = ent(
    't1',
    'Оплатить интернет',
    {
      'orbis/task_status': 'planned',
      'orbis/due_date': yesterday,
      'orbis/amount': '1200.00',
      'orbis/direction': 'expense',
    },
    ['orbis/task', 'orbis/financial'],
  );
  renderWithProviders(<AgendaScreen />, agendaHandler({ overdue: [late(payment, yesterday)] }));

  await waitFor(() => expect(overdueSection()).toBeInTheDocument());
  // '−' здесь U+2212, разделитель групп — обычный пробел (lib/format.ts formatMoney)
  expect(within(overdueSection()).getByText('−1 200.00')).toBeInTheDocument();
  expect(within(overdueSection()).getByText(`был ${dayLabel(yesterday)}`)).toBeInTheDocument();
  // Дата по-прежнему ровно одна: справа стоит сумма, а не вторая печать срока
  expect(within(overdueSection()).queryByText(dayLabel(yesterday))).toBeNull();
});

// --- мета дневных секций (уборочная фаза: тот же дефект, что D2b вычистил в «Просроченном»)
// Секция уже подписана датой, а слева у строки стоит время: третья печать той же даты
// справа — шум, и у события она считалась в таймзоне БРАУЗЕРА (start_at — полный ISO),
// то есть у владельца с несовпадающей зоной ночные строки расходились с заголовком секции.

test('дневная секция: у события дата справа не печатается — её печатает сама секция', async () => {
  const event = ent('e1', 'Созвон', { 'orbis/start_at': at(tomorrow, '14:00') }, [
    'orbis/schedule',
  ]);
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ window: [win(event, at(tomorrow, '14:00'))] }),
  );

  await waitFor(() => expect(rowTitles(daySection(tomorrow))).toEqual(['Созвон']));
  // Время слева осталось; голой даты справа — ни одной
  expect(within(daySection(tomorrow)).getByText('14:00')).toBeInTheDocument();
  expect(within(daySection(tomorrow)).queryByText(dayLabel(tomorrow))).toBeNull();
});

test('дневная секция: срок, СОВПАВШИЙ с днём секции, не печатается второй раз', async () => {
  // Самая частая строка дня: запланированная задача со сроком на этот же день. Секция
  // уже подписана датой, слева стоит время — третья печать той же даты была шумом.
  const scheduled = ent(
    't5',
    'Врач',
    {
      'orbis/task_status': 'planned',
      'orbis/due_date': tomorrow,
      'orbis/start_at': at(tomorrow, '14:00'),
    },
    ['orbis/task', 'orbis/schedule'],
  );
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ window: [win(scheduled, at(tomorrow, '14:00'))] }),
  );

  await waitFor(() => expect(rowTitles(daySection(tomorrow))).toEqual(['Врач']));
  expect(within(daySection(tomorrow)).getByText('14:00')).toBeInTheDocument();
  expect(within(daySection(tomorrow)).queryByText(dayLabel(tomorrow))).toBeNull();
});

test('дневная секция: срок, отличающийся от дня секции, остаётся — это не дубль, а факт', async () => {
  // Встреча завтра, а сдать работу нужно послезавтра: правая мета несёт НОВОЕ знание.
  const dayAfter = addDays(today, 2);
  const scheduled = ent(
    't3',
    'Врач',
    {
      'orbis/task_status': 'planned',
      'orbis/due_date': dayAfter,
      'orbis/start_at': at(tomorrow, '14:00'),
    },
    ['orbis/task', 'orbis/schedule'],
  );
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ window: [win(scheduled, at(tomorrow, '14:00'))] }),
  );

  await waitFor(() => expect(rowTitles(daySection(tomorrow))).toEqual(['Врач']));
  expect(within(daySection(tomorrow)).getByText(dayLabel(dayAfter))).toBeInTheDocument();
});

test('дневная секция: у платежа сумма остаётся — подавлять нечего (как в «Просроченном»)', async () => {
  const payment = ent(
    't4',
    'Аренда',
    {
      'orbis/start_at': at(tomorrow, '09:00'),
      'orbis/amount': '1200.00',
      'orbis/direction': 'expense',
    },
    ['orbis/schedule', 'orbis/financial'],
  );
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ window: [win(payment, at(tomorrow, '09:00'))] }),
  );

  await waitFor(() => expect(rowTitles(daySection(tomorrow))).toEqual(['Аренда']));
  expect(within(daySection(tomorrow)).getByText('−1 200.00')).toBeInTheDocument();
});

test('дефолт меты EntityRow не менялся: в Browser строка по-прежнему печатает дату', async () => {
  // Дефолт пропа общий с Browser — правка Повестки не имеет права его сдвинуть.
  const { EntityRow } = await import('../browser/EntityRow');
  const task = ent('b1', 'Отчёт', { 'orbis/task_status': 'planned', 'orbis/due_date': tomorrow }, [
    'orbis/task',
  ]);
  renderWithProviders(<EntityRow entity={task} />);
  expect(screen.getByText(dayLabel(tomorrow))).toBeInTheDocument();
});

// --- пользовательские строки экрана (D2c) ---------------------------------------------

test('D2c: шапка и плашка ошибки называют экран «Повесткой», а не «Agenda»', async () => {
  // Пользователь жмёт вкладку «Повестка» (слово владельца 2026-07-25) — экран, на который
  // он попадает, обязан называться так же. Идентификаторы и testid при этом не меняются.
  renderWithProviders(<AgendaScreen />, (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'agenda.list') throw trpcError('INTERNAL_SERVER_ERROR');
    return {};
  });

  expect(screen.getByRole('heading', { level: 1, name: 'Повестка' })).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByText('Не удалось загрузить повестку')).toBeInTheDocument(),
  );
});

// --- ответ подписки: пока его нет, раскладывать нечего -------------------------------

test('ручка не ответила → скелетон, дней нет', async () => {
  // Ждать больше нечего, кроме самой подписки: «сегодня» и таймзона приезжают ЕЁ ответом
  // (§А5-5), и до него дни считались бы в зоне браузера — строки у полуночи уехали бы
  // в соседнюю секцию.
  const { calls } = renderWithProviders(<AgendaScreen />, (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'agenda.list') return new Promise(() => {}); // ответ не приходит
    return {};
  });

  await waitFor(() => expect(calls.filter((c) => c.path === 'agenda.list').length).toBe(1));
  await waitFor(() => expect(screen.getAllByLabelText('Загрузка').length).toBeGreaterThan(0));
  expect(screen.queryAllByTestId(/^agenda-day-/)).toHaveLength(0);
  expect(screen.queryByTestId('agenda-overdue')).toBeNull();
});

// --- потолок выборки (K18, урок C6) ---------------------------------------------------

test('«Просроченное»: при упоре в потолок счётчик показывает «200+», а не молчит', async () => {
  // Усечение приезжает ФЛАГОМ секции (§А5-5), а не угадывается по длине списка: клиент
  // больше не знает потолка вовсе, и три строки с поднятым флагом — законный ответ.
  const rows = Array.from({ length: 3 }, (_, i) =>
    late(
      ent(`t${i}`, `Задача ${i}`, { 'orbis/task_status': 'planned', 'orbis/due_date': yesterday }, [
        'orbis/task',
      ]),
      yesterday,
    ),
  );
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ overdue: rows, truncated: { window: false, overdue: true } }),
  );

  await waitFor(() => expect(screen.getByTestId('agenda-overdue-count')).toHaveTextContent('3+'));
});

// --- навигация ------------------------------------------------------------------------

test('тап по строке пушит detail в стек вкладки agenda', async () => {
  const event = ent('e1', 'Стендап', { 'orbis/start_at': at(today, '09:00') }, ['orbis/schedule']);
  renderWithProviders(
    <AgendaScreen />,
    agendaHandler({ window: [win(event, at(today, '09:00'))] }),
  );

  await waitFor(() => expect(rowTitles(daySection(today))).toEqual(['Стендап']));
  fireEvent.click(within(daySection(today)).getAllByTestId('agenda-row')[0] as HTMLElement);

  expect(useNav.getState().stacks.agenda.at(-1)).toEqual({ kind: 'entity', id: 'e1' });
});

// --- §8.2: элемент ПОКИДАЕТ секцию после действия (полный путь через detail) -----------
//
// Единственный способ закрыть/архивировать задачу из Agenda — push detail (§4.2, §1.1).
// Подписка Повестки держит staleTime 60 с (K16) и refetchOnWindowFocus выключен, поэтому
// после «Готово» секция обновится ТОЛЬКО если mutation инвалидирует agenda.list.
// Тест гоняет ActiveScreen (реальный роутер), чтобы поймать разрыв между экранами.

/** Мок «живого сервера»: закрытая задача выходит из набора `open` и покидает секцию. */
function overdueRoundTripHandler(task: ReturnType<typeof ent>, state: { closed: boolean }) {
  const handler: MockHandler = (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'agenda.list') {
      return {
        today,
        timezone: TZ,
        rows: state.closed ? [] : [late(task, yesterday)],
        truncated: { window: false, overdue: false },
      };
    }
    if (path === 'entity.get')
      return { entity: task, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') {
      state.closed = true;
      return task;
    }
    if (path === 'relation.listFor') return [];
    return {};
  };
  return handler;
}

test('§8.2: «Готово» на detail-экране убирает задачу из «Просроченного» после «Назад»', async () => {
  const task = ent(
    't1',
    'Закончить API',
    { 'orbis/task_status': 'in_progress', 'orbis/due_date': yesterday },
    ['orbis/task'],
  );
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
  const task = ent(
    't1',
    'Закончить API',
    { 'orbis/task_status': 'in_progress', 'orbis/due_date': yesterday },
    ['orbis/task'],
  );
  const state = { closed: false }; // архив сервер тоже исключает из выборок
  renderWithProviders(<ActiveScreen />, overdueRoundTripHandler(task, state));

  await waitFor(() => expect(rowTitles(overdueSection())).toEqual(['Закончить API']));
  fireEvent.click(within(overdueSection()).getAllByTestId('agenda-row')[0] as HTMLElement);

  // Архивация переехала в меню ⋮ шапки detail (§3.5, Task B4): сперва открыть меню.
  // Клавиатурой, а не кликом: Radix открывает меню по pointerdown, которого jsdom не умеет.
  fireEvent.keyDown(await screen.findByTestId('detail-menu'), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: /архив/i }));
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

const overdueTask = ent(
  't1',
  'Закончить API',
  { 'orbis/task_status': 'in_progress', 'orbis/due_date': yesterday },
  ['orbis/task'],
);

test('бейдж Agenda: просроченное>0 → число в tab-bar И sidebar, вкладка не открыта', async () => {
  onChatTab();
  renderWithProviders(<App />, agendaHandler({ overdue: [late(overdueTask, yesterday)] }));

  await waitFor(() => expect(screen.getByTestId('agenda-badge')).toHaveTextContent('1'));
  expect(screen.getByTestId('sidebar-agenda-badge')).toHaveTextContent('1');
  // Экран Agenda не смонтирован — источник числа именно бейдж, а не открытая секция
  expect(screen.queryByTestId('agenda-overdue')).toBeNull();
});

test('просроченного нет → бейджа Agenda нет ни в одной поверхности', async () => {
  onChatTab();
  const { calls } = renderWithProviders(<App />, agendaHandler({}));

  await waitFor(() => expect(screen.getByTestId('tab-agenda')).toBeInTheDocument());
  await waitFor(() => expect(calls.some((c) => c.path === 'agenda.list')).toBe(true));
  expect(screen.queryByTestId('agenda-badge')).toBeNull();
  expect(screen.queryByTestId('sidebar-agenda-badge')).toBeNull();
});

test('ошибка запроса «Просроченного» → бейджа нет, вкладка Agenda жива', async () => {
  onChatTab();
  renderWithProviders(<App />, (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'agenda.list') throw trpcError('INTERNAL_SERVER_ERROR');
    return {};
  });

  await waitFor(() => expect(screen.getByTestId('tab-agenda')).toBeInTheDocument());
  expect(screen.getByTestId('sidebar-agenda')).toBeInTheDocument();
  expect(screen.queryByTestId('agenda-badge')).toBeNull();
  expect(screen.queryByTestId('sidebar-agenda-badge')).toBeNull();
});

test('D2b: отказ подписки → бейджа нет, но сигнал не теряется — плашка на вкладке', async () => {
  // Заниженный счётчик хуже отсутствующего: «1» на бейдже читалось бы как полная картина
  // (прецедент Budget: ошибка alertCount → бейджа нет). С одной выборкой занизиться нечем
  // вовсе — зато обязана остаться ПЛАШКА на самой вкладке, где неполнота видна явно.
  renderWithProviders(<App />, (path) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'agenda.list') throw trpcError('INTERNAL_SERVER_ERROR');
    return {};
  });

  await waitFor(() =>
    expect(screen.getByText('Не удалось загрузить просроченное')).toBeInTheDocument(),
  );
  expect(screen.queryByTestId('agenda-badge')).toBeNull();
  expect(screen.queryByTestId('sidebar-agenda-badge')).toBeNull();
  expect(screen.getByTestId('tab-agenda')).toBeInTheDocument();
});

test('бейдж при упоре в потолок показывает «200+», а не усечённое число', async () => {
  onChatTab();
  const rows = Array.from({ length: 3 }, (_, i) =>
    late(
      ent(`t${i}`, `Задача ${i}`, { 'orbis/task_status': 'planned', 'orbis/due_date': yesterday }, [
        'orbis/task',
      ]),
      yesterday,
    ),
  );
  renderWithProviders(
    <App />,
    agendaHandler({ overdue: rows, truncated: { window: false, overdue: true } }),
  );

  await waitFor(() => expect(screen.getByTestId('agenda-badge')).toHaveTextContent('3+'));
  expect(screen.getByTestId('sidebar-agenda-badge')).toHaveTextContent('3+');
});

test('бейдж и вкладка делят один источник: второго вызова подписки нет', async () => {
  // Таб agenda: хук зовут ТРИ компонента (TabBar, SidebarNav, AgendaScreen) — на сервер
  // при этом уходит ровно ОДИН вызов подписки, а не по одному на компонент.
  const { calls } = renderWithProviders(
    <App />,
    agendaHandler({ overdue: [late(overdueTask, yesterday)] }),
  );

  await waitFor(() => expect(screen.getByTestId('agenda-badge')).toHaveTextContent('1'));
  expect(rowTitles(overdueSection())).toEqual(['Закончить API']);
  expect(calls.filter((c) => c.path === 'agenda.list')).toHaveLength(1);
});
