// apps/server/src/routines/schedule.test.ts
// Плановые бакеты рутины (V1.3): чистая функция от «сейчас», времени `at`, дней и таймзоны
// владельца. Без БД: календарная арифметика проверяется точками на границах — до
// наступления, в окне догона, за окном, не тот день недели, полночь и переходы DST.
import { describe, expect, test } from 'bun:test';
import { CATCH_UP_WINDOW_MS } from './constants';
import { dueBuckets } from './schedule';

const MSK = 'Europe/Moscow';
const NY = 'America/New_York';

function at(iso: string): Date {
  return new Date(iso);
}

describe('dueBuckets: бакет в таймзоне владельца, окно догона, дни недели', () => {
  test('07:00 Europe/Moscow: 04:30Z (07:30 мск) → сегодняшний бакет; 03:59Z → ещё нет; 10:01Z (13:01) → окно 6 ч истекло', () => {
    expect(dueBuckets({ at: '07:00', timeZone: MSK, now: at('2026-08-18T04:30:00Z') })).toEqual([
      { bucket: '2026-08-18T07:00', at: at('2026-08-18T04:00:00Z') },
    ]);
    expect(dueBuckets({ at: '07:00', timeZone: MSK, now: at('2026-08-18T03:59:00Z') })).toEqual([]);
    // Ровно на границе окна бакет ещё догоняется; минутой позже — уже нет
    expect(
      dueBuckets({ at: '07:00', timeZone: MSK, now: at('2026-08-18T10:00:00Z') }).map(
        (b) => b.bucket,
      ),
    ).toEqual(['2026-08-18T07:00']);
    expect(dueBuckets({ at: '07:00', timeZone: MSK, now: at('2026-08-18T10:01:00Z') })).toEqual([]);
    expect(CATCH_UP_WINDOW_MS).toBe(6 * 60 * 60_000);
  });

  test('days [mo, we]: во вторник бакета нет, в среду — есть; окно можно сузить параметром', () => {
    // 2026-08-18 — вторник, 2026-08-19 — среда
    expect(
      dueBuckets({
        at: '07:00',
        days: ['mo', 'we'],
        timeZone: MSK,
        now: at('2026-08-18T04:30:00Z'),
      }),
    ).toEqual([]);
    expect(
      dueBuckets({
        at: '07:00',
        days: ['mo', 'we'],
        timeZone: MSK,
        now: at('2026-08-19T04:30:00Z'),
      }).map((b) => b.bucket),
    ).toEqual(['2026-08-19T07:00']);
    // Окно в 10 минут: 07:30 мск уже поздно для 07:00
    expect(
      dueBuckets({
        at: '07:00',
        timeZone: MSK,
        now: at('2026-08-18T04:30:00Z'),
        windowMs: 10 * 60_000,
      }),
    ).toEqual([]);
  });

  test('23:30 при now 00:15 следующего дня → вчерашний бакет (сегодняшний ещё не наступил)', () => {
    // 00:15 мск 19-го = 21:15Z 18-го; бакет 23:30 мск 18-го = 20:30Z 18-го
    expect(dueBuckets({ at: '23:30', timeZone: MSK, now: at('2026-08-18T21:15:00Z') })).toEqual([
      { bucket: '2026-08-18T23:30', at: at('2026-08-18T20:30:00Z') },
    ]);
  });

  test('DST America/New_York: конец летнего времени 2026-11-01 не даёт ни дубля, ни пропуска', () => {
    // 01:30 местного 1 ноября случается дважды (EDT 05:30Z и EST 06:30Z) — бакет один
    const twice = dueBuckets({ at: '01:30', timeZone: NY, now: at('2026-11-01T07:00:00Z') });
    expect(twice.map((b) => b.bucket)).toEqual(['2026-11-01T01:30']);
    // 07:00 в день перехода — уже EST (12:00Z), а не EDT (11:00Z); вчерашний 07:00 EDT за окном
    const morning = dueBuckets({ at: '07:00', timeZone: NY, now: at('2026-11-01T12:30:00Z') });
    expect(morning).toEqual([{ bucket: '2026-11-01T07:00', at: at('2026-11-01T12:00:00Z') }]);
    // Накануне (31 октября, ещё EDT) тот же 07:00 = 11:00Z
    expect(dueBuckets({ at: '07:00', timeZone: NY, now: at('2026-10-31T11:30:00Z') })).toEqual([
      { bucket: '2026-10-31T07:00', at: at('2026-10-31T11:00:00Z') },
    ]);
  });

  test('DST America/New_York: начало летнего времени 2026-03-08 — несуществующее 02:30 не пропадает', () => {
    // 02:30 местного 8 марта не существует (часы прыгают с 02:00 на 03:00): бакет всё равно один
    const spring = dueBuckets({ at: '02:30', timeZone: NY, now: at('2026-03-08T08:00:00Z') });
    expect(spring.map((b) => b.bucket)).toEqual(['2026-03-08T02:30']);
    // и его момент — ближайший валидный (03:30 EDT = 07:30Z), а не «вчера»
    expect(spring[0]?.at.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  test('порядок хронологический: вчерашний бакет раньше сегодняшнего при широком окне', () => {
    const both = dueBuckets({
      at: '07:00',
      timeZone: MSK,
      now: at('2026-08-18T05:00:00Z'),
      windowMs: 30 * 60 * 60_000,
    });
    expect(both.map((b) => b.bucket)).toEqual(['2026-08-17T07:00', '2026-08-18T07:00']);
  });
});
