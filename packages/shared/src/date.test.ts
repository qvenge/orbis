// Дни недели и время суток рутин (V1.1) — та часть date.ts, на которой стоит планировщик:
// разъехавшись с mondayIndex, алфавит дней сдвинул бы КАЖДЫЙ прогон на день.
import { describe, expect, test } from 'bun:test';
import {
  epochDays,
  HHMM_RE,
  mondayIndex,
  parseHHMM,
  toParts,
  WEEKDAY_INDEX,
  WEEKDAYS,
  weekdayOfDate,
} from './date';

describe('дни недели (V1.1)', () => {
  test('WEEKDAY_INDEX согласован с mondayIndex: 0 = понедельник, порядок WEEKDAYS', () => {
    // Ключи и их значения — не два независимых факта: индекс дня ОБЯЗАН быть позицией в
    // алфавите, иначе `days.map(WEEKDAY_INDEX)` планировщика и mondayIndex дают разные дни.
    WEEKDAYS.forEach((day, i) => {
      expect(WEEKDAY_INDEX[day]).toBe(i);
    });
    expect(WEEKDAYS.length).toBe(7);
    // 2026-08-17 — понедельник; неделя разворачивается от него ровно по алфавиту
    expect(mondayIndex(epochDays(toParts('2026-08-17')))).toBe(0);
  });
  test('weekdayOfDate: вторник, воскресенье, високосное 29 февраля', () => {
    expect(weekdayOfDate('2026-08-18')).toBe('tu');
    expect(weekdayOfDate('2026-08-17')).toBe('mo');
    expect(weekdayOfDate('2026-08-23')).toBe('su');
    expect(weekdayOfDate('2028-02-29')).toBe('tu');
  });
});

describe('время суток рутины (V1.1)', () => {
  test('parseHHMM разбирает провалидированную схемой строку', () => {
    expect(parseHHMM('07:05')).toEqual({ h: 7, m: 5 });
    expect(parseHHMM('00:00')).toEqual({ h: 0, m: 0 });
    expect(parseHHMM('23:59')).toEqual({ h: 23, m: 59 });
  });
  test('HHMM_RE: ведущий ноль обязателен, часы 0..23, минуты 0..59', () => {
    for (const ok of ['00:00', '07:00', '09:59', '23:59']) expect(HHMM_RE.test(ok)).toBe(true);
    for (const bad of ['7:00', '24:00', '07:60', '0700', '07:0', '07:00:00', '']) {
      expect(HHMM_RE.test(bad)).toBe(false);
    }
  });
});
