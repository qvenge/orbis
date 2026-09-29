/**
 * Подписи ленты по дням (спека 1в §5.2): заголовок дня и колонка времени — в поясе ОТВЕТА
 * (`EntityBlocksResult.timeZone`), не браузера. Пояс процесса теста — `UTC` (закреплён ниже и
 * сверен): пояс ответа — `Asia/Novosibirsk` (+07), и порча «время в поясе браузера» даёт другой
 * час и другой день. Машина разработчика сама в +07 (Asia/Barnaul) — без явного `TZ` такая порча
 * здесь была бы зелёной.
 */
import type { BlockRowAt } from '@orbis/shared';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  dayHeaderLabel,
  dayInTimeZone,
  rowDateLabel,
  rowTimeLabel,
  timeInTimeZone,
} from './day-format';

const NSK = 'Asia/Novosibirsk';
const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const at = (over: Partial<BlockRowAt>): BlockRowAt => ({
  slot: 'moment',
  value: '2026-09-27T02:00:00.000Z',
  end: null,
  allDay: false,
  untimed: false,
  ...over,
});

test('пояс процесса — UTC, не +07 ответа: иначе порча «пояс браузера» незаметна', () => {
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
  expect(new Date('2026-09-27T12:00:00Z').getTimezoneOffset()).toBe(0);
});

// Формы подписи — спеки §5.2; дни недели — по календарю: 27.09.2026 — воскресенье (день недели в
// примере спеки «сб, 27 сентября» с календарём 2026-го не сходится), суббота — 26.09.
test('заголовок дня: «Сегодня · …», «Завтра · …», иначе день недели и дата', () => {
  expect(dayHeaderLabel('2026-09-26', '2026-09-26')).toBe('Сегодня · сб, 26 сентября');
  expect(dayHeaderLabel('2026-09-27', '2026-09-26')).toBe('Завтра · вс, 27 сентября');
  expect(dayHeaderLabel('2026-09-28', '2026-09-26')).toBe('пн, 28 сентября');
  expect(dayHeaderLabel('2026-09-27', '2026-09-27')).toBe('Сегодня · вс, 27 сентября');
  // Через границу месяца «завтра» считается календарём, а не сравнением строк.
  expect(dayHeaderLabel('2026-10-01', '2026-09-30')).toBe('Завтра · чт, 1 октября');
});

test('день и время момента — в поясе ответа; дата без времени — как есть', () => {
  // 16:40Z — 23:40 в Новосибирске того же дня; 17:20Z — 00:20 СЛЕДУЮЩЕГО дня.
  expect(dayInTimeZone('2026-09-27T16:40:00.000Z', NSK)).toBe('2026-09-27');
  expect(dayInTimeZone('2026-09-26T17:20:00.000Z', NSK)).toBe('2026-09-27');
  expect(dayInTimeZone('2026-09-27', NSK)).toBe('2026-09-27');
  expect(timeInTimeZone('2026-09-27T16:40:00.000Z', NSK)).toBe('23:40');
  // Полночь — «00:20», а не «24:20» (часовой цикл h23).
  expect(timeInTimeZone('2026-09-26T17:20:00.000Z', NSK)).toBe('00:20');
});

test('колонка времени — семь форм §5.2', () => {
  const day = '2026-09-27';
  // moment со временем — «09:00» (02:00Z = 09:00 +07).
  expect(rowTimeLabel(at({}), day, NSK)).toBe('09:00');
  // end в тот же день — диапазон через короткое тире.
  expect(
    rowTimeLabel(
      at({ value: '2026-09-27T07:00:00.000Z', end: '2026-09-27T08:30:00.000Z' }),
      day,
      NSK,
    ),
  ).toBe('14:00–15:30');
  // end в другой день — «→ дд.мм» дня конца в поясе ответа.
  expect(rowTimeLabel(at({ end: '2026-09-30T03:00:00.000Z' }), day, NSK)).toBe('09:00 → 30.09');
  // all_day привязки и moment-дата — «весь день».
  expect(rowTimeLabel(at({ allDay: true, untimed: true }), day, NSK)).toBe('весь день');
  expect(rowTimeLabel(at({ value: '2026-09-27', allDay: true, untimed: true }), day, NSK)).toBe(
    'весь день',
  );
  // deadline — «срок» (и датой, и моментом).
  expect(rowTimeLabel(at({ slot: 'deadline', value: '2026-09-27', untimed: true }), day, NSK)).toBe(
    'срок',
  );
  expect(rowTimeLabel(at({ slot: 'deadline', untimed: true }), day, NSK)).toBe('срок');
  // done — «сделано 23:40» в поясе ответа (Фокус ревью п. 1); done-дата — «сделано», не «сделано 00:00»:
  // у done `allDay: false`, «без времени» — признак сервера `untimed`, своей проверки значения нет.
  expect(rowTimeLabel(at({ slot: 'done', value: '2026-09-27T16:40:00.000Z' }), day, NSK)).toBe(
    'сделано 23:40',
  );
  expect(rowTimeLabel(at({ slot: 'done', value: '2026-09-27', untimed: true }), day, NSK)).toBe(
    'сделано',
  );
});

test('колонка читает признак сервера untimed, а не вид значения', () => {
  // Признак сервера — правда: «без времени» при моменте-ISO — «весь день»; и наоборот.
  expect(rowTimeLabel(at({ untimed: true }), '2026-09-27', NSK)).toBe('весь день');
  expect(rowTimeLabel(at({ slot: 'done', untimed: true }), '2026-09-27', NSK)).toBe('сделано');
});

test('end — дата без часов: в день момента время конца не печатается, в другой день — «→ дд.мм»', () => {
  // Не «09:00–07:00» (полночь UTC даты в поясе ответа).
  expect(rowTimeLabel(at({ end: '2026-09-27' }), '2026-09-27', NSK)).toBe('09:00');
  expect(rowTimeLabel(at({ end: '2026-09-30' }), '2026-09-27', NSK)).toBe('09:00 → 30.09');
});

test('дата строки ленты: день группы — не печатается; иначе подпись дня в поясе ответа', () => {
  // 28.09 00:30 +07 — в UTC ещё 27.09: подпись «28 сент.», а не «27 сент.» браузера.
  expect(rowDateLabel('2026-09-27T17:30:00.000Z', '2026-09-27', NSK)).toBe('28 сент.');
  expect(rowDateLabel('2026-09-27T17:30:00.000Z', '2026-09-28', NSK)).toBeNull();
  expect(rowDateLabel('2026-10-01', '2026-09-29', NSK)).toBe('1 окт.');
  expect(rowDateLabel('2026-09-29', '2026-09-29', NSK)).toBeNull();
  // «Без даты» (day: null) — дата печатается всегда.
  expect(rowDateLabel('2026-09-29', null, NSK)).toBe('29 сент.');
});

test('группировка по свойству или адресу слота (slot: null): момент — время, дата — «весь день»', () => {
  expect(rowTimeLabel(at({ slot: null }), '2026-09-27', NSK)).toBe('09:00');
  expect(
    rowTimeLabel(
      at({ slot: null, value: '2026-09-27', allDay: true, untimed: true }),
      '2026-09-27',
      NSK,
    ),
  ).toBe('весь день');
});

test('битая зона — запасной вывод в поясе браузера без исключения', () => {
  expect(() => dayInTimeZone('2026-09-27T16:40:00.000Z', 'Not/AZone')).not.toThrow();
  expect(dayInTimeZone('2026-09-27T16:40:00.000Z', 'Not/AZone')).toBe('2026-09-27');
  expect(timeInTimeZone('2026-09-27T16:40:00.000Z', 'Not/AZone')).toBe('16:40');
  expect(rowTimeLabel(at({}), '2026-09-27', 'Not/AZone')).toBe('02:00');
});

test('битое значение — как есть, без исключения', () => {
  expect(dayInTimeZone('не дата', NSK)).toBe('не дата');
  expect(timeInTimeZone('не дата', NSK)).toBe('не дата');
});
