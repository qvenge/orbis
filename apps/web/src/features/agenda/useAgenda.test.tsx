// Чтения Повестки — по `props` (§А1-1), а сама выборка остаётся ТРЕМЯ запросами.
//
// Зачем отдельный файл при живом `AgendaScreen.test`. Тот проверяет ЭКРАН: заголовки секций,
// подписи строк, гашение дублей даты. Здесь проверяется ПАРИТЕТ СОСТАВА после переезда адреса
// значения: те же три текста запроса уходят на сервер, и те же сущности попадают в те же
// секции — при том что читает их клиент уже по id свойства, а не парой «аспект + поле».
// Решение А5-5 (Повестка одним запросом с OR-деревом) — срез Б-1; в срезе А запросов три, и
// это пиннится здесь, а не подразумевается.
import { addDays } from '@orbis/shared';
import { screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { todayISO } from '../budget/useBudget';
import {
  AGENDA_DAYS_QUERY,
  AGENDA_OVERDUE_DUE_QUERY,
  AGENDA_OVERDUE_START_QUERY,
  dueDate,
  isAllDay,
  isFinancial,
  isRecurringTemplate,
  startAt,
  useAgendaDays,
  useAgendaOverdue,
} from './useAgenda';

const TZ = 'Europe/Moscow';
const today = todayISO(TZ);
const tomorrow = addDays(today, 1);
const yesterday = addDays(today, -1);
const at = (day: string, time: string) => `${day}T${time}:00+03:00`;

const event = wireEntity({
  id: 'ev',
  title: 'Стендап',
  props: { 'orbis/start_at': at(today, '09:00'), 'orbis/all_day': true },
  aspects: ['orbis/schedule'],
});
const template = wireEntity({
  id: 'tpl',
  title: 'Стендап (шаблон)',
  props: {
    'orbis/start_at': at(today, '09:00'),
    'orbis/recurrence': { freq: 'daily', interval: 1 },
  },
  aspects: ['orbis/schedule'],
});
const overdueTask = wireEntity({
  id: 'td',
  title: 'Закончить API',
  props: { 'orbis/task_status': 'in_progress', 'orbis/due_date': yesterday },
  aspects: ['orbis/task'],
});
const overduePayment = wireEntity({
  id: 'tp',
  title: 'Оплатить интернет',
  props: {
    'orbis/task_status': 'planned',
    'orbis/due_date': yesterday,
    'orbis/amount': '1200.00',
    'orbis/direction': 'expense',
  },
  aspects: ['orbis/task', 'orbis/financial'],
});
const overdueStart = wireEntity({
  id: 'ts',
  title: 'Подтвердить созвон',
  props: {
    'orbis/task_status': 'planned',
    'orbis/due_date': addDays(today, 3),
    'orbis/start_at': at(yesterday, '09:00'),
  },
  aspects: ['orbis/task', 'orbis/schedule'],
});

/** Три выборки под ТОЧНЫМИ текстами: несовпадение строки валит тест, а не проходит молча. */
const handler = (path: string, input: unknown) => {
  if (path === 'user.getSettings') return { timezone: TZ, defaultCurrency: 'RUB' };
  if (path !== 'entity.query') return {};
  const q = (input as { query: string }).query;
  if (q === AGENDA_DAYS_QUERY) return [event, template];
  if (q === AGENDA_OVERDUE_DUE_QUERY) return [overdueTask, overduePayment];
  if (q === AGENDA_OVERDUE_START_QUERY) return [overdueStart];
  throw new Error(`незнакомый запрос Повестки: ${q}`);
};

/** Пробник: печатает СОСТАВ секций строкой — по нему и сверяется паритет. */
function Probe() {
  const days = useAgendaDays();
  const overdue = useAgendaOverdue();
  return (
    <>
      <span data-testid="day-today">
        {(days.days.find((d) => d.date === today)?.entities ?? []).map((e) => e.id).join(',')}
      </span>
      <span data-testid="day-tomorrow">
        {(days.days.find((d) => d.date === tomorrow)?.entities ?? []).map((e) => e.id).join(',')}
      </span>
      <span data-testid="overdue">
        {overdue.items.map((i) => `${i.entity.id}@${i.date}`).join(',')}
      </span>
      <span data-testid="badge">{overdue.badgeLabel ?? ''}</span>
    </>
  );
}

test('три запроса Повестки — и ровно три, теми же текстами', async () => {
  const { calls } = renderWithProviders(<Probe />, handler);
  await screen.findByText(`${overdueTask.id}@${yesterday},${overduePayment.id}@${yesterday}`, {
    exact: false,
  });
  const queries = calls
    .filter((c) => c.path === 'entity.query')
    .map((c) => (c.input as { query: string }).query);
  expect([...new Set(queries)].sort()).toEqual(
    [AGENDA_DAYS_QUERY, AGENDA_OVERDUE_DUE_QUERY, AGENDA_OVERDUE_START_QUERY].sort(),
  );
});

test('паритет состава: дневная секция и «Просроченное» собраны по props', async () => {
  renderWithProviders(<Probe />, handler);
  // Шаблон повторения скрыт (`orbis/recurrence` — свойство записи, а не поле аспекта),
  // событие своего дня — на месте.
  await screen.findByText('ev');
  expect(screen.getByTestId('day-today')).toHaveTextContent('ev');
  expect(screen.getByTestId('day-today').textContent).not.toContain('tpl');
  expect(screen.getByTestId('day-tomorrow')).toBeEmptyDOMElement();

  // «Просроченное» — слияние двух выборок по id с более ранней релевантной датой: у задачи
  // с прошедшим НАЧАЛОМ и будущим сроком берётся день начала, а не срок.
  const overdue = screen.getByTestId('overdue').textContent ?? '';
  expect(overdue.split(',')).toEqual([
    `${overdueTask.id}@${yesterday}`,
    `${overduePayment.id}@${yesterday}`,
    `${overdueStart.id}@${yesterday}`,
  ]);
  expect(screen.getByTestId('badge')).toHaveTextContent('3');
});

test('чтения адресуют СВОЙСТВА по id — теми же именами, что стоят в текстах запросов', () => {
  // Прежде запрос спрашивал `orbis/start_at`, а клиент читал ответ парой «аспект + поле»:
  // переименование рвало ровно одну из двух половин, и молча.
  expect(startAt(event)).toBe(at(today, '09:00'));
  expect(dueDate(overdueTask)).toBe(yesterday);
  expect(isAllDay(event)).toBe(true);
  expect(isRecurringTemplate(template)).toBe(true);
  expect(isRecurringTemplate(event)).toBe(false);
  // Признак «это операция» — СПИСОК аспектов: у записи без единого заполненного поля
  // Финансов ключ старой карты был пуст, и мета строки печаталась бы датой вместо суммы.
  expect(isFinancial(overduePayment)).toBe(true);
  expect(isFinancial(overdueTask)).toBe(false);
  expect(
    isFinancial(wireEntity({ id: 'x', title: 'Пустая операция', aspects: ['orbis/financial'] })),
  ).toBe(true);
});
