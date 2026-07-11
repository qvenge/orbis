import { describe, expect, test } from 'bun:test';
import { expandRecurrence, type RecurrenceRule } from './recurrence';

// 2026-07-01 — среда (якорь большинства тестов).

describe('expandRecurrence: daily (01 §3.1)', () => {
  test('interval=1: каждый день окна', () => {
    expect(
      expandRecurrence({ freq: 'daily', interval: 1 }, '2026-07-01', '2026-07-01', '2026-07-04'),
    ).toEqual(['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']);
  });

  test('interval=3: каждые 3 дня от seriesStart', () => {
    expect(
      expandRecurrence({ freq: 'daily', interval: 3 }, '2026-07-01', '2026-07-01', '2026-07-10'),
    ).toEqual(['2026-07-01', '2026-07-04', '2026-07-07', '2026-07-10']);
  });

  test('from внутри серии не сдвигает фазу: interval=3 от 01 с from=03 → 04, не 03', () => {
    expect(
      expandRecurrence({ freq: 'daily', interval: 3 }, '2026-07-01', '2026-07-03', '2026-07-10'),
    ).toEqual(['2026-07-04', '2026-07-07', '2026-07-10']);
  });

  test('from раньше seriesStart: нижняя граница — seriesStart', () => {
    expect(
      expandRecurrence({ freq: 'daily', interval: 1 }, '2026-07-01', '2026-06-01', '2026-07-02'),
    ).toEqual(['2026-07-01', '2026-07-02']);
  });

  test('to < seriesStart → пустой результат', () => {
    expect(
      expandRecurrence({ freq: 'daily', interval: 1 }, '2026-07-01', '2026-06-01', '2026-06-30'),
    ).toEqual([]);
  });

  test('to < from → пустой результат', () => {
    expect(
      expandRecurrence({ freq: 'daily', interval: 1 }, '2026-07-01', '2026-07-10', '2026-07-05'),
    ).toEqual([]);
  });

  test('переход через границу года — чистая календарная арифметика', () => {
    expect(
      expandRecurrence({ freq: 'daily', interval: 1 }, '2026-12-30', '2026-12-30', '2027-01-02'),
    ).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });
});

describe('expandRecurrence: weekly (01 §3.1)', () => {
  test('без byweekday: день недели seriesStart (среда) каждую неделю', () => {
    expect(
      expandRecurrence({ freq: 'weekly', interval: 1 }, '2026-07-01', '2026-07-01', '2026-07-20'),
    ).toEqual(['2026-07-01', '2026-07-08', '2026-07-15']);
  });

  test('без byweekday, interval=2: через неделю', () => {
    expect(
      expandRecurrence({ freq: 'weekly', interval: 2 }, '2026-07-01', '2026-07-01', '2026-07-31'),
    ).toEqual(['2026-07-01', '2026-07-15', '2026-07-29']);
  });

  test('byweekday=[mo,fr] interval=2: неделя пропускается целиком; mo недели 0 до seriesStart — не инстанс', () => {
    // Неделя 0: пн 2026-06-29 (< seriesStart, отбрасывается), пт 2026-07-03.
    // Неделя 1 (06-07-06..12) пропущена interval=2. Неделя 2: 13/17. Неделя 4: 27/31.
    expect(
      expandRecurrence(
        { freq: 'weekly', interval: 2, byweekday: ['mo', 'fr'] },
        '2026-07-01',
        '2026-07-01',
        '2026-07-31',
      ),
    ).toEqual(['2026-07-03', '2026-07-13', '2026-07-17', '2026-07-27', '2026-07-31']);
  });

  test('byweekday: from внутри серии не сдвигает фазу недель', () => {
    // from = вс недели 0; неделя 1 всё равно пропущена (фаза от недели seriesStart).
    expect(
      expandRecurrence(
        { freq: 'weekly', interval: 2, byweekday: ['mo', 'fr'] },
        '2026-07-01',
        '2026-07-05',
        '2026-07-31',
      ),
    ).toEqual(['2026-07-13', '2026-07-17', '2026-07-27', '2026-07-31']);
  });

  test('byweekday включает день seriesStart → seriesStart входит в результат', () => {
    expect(
      expandRecurrence(
        { freq: 'weekly', interval: 1, byweekday: ['we'] },
        '2026-07-01',
        '2026-07-01',
        '2026-07-08',
      ),
    ).toEqual(['2026-07-01', '2026-07-08']);
  });

  test('byweekday=[su]: воскресенье — крайний индекс недели (6), инстансы не съезжают', () => {
    // 2026-07-01 — среда; воскресенья окна: 05.07 и 12.07
    expect(
      expandRecurrence(
        { freq: 'weekly', interval: 1, byweekday: ['su'] },
        '2026-07-01',
        '2026-07-01',
        '2026-07-14',
      ),
    ).toEqual(['2026-07-05', '2026-07-12']);
  });

  test('byweekday: порядок и дубликаты нормализуются, результат хронологический', () => {
    expect(
      expandRecurrence(
        { freq: 'weekly', interval: 2, byweekday: ['fr', 'mo', 'fr'] },
        '2026-07-01',
        '2026-07-01',
        '2026-07-31',
      ),
    ).toEqual(['2026-07-03', '2026-07-13', '2026-07-17', '2026-07-27', '2026-07-31']);
  });
});

describe('expandRecurrence: monthly (01 §3.1)', () => {
  test('31-е число: при отсутствии дня — кламп к последнему дню месяца (фиксированное решение плана)', () => {
    expect(
      expandRecurrence({ freq: 'monthly', interval: 1 }, '2026-01-31', '2026-01-01', '2026-03-31'),
    ).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  test('високосный февраль: 31-е → 2028-02-29', () => {
    expect(
      expandRecurrence({ freq: 'monthly', interval: 1 }, '2028-01-31', '2028-01-01', '2028-03-31'),
    ).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
  });

  test('30-е число: кламп в феврале, возврат к 30 в марте (якорь не теряется)', () => {
    expect(
      expandRecurrence({ freq: 'monthly', interval: 1 }, '2026-01-30', '2026-01-01', '2026-03-31'),
    ).toEqual(['2026-01-30', '2026-02-28', '2026-03-30']);
  });

  test('from внутри серии: кламп-якорь сохраняется (31 → 30 апреля)', () => {
    expect(
      expandRecurrence({ freq: 'monthly', interval: 1 }, '2026-01-31', '2026-03-01', '2026-04-30'),
    ).toEqual(['2026-03-31', '2026-04-30']);
  });

  test('interval=2: через месяц от seriesStart', () => {
    expect(
      expandRecurrence({ freq: 'monthly', interval: 2 }, '2026-01-15', '2026-01-01', '2026-06-30'),
    ).toEqual(['2026-01-15', '2026-03-15', '2026-05-15']);
  });

  test('переход через границу года', () => {
    expect(
      expandRecurrence({ freq: 'monthly', interval: 1 }, '2026-11-30', '2026-11-01', '2027-01-31'),
    ).toEqual(['2026-11-30', '2026-12-30', '2027-01-30']);
  });
});

describe('expandRecurrence: until (01 §3.1)', () => {
  test('until раньше to обрезает; until включительно', () => {
    expect(
      expandRecurrence(
        { freq: 'daily', interval: 1, until: '2026-07-02' },
        '2026-07-01',
        '2026-07-01',
        '2026-07-10',
      ),
    ).toEqual(['2026-07-01', '2026-07-02']);
  });

  test('until раньше seriesStart → пустой результат', () => {
    expect(
      expandRecurrence(
        { freq: 'daily', interval: 1, until: '2026-06-30' },
        '2026-07-01',
        '2026-07-01',
        '2026-07-10',
      ),
    ).toEqual([]);
  });
});

describe('expandRecurrence: валидация входа (fail-fast, правило зафиксировано тестами)', () => {
  test('interval < 1 или нецелый → RangeError', () => {
    for (const interval of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        expandRecurrence({ freq: 'daily', interval }, '2026-07-01', '2026-07-01', '2026-07-10'),
      ).toThrow(RangeError);
    }
  });

  test('byweekday: пустой массив → RangeError («weekly ни в какие дни» — противоречие, не пустая серия)', () => {
    expect(() =>
      expandRecurrence(
        { freq: 'weekly', interval: 1, byweekday: [] },
        '2026-07-01',
        '2026-07-01',
        '2026-07-10',
      ),
    ).toThrow(RangeError);
  });

  test('byweekday при freq ≠ weekly → RangeError (молчаливое игнорирование скрывало бы битое правило)', () => {
    for (const freq of ['daily', 'monthly'] as const) {
      expect(() =>
        expandRecurrence(
          { freq, interval: 1, byweekday: ['mo'] },
          '2026-07-01',
          '2026-07-01',
          '2026-07-10',
        ),
      ).toThrow(RangeError);
    }
  });

  test('byweekday: неизвестный токен → RangeError', () => {
    const rule = {
      freq: 'weekly',
      interval: 1,
      byweekday: ['xx'],
    } as unknown as RecurrenceRule;
    expect(() => expandRecurrence(rule, '2026-07-01', '2026-07-01', '2026-07-10')).toThrow(
      RangeError,
    );
  });

  test('неизвестный freq (например, yearly из битых данных) → RangeError, не undefined', () => {
    const rule = { freq: 'yearly', interval: 1 } as unknown as RecurrenceRule;
    expect(() => expandRecurrence(rule, '2026-07-01', '2026-07-01', '2026-07-10')).toThrow(
      RangeError,
    );
  });

  test('кривой формат даты → RangeError (никакого new Date-парсинга)', () => {
    expect(() =>
      expandRecurrence({ freq: 'daily', interval: 1 }, '2026-7-1', '2026-07-01', '2026-07-10'),
    ).toThrow(RangeError);
    expect(() =>
      expandRecurrence({ freq: 'daily', interval: 1 }, '2026-07-01', '2026-07-01', '2026-02-30'),
    ).toThrow(RangeError);
  });
});
