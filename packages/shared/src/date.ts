// Чистая календарная арифметика по строкам 'YYYY-MM-DD': никакого new Date(str)-парсинга
// и таймзон (алгоритм days-from-civil Говарда Хиннанта, чистые целые). Дом календарной
// математики монорепо: внутри пакета им пользуются recurrence.ts и import/normalize.ts,
// наружу (index.ts) выходит сдвиг даты и календарь дней/времени рутин (V1.1) — планировщику
// нужны и алфавит дней, и разбор 'ЧЧ:ММ', и связка «дата → день недели».

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

/**
 * Голова 'YYYY-MM-DD' у даты И у момента: у ISO-момента календарный день — те же первые
 * десять символов, и второго правила для него не нужно. `toParts` рядом сюда не годится —
 * его регексп якорит конец строки, то есть моменты он не разбирает вовсе.
 */
const CALENDAR_HEAD_RE = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

/**
 * СУЩЕСТВУЕТ ЛИ такой день в календаре. Текст, который датой или моментом не выглядит,
 * получает `true`: это не дата, и календарю до неё дела нет.
 *
 * Зачем отдельно от формы. Форму значения описывает JSON Schema свойства (§А7-1,
 * `registry/value-schema.ts`), и `2026-02-30` её паттерн `^\d{4}-\d{2}-\d{2}$` ПРОХОДИТ:
 * календарь в JSON Schema невыразим. Дальше такое значение молча записывается, а падает
 * позже и в другом месте — на первом же приведении `::date` в запросе (Postgres 22008).
 * Дефект записи, проявляющийся как поломка чтения, — тот класс, который труднее всего
 * связать с причиной, поэтому проверка стоит на ВСЕХ трёх путях сразу: разбор запроса
 * (`query/parse-ast.ts`), компиляция запроса (`query/compile-ast.ts`), запись
 * (`registry/validate-props.ts`). Импорт выписки закрывает тот же класс четвёртым местом —
 * через `toParts` (`contracts/import.ts`), потому что там значение и так разбирается в
 * части для календарной арифметики дедупа.
 *
 * ДОМ У КАЛЕНДАРЯ ОДИН, и это здесь: считает `lastDayOfMonth` — тот же, которым живут
 * `toParts` и вся арифметика recurrence. Своя копия «сколько дней в феврале» у любого из
 * четверых разошлась бы с остальными ровно на високосном годе.
 *
 * ЗВАТЬ ТОЛЬКО ПО ТИПУ ЗНАЧЕНИЯ (date/timestamp). Все три вызова гейтятся видом свойства
 * из реестра, и снимать этот гейт нельзя: `orbis/run_bucket` — свойство типа `text`, чей
 * паттерн НЕСЁТ дату внутри ('2026-02-30T07:00' форму проходит). В SQL он не кастуется, то
 * есть чтения не роняет, и трогать его отдельным правилом мы не стали (рулинг Р-9b-5);
 * ungate'нутый вызов начал бы отвергать его молча и не там, где решение принималось.
 */
export function hasValidCalendar(text: string): boolean {
  const m = CALENDAR_HEAD_RE.exec(text);
  if (m === null) return true;
  const y = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= lastDayOfMonth(y, month);
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

// ─── Дни недели и время суток (V1.1: расписание рутин) ────────────────────────
// Алфавит один на монорепо: тем же кодом дней записано recurrence.byweekday (01 §3.1) и
// `days` рутины. Разъехавшись, две нотации дали бы «понедельник» в одном месте и «mo» в
// другом на одном и том же графе.

export const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Индекс дня недели в WEEKDAYS; согласован с mondayIndex (0 = понедельник). */
export const WEEKDAY_INDEX: Record<Weekday, number> = {
  mo: 0,
  tu: 1,
  we: 2,
  th: 3,
  fr: 4,
  sa: 5,
  su: 6,
};

/** Локальное время суток 'ЧЧ:ММ' с обязательным ведущим нулём (поле `at` рутины). */
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 'ЧЧ:ММ' → {h, m}. Своей валидации нет намеренно: строка приходит из аспекта, где форму
 * держит HHMM_RE в схеме реестра (ajv, стадия 2), — второй парсер был бы вторым мнением
 * о формате. На непровалидированном входе вернёт NaN, и это честнее тихого фолбэка.
 */
export function parseHHMM(at: string): { h: number; m: number } {
  return { h: Number(at.slice(0, 2)), m: Number(at.slice(3, 5)) };
}

/** День недели календарной даты 'YYYY-MM-DD' — предикат `days` рутины. */
export function weekdayOfDate(dateISO: string): Weekday {
  const day = WEEKDAYS[mondayIndex(epochDays(toParts(dateISO)))];
  // mondayIndex возвращает 0..6, а WEEKDAYS ровно семиэлементен — ветка недостижима,
  // но без неё noUncheckedIndexedAccess требует non-null assertion, а он врёт компилятору.
  if (day === undefined) throw new RangeError(`Не удалось определить день недели: "${dateISO}"`);
  return day;
}
