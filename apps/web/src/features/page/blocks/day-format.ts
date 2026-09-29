/**
 * Подписи ленты по дням (спека 1в §5.2): заголовок дня и колонка времени — В ПОЯСЕ ОТВЕТА
 * (`EntityBlocksResult.timeZone`), а не браузера: раскладку по дням считает сервер в поясе владельца,
 * и подпись в другом поясе (поездка, UTC на рабочем компьютере) разошлась бы с днём, в котором строка
 * стоит, — «сделано 23:40» стало бы «сделано 16:40», а встреча в 00:30 получила бы вчерашнюю дату.
 *
 * Только ленивый чанк ленты (`DayGroups.tsx`, РП-22): экран записи эагерен в каждом открытии, и
 * форматтеры в `lib/dates.ts` легли бы в его первый кадр (сторож единственного импортёра —
 * `scripts/day-format-import.test.ts`). Форматтеры дня и времени перенесены из прежней Повестки
 * (`features/agenda/useAgenda.ts`, `localDay`/`localTime` — модуль удаляет задача 10 среза) с тем же
 * запасом на битую зону.
 */
import type { BlockRowAt } from '@orbis/shared';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Форматтер в поясе `timeZone`; битая зона (строка настроек, которую `Intl` не знает) — запасной
 * вывод в поясе браузера, без исключения: лента без подписи хуже ленты с подписью не в том поясе.
 */
function inZone(timeZone: string, locale: string, opts: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone });
  } catch {
    return new Intl.DateTimeFormat(locale, opts);
  }
}

/**
 * День `YYYY-MM-DD` момента в поясе ответа. Дата без времени — как есть: у неё нет часов, и
 * `new Date('2026-09-27')` — полночь UTC, то есть «вчера» в любом поясе западнее Гринвича. Битое
 * значение — как есть.
 */
export function dayInTimeZone(iso: string, timeZone: string): string {
  if (DAY_RE.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return inZone(timeZone, 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * `HH:MM` момента в поясе ответа; битое значение — как есть. Часовой цикл `h23`, а не
 * `hour12: false`: у последнего полночь печатается «24:20» (цикл h24 в части движков).
 */
export function timeInTimeZone(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return inZone(timeZone, 'ru-RU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    d,
  );
}

/**
 * «сб, 26 сентября» дня группы. День группы — уже день владельца: форматируется в UTC над полночью
 * UTC этой даты, чтобы пояс браузера не сдвинул его на соседний.
 */
const DAY_FMT = new Intl.DateTimeFormat('ru', {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

const DAY_MS = 86_400_000;

/**
 * Заголовок дня: «Сегодня · сб, 26 сентября» | «Завтра · вс, 27 сентября» | «пн, 28 сентября».
 *
 * «Завтра» — календарём над полночью UTC, а не `addDays` shared: его модуль дат эагерным кодом не
 * используется, и первый же ленивый импортёр вынес бы календарную арифметику в общий чанк первого
 * кадра записи (+≈300 Б gzip замыкания, замерено сборкой задачи 7).
 */
export function dayHeaderLabel(day: string, today: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  const text = DAY_FMT.format(at);
  if (day === today) return `Сегодня · ${text}`;
  if (at - Date.parse(`${today}T00:00:00Z`) === DAY_MS) return `Завтра · ${text}`;
  return text;
}

/**
 * Колонка времени строки (§5.2) — по дате, поставившей запись в день группы `day`:
 *  - `moment` со временем — «09:00»; с `end` в тот же день — «14:00–15:30»; `end` в другой день —
 *    «09:00 → 30.09»; «весь день» привязки или `moment`-дата — «весь день»;
 *  - `deadline` — «срок»;
 *  - `done` — «сделано 16:05»; `done`-дата — «сделано».
 * Группировка по свойству или адресу слота (`slot: null`, одна дата без приоритета) читается как
 * момент: со временем — время, дата — «весь день» (сервер ставит ей `allDay`, `BlockRowAt`).
 *
 * «Без времени» — признак сервера `at.untimed`, а не своя проверка значения: по нему же сервер ставит
 * такие строки первыми в дне, и подпись не расходится с порядком.
 *
 * `end` — дата без часов (слот `end` — `timestamp | date`): время конца не печатается — в день
 * момента это «09:00», а не «09:00–07:00» (полночь UTC даты в поясе ответа); в другой день — «→ дд.мм».
 */
export function rowTimeLabel(at: BlockRowAt, day: string, timeZone: string): string {
  if (at.slot === 'deadline') return 'срок';
  if (at.slot === 'done')
    return at.untimed ? 'сделано' : `сделано ${timeInTimeZone(at.value, timeZone)}`;
  if (at.untimed) return 'весь день';
  const start = timeInTimeZone(at.value, timeZone);
  if (at.end === null) return start;
  const endDay = dayInTimeZone(at.end, timeZone);
  if (endDay === day)
    return DAY_RE.test(at.end) ? start : `${start}–${timeInTimeZone(at.end, timeZone)}`;
  return `${start} → ${endDay.slice(8, 10)}.${endDay.slice(5, 7)}`;
}

/** «18 июл.» дня — тот же вид, что у даты строки `EntityRow` (`formatDay`). */
const ROW_DATE_FMT = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

/**
 * Дата строки ленты (элемент даты `EntityRow`) в поясе ответа: `null` — её день совпадает с днём
 * группы и не печатается (§5.2); иначе подпись дня В ПОЯСЕ ОТВЕТА. Решать «печатать ли» в поясе ответа,
 * а печатать в поясе браузера нельзя: встреча 28.09 00:30 по времени владельца в UTC-браузере
 * подписалась бы «27 сент.» под заголовком «Сегодня · вс, 27 сентября».
 */
export function rowDateLabel(value: string, day: string | null, timeZone: string): string | null {
  const own = dayInTimeZone(value, timeZone);
  if (own === day) return null;
  const at = Date.parse(`${own}T00:00:00Z`);
  return Number.isNaN(at) ? value : ROW_DATE_FMT.format(at);
}
