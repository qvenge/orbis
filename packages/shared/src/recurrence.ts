// Раскрытие recurrence-правила в даты инстансов — PRD 01 §3.1 (правило в
// orbis/schedule.recurrence), §5.4 (инстансы от шаблона). Чистая календарная
// арифметика по строкам 'YYYY-MM-DD' — хелперы в date.ts: никакого new Date(str)-парсинга
// и таймзон — локальную дату seriesStart и окно [from; to] вычисляет вызывающий (материализация).

import {
  type DateParts,
  epochDays,
  fromParts,
  lastDayOfMonth,
  mondayIndex,
  partsFromEpochDays,
  toParts,
  WEEKDAY_INDEX,
  type Weekday,
} from './date';

export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly';
  interval: number; // ≥ 1
  byweekday?: Weekday[]; // только для weekly; алфавит один с `days` рутины (date.ts)
  until?: string; // 'YYYY-MM-DD' включительно
}

/**
 * Даты инстансов серии в [from; to] включительно. seriesStart — дата первого
 * инстанса (= локальная дата start_at шаблона в его таймзоне, вычисляет вызывающий).
 * Все аргументы и результат — 'YYYY-MM-DD'.
 *
 * Семантика (01 §3.1): daily — каждые interval дней от seriesStart; weekly без
 * byweekday — день недели seriesStart каждые interval недель; weekly с byweekday —
 * перечисленные дни недель, отсчитываемых от недели seriesStart (неделя с понедельника);
 * monthly — число месяца seriesStart каждые interval месяцев, при отсутствии числа —
 * последний день месяца (аренда 31-го постится 28/29 февраля; якорное число не теряется).
 * until и to ограничивают сверху (включительно), seriesStart и from — снизу.
 * from внутри серии фазу не сдвигает. Некорректный вход (interval < 1 или нецелый,
 * пустой/неизвестный byweekday, кривая дата) — RangeError: fail-fast вместо тихого
 * фолбэка, чтобы битое правило не порождало и не глотало инстансы молча.
 */
export function expandRecurrence(
  rule: RecurrenceRule,
  seriesStart: string,
  from: string,
  to: string,
): string[] {
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new RangeError(`recurrence.interval должен быть целым ≥ 1, получен: ${rule.interval}`);
  }
  if (rule.byweekday !== undefined && rule.freq !== 'weekly') {
    // Молчаливое игнорирование скрывало бы битое правило: пользователь ждёт «по понедельникам»,
    // а получает совсем другие даты (fail-fast — та же политика, что для interval/freq).
    throw new RangeError(
      `recurrence.byweekday допустим только при freq='weekly', получен freq=${JSON.stringify(rule.freq)}`,
    );
  }

  const startDays = epochDays(toParts(seriesStart));
  const lower = Math.max(startDays, epochDays(toParts(from)));
  let upper = epochDays(toParts(to));
  if (rule.until !== undefined) {
    upper = Math.min(upper, epochDays(toParts(rule.until)));
  }
  if (upper < lower) return [];

  switch (rule.freq) {
    case 'daily':
      return expandByDayStep(startDays, rule.interval, lower, upper);
    case 'weekly':
      if (rule.byweekday === undefined) {
        return expandByDayStep(startDays, rule.interval * 7, lower, upper);
      }
      return expandWeeklyByWeekday(rule.byweekday, startDays, rule.interval, lower, upper);
    case 'monthly':
      return expandMonthly(toParts(seriesStart), rule.interval, lower, upper);
    default:
      // Битые данные обходят типы (правило читается из JSON-аспекта): fail-fast.
      throw new RangeError(`Неизвестный recurrence.freq: ${JSON.stringify(rule.freq)}`);
  }
}

/** daily и weekly-без-byweekday: инстансы startDays + k·step, k ≥ 0. */
function expandByDayStep(startDays: number, step: number, lower: number, upper: number): string[] {
  // Первый k, для которого инстанс ≥ lower — фаза считается от startDays, не от from.
  const k0 = Math.max(0, Math.ceil((lower - startDays) / step));
  const result: string[] = [];
  for (let day = startDays + k0 * step; day <= upper; day += step) {
    result.push(fromParts(partsFromEpochDays(day)));
  }
  return result;
}

/** weekly с byweekday: перечисленные дни недель с чётностью от недели seriesStart. */
function expandWeeklyByWeekday(
  byweekday: NonNullable<RecurrenceRule['byweekday']>,
  startDays: number,
  interval: number,
  lower: number,
  upper: number,
): string[] {
  if (byweekday.length === 0) {
    throw new RangeError(
      'recurrence.byweekday не может быть пустым: «weekly ни в какие дни» — противоречие',
    );
  }
  const offsets = [...new Set(byweekday)]
    .map((wd) => {
      // Тип обещает Weekday, но правило читается из JSON-аспекта: битые данные обходят
      // типы, поэтому lookup сознательно расширен до undefined ради fail-fast ниже.
      const idx: number | undefined = WEEKDAY_INDEX[wd];
      if (idx === undefined) throw new RangeError(`Неизвестный день недели: "${wd}"`);
      return idx;
    })
    .sort((a, b) => a - b);

  const week0Monday = startDays - mondayIndex(startDays); // неделя 0 — неделя seriesStart
  const stride = interval * 7;
  // Стартовая неделя чуть раньше lower (кратно stride) — фильтрация ниже отсечёт лишнее.
  const i0 = Math.max(0, Math.floor((lower - 6 - week0Monday) / stride));
  const result: string[] = [];
  for (let monday = week0Monday + i0 * stride; monday <= upper; monday += stride) {
    for (const offset of offsets) {
      const day = monday + offset;
      if (day >= lower && day <= upper) result.push(fromParts(partsFromEpochDays(day)));
    }
  }
  return result;
}

/** monthly: якорное число seriesStart каждые interval месяцев, кламп к концу месяца. */
function expandMonthly(start: DateParts, interval: number, lower: number, upper: number): string[] {
  const startMonth = start.y * 12 + (start.m - 1);
  const lowerParts = partsFromEpochDays(lower);
  const lowerMonth = lowerParts.y * 12 + (lowerParts.m - 1);
  // Стартуем на шаг раньше lower-месяца (кламп мог утянуть день ниже) и фильтруем.
  const k0 = Math.max(0, Math.floor((lowerMonth - startMonth) / interval) - 1);
  const result: string[] = [];
  for (let k = k0; ; k += 1) {
    const monthIndex = startMonth + k * interval;
    const y = Math.floor(monthIndex / 12);
    const m = (monthIndex % 12) + 1;
    const parts = { y, m, d: Math.min(start.d, lastDayOfMonth(y, m)) };
    const day = epochDays(parts);
    if (day > upper) break;
    if (day >= lower) result.push(fromParts(parts));
  }
  return result;
}
