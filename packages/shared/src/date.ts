// Чистая календарная арифметика по строкам 'YYYY-MM-DD': никакого new Date(str)-парсинга
// и таймзон (алгоритм days-from-civil Говарда Хиннанта, чистые целые). Дом календарной
// математики монорепо: внутри пакета им пользуются recurrence.ts и import/normalize.ts,
// наружу (index.ts) реэкспортируется только addDays — общий сдвиг даты для сервера.

export interface DateParts {
  y: number;
  m: number; // 1..12
  d: number; // 1..31
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function lastDayOfMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Строгий разбор 'YYYY-MM-DD' с проверкой календарной валидности. */
export function toParts(dateISO: string): DateParts {
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

export function fromParts({ y, m, d }: DateParts): string {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${mm}-${dd}`;
}

/** Дней от 1970-01-01 (алгоритм days-from-civil Хиннанта, чистые целые). */
export function epochDays({ y, m, d }: DateParts): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Обратное к epochDays. */
export function partsFromEpochDays(days: number): DateParts {
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

/**
 * Сдвиг ISO-даты на days дней. Единственная реализация в монорепо: сервер (материализация
 * recurring, окно дедупа импорта, горизонты бюджета) зовёт ЭТУ, а не свою копию.
 *
 * Проверяется только ФОРМАТ, не календарная существуемость: вход приходит и из
 * пользовательских фильтров грамматики §6.1, где «2026-02-31» исторически нормализуется
 * (в 2026-03-03), а не роняет запрос. Арифметика — целочисленная (epochDays), поэтому
 * нормализация совпадает с прежней реализацией на Date.UTC для переполнения ДНЯ и для
 * месяца до m=14 включительно; дальше civil-алгоритм перестаёт учитывать високосные дни
 * и расходится с Date.UTC (например, «2026-15-01»). На практике недостижимо: вход
 * каждого вызывающего либо провалидирован по формату, либо порождён машинно.
 */
export function addDays(dateISO: string, days: number): string {
  const match = DATE_RE.exec(dateISO);
  if (!match) throw new RangeError(`Некорректная дата (ожидается YYYY-MM-DD): "${dateISO}"`);
  const parts = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  return fromParts(partsFromEpochDays(epochDays(parts) + days));
}

/** Индекс дня недели (0 = понедельник): 1970-01-01 — четверг (индекс 3). */
export function mondayIndex(days: number): number {
  return (((days + 3) % 7) + 7) % 7;
}
