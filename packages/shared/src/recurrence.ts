// Раскрытие recurrence-правила в даты инстансов — PRD 01 §3.1 (правило в
// orbis/schedule.recurrence), §5.4 (инстансы от шаблона). Чистая календарная
// арифметика по строкам 'YYYY-MM-DD': никакого new Date(str)-парсинга и таймзон —
// локальную дату seriesStart и окно [from; to] вычисляет вызывающий (материализация).

export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly';
  interval: number; // ≥ 1
  byweekday?: Array<'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su'>; // только для weekly
  until?: string; // 'YYYY-MM-DD' включительно
}

interface DateParts {
  y: number;
  m: number; // 1..12
  d: number; // 1..31
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Понедельник — начало недели (weekStartDay-дефолт плана); индексы 0..6. */
const WEEKDAY_INDEX: Record<string, number> = {
  mo: 0,
  tu: 1,
  we: 2,
  th: 3,
  fr: 4,
  sa: 5,
  su: 6,
};

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function lastDayOfMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Строгий разбор 'YYYY-MM-DD' с проверкой календарной валидности. */
function toParts(dateISO: string): DateParts {
  const match = DATE_RE.exec(dateISO);
  if (!match) throw new RangeError(`Некорректная дата (ожидается YYYY-MM-DD): "${dateISO}"`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > lastDayOfMonth(y, m)) {
    throw new RangeError(`Несуществующая календарная дата: "${dateISO}"`);
  }
  return { y, m, d };
}

function fromParts({ y, m, d }: DateParts): string {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${mm}-${dd}`;
}

/** Дней от 1970-01-01 (алгоритм days-from-civil Хиннанта, чистые целые). */
function epochDays({ y, m, d }: DateParts): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Обратное к epochDays. */
function partsFromEpochDays(days: number): DateParts {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/** Индекс дня недели (0 = понедельник): 1970-01-01 — четверг (индекс 3). */
function mondayIndex(days: number): number {
  return (((days + 3) % 7) + 7) % 7;
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
      const idx = WEEKDAY_INDEX[wd];
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
