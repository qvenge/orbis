// Дни недели и время суток рутин (V1.1) — та часть date.ts, на которой стоит планировщик:
// разъехавшись с mondayIndex, алфавит дней сдвинул бы КАЖДЫЙ прогон на день.
import { describe, expect, test } from 'bun:test';
import {
  epochDays,
  HHMM_RE,
  hasValidCalendar,
  lastDayOfMonth,
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

// Календарь монорепо живёт ЗДЕСЬ, и с Р-9b-5 его спрашивают трое: разбор запроса
// (`query/parse-ast.ts`), компилятор (`query/compile-ast.ts`) и запись
// (`registry/validate-props.ts`). Своя копия «сколько дней в феврале» у любого из них
// разошлась бы с остальными ровно на високосном годе — вот проверка, что копия одна.
describe('hasValidCalendar: существует ли день (Р-9b-5)', () => {
  test('форма верна, дня нет — false; и у даты, и у момента', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-04-31', '2026-00-10', '2026-01-00']) {
      expect(`${bad}: ${hasValidCalendar(bad)}`).toBe(`${bad}: false`);
    }
    // У момента календарный день — те же первые десять символов, второго правила нет.
    expect(hasValidCalendar('2026-02-30T09:00:00Z')).toBe(false);
    expect(hasValidCalendar('2026-02-28T09:00:00+03:00')).toBe(true);
  });

  test('високосные годы — по lastDayOfMonth, а не «в феврале 28»', () => {
    expect(hasValidCalendar('2028-02-29')).toBe(true);
    expect(hasValidCalendar('2029-02-29')).toBe(false);
    expect(hasValidCalendar('2000-02-29')).toBe(true); // вековой високосный
    expect(hasValidCalendar('1900-02-29')).toBe(false); // вековой невисокосный
    // Ответ совпадает с самим `lastDayOfMonth` — календарь считается им, а не рядом с ним.
    for (const y of [1900, 2000, 2026, 2028, 2029]) {
      for (let m = 1; m <= 12; m++) {
        const last = lastDayOfMonth(y, m);
        const mm = String(m).padStart(2, '0');
        const at = `${y}-${mm}-${String(last).padStart(2, '0')}`;
        const over = `${y}-${mm}-${String(last + 1).padStart(2, '0')}`;
        expect(`${at}:${hasValidCalendar(at)}`).toBe(`${at}:true`);
        if (last + 1 <= 31) expect(`${over}:${hasValidCalendar(over)}`).toBe(`${over}:false`);
      }
    }
  });

  test('текст, который датой не выглядит, календарю не подсуден', () => {
    // Контракт функции: она отвечает «существует ли день, ЕСЛИ текст его называет».
    // ФОРМУ проверяет вызывающий — схема значения или регексп парсера.
    for (const text of ['банан', '', '05.07.2026', '2026-7-1', 'manual:x', '20260230']) {
      expect(`${text}: ${hasValidCalendar(text)}`).toBe(`${text}: true`);
    }
  });
});
