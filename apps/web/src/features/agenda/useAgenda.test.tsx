// Чтения Повестки — по `props` (§А1-1), а сама выборка стала ОДНОЙ (§А5-5).
//
// Зачем отдельный файл при живом `AgendaScreen.test`. Тот проверяет ЭКРАН: заголовки секций,
// подписи строк, гашение дублей даты. Здесь проверяется ГРАНИЦА: вкладка спрашивает ровно один
// раз и ровно подпиской, а раскладка по дням и порядок «Просроченного» остались клиентскими
// (Р-И-18) — сервер отдаёт плоский список с тегом секции, а не готовые дни.
import { type AgendaListResult, type AgendaRow, addDays } from '@orbis/shared';
import { screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { type MockHandler, renderWithProviders, wireEntity } from '../../test/harness';
import { todayISO } from '../budget/useBudget';
import {
  dueDate,
  isFinancial,
  isRecurringTemplate,
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

const row = (entity: ReturnType<typeof wireEntity>, over: Partial<AgendaRow>): AgendaRow =>
  ({ entity, section: 'window', at: '', slot: 'moment', allDay: false, ...over }) as AgendaRow;
const result: AgendaListResult = {
  today,
  timezone: TZ,
  truncated: { window: false, overdue: false },
  rows: [
    row(event, { at: at(today, '09:00'), allDay: true }),
    row(overdueTask, { section: 'overdue', at: yesterday, slot: 'deadline' }),
    row(overduePayment, { section: 'overdue', at: yesterday, slot: 'deadline' }),
    row(overdueStart, { section: 'overdue', at: yesterday, slot: 'moment' }),
  ],
};
const handler: MockHandler = (path) => (path === 'agenda.list' ? result : {});

/** Пробник: печатает СОСТАВ секций строкой — по нему и сверяется раскладка. */
function Probe() {
  const days = useAgendaDays();
  const overdue = useAgendaOverdue();
  return (
    <>
      <span data-testid="day-today">
        {(days.days.find((d) => d.date === today)?.rows ?? []).map((r) => r.entity.id).join(',')}
      </span>
      <span data-testid="day-tomorrow">
        {(days.days.find((d) => d.date === tomorrow)?.rows ?? []).map((r) => r.entity.id).join(',')}
      </span>
      <span data-testid="overdue">
        {overdue.items.map((i) => `${i.entity.id}@${i.at}`).join(',')}
      </span>
      <span data-testid="badge">{overdue.badgeLabel ?? ''}</span>
    </>
  );
}

test('один вызов agenda.list — и ровно один; запросов графа нет', async () => {
  const { calls } = renderWithProviders(<Probe />, handler);
  await screen.findByText(`${overdueTask.id}@${yesterday}`, { exact: false });
  expect(calls.filter((c) => c.path === 'agenda.list')).toHaveLength(1);
  expect(calls.filter((c) => c.path === 'entity.query')).toHaveLength(0);
});

test('раскладка осталась клиентской: день — по локальному дню at, «Просроченное» — по at', async () => {
  renderWithProviders(<Probe />, handler);
  await screen.findByText('ev');
  expect(screen.getByTestId('day-today')).toHaveTextContent('ev');
  expect(screen.getByTestId('day-tomorrow')).toBeEmptyDOMElement();
  expect((screen.getByTestId('overdue').textContent ?? '').split(',')).toEqual([
    `${overdueTask.id}@${yesterday}`,
    `${overduePayment.id}@${yesterday}`,
    `${overdueStart.id}@${yesterday}`,
  ]);
  expect(screen.getByTestId('badge')).toHaveTextContent('3');
});

test('шаблоны прячет сервер: второго фильтра на клиенте нет', async () => {
  // Клиентский `isRecurringTemplate` из Повестки снят — шаблоны прячет набор `templates`
  // контракта повторения (§Б5-6). Функция жива ради Финансов, см. её докблок.
  renderWithProviders(<Probe />, () => ({
    ...result,
    rows: [...result.rows, row(template, { at: at(today, '09:00') })],
  }));
  await screen.findByText('ev,tpl');
});

test('чтения адресуют СВОЙСТВА по id — теми же именами, что стоят в реестре', () => {
  // Прежде запрос спрашивал `orbis/start_at`, а клиент читал ответ парой «аспект + поле»:
  // переименование рвало ровно одну из двух половин, и молча.
  expect(dueDate(overdueTask)).toBe(yesterday);
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
