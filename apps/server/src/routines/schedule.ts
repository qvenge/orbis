// apps/server/src/routines/schedule.ts
// Расписание рутины → наступившие бакеты (V1.3). Чистая календарная функция без БД и без
// состояния: планировщик — сменная деталь (V1.2), и «какие слоты рутины сейчас должны
// быть отработаны» обязано считаться одинаково в тике, в тесте и в любой будущей замене
// тика (внешний cron, ленивый догон).
import { addDays, parseHHMM, type Weekday, weekdayOfDate } from '@orbis/shared';
import { instantOfLocal, wallClockIn } from '../recurring/materialize';
import { CATCH_UP_WINDOW_MS } from './constants';

const DAY_MS = 24 * 60 * 60_000;

export interface DueBucket {
  /** Слот 'YYYY-MM-DDTЧЧ:ММ' в стеночных часах владельца — ключ прогона (routineRunId). */
  bucket: string;
  /** Момент, когда слот наступил (instant): для сравнений и логов. */
  at: Date;
}

/**
 * Плановые бакеты рутины, наступившие к `now` и не старше окна догона.
 *
 * Бакет — календарная дата плюс `at` в таймзоне ВЛАДЕЛЬЦА, а не UTC: рутина «в 7 утра»
 * срабатывает в 7 утра владельца и после переезда, и после перехода на зимнее время;
 * ключ прогона строится из строки бакета, поэтому одному утру всегда соответствует один
 * ключ, сколько бы раз тик ни проснулся (инвариант 1).
 *
 * Кандидаты — сегодня и столько прошлых дней, сколько покрывает окно (для окна 6 ч —
 * сегодня и вчера: бакет 23:30 в 00:15 всё ещё вчерашний). Каждый кандидат отсекается
 * днями недели, «ещё не наступил» и «окно истекло» — за окном бакет пропускается молча,
 * без записи (V1.3: пропуск виден тем, что за дату нет прогона).
 *
 * Момент слота считается через `instantOfLocal` материализации: на переходах DST это даёт
 * ровно один instant на несуществующее и на дважды случившееся местное время (ближайший
 * валидный / первое вхождение) — дубля и пропуска нет по построению.
 *
 * Порядок — хронологический: если в окно попали два слота (широкое окно), первым идёт
 * старший — история прогонов читается сверху вниз.
 */
export function dueBuckets(args: {
  at: string;
  days?: readonly Weekday[];
  timeZone: string;
  now: Date;
  windowMs?: number;
}): DueBucket[] {
  const windowMs = args.windowMs ?? CATCH_UP_WINDOW_MS;
  const { h, m } = parseHHMM(args.at);
  const today = wallClockIn(args.now, args.timeZone).date;
  // Сколько прошлых дней перебрать, чтобы ни один слот в окне не остался за горизонтом:
  // при окне ≤ 24 ч это ровно «вчера»
  const daysBack = Math.max(1, Math.ceil(windowMs / DAY_MS));

  const out: DueBucket[] = [];
  for (let back = daysBack; back >= 0; back--) {
    const date = addDays(today, -back);
    if (args.days !== undefined && !args.days.includes(weekdayOfDate(date))) continue;
    const at = instantOfLocal(date, { h, m, s: 0 }, args.timeZone);
    const age = args.now.getTime() - at.getTime();
    // Отрицательный возраст — слот впереди; больше окна — догонять поздно. Границы
    // включительно: в 07:00:00 бакет 07:00 уже наступил, а ровно через 6 ч ещё догоняется.
    if (age < 0 || age > windowMs) continue;
    out.push({ bucket: `${date}T${args.at}`, at });
  }
  return out;
}

/**
 * Горизонт поиска ближайшего срабатывания: неделя плюс сегодня. Дни недели — единственное,
 * что прореживает расписание (`days` непуст по схеме), поэтому за восемь дней слот находится
 * всегда; больший горизонт означал бы только лишние обороты цикла на невозможном входе.
 */
const NEXT_BUCKET_HORIZON_DAYS = 8;

/**
 * Момент СЛЕДУЮЩЕГО срабатывания рутины — то, что экран показывает строкой «следующее
 * срабатывание» (V1.14). Зеркало `dueBuckets`, смотрящее вперёд, а не назад: те же
 * `at`/`days`/таймзона владельца и тот же перевод местного времени в instant, поэтому
 * обещание экрана и поведение тика не могут разъехаться на переходе DST.
 *
 * Сравнение строгое: в 07:00:00 сегодняшний слот уже НАСТУПИЛ (его и берёт `dueBuckets`),
 * и показывать его как «следующее» значило бы обещать владельцу то, что уже произошло.
 *
 * `null` — расписание не даёт ни одного слота в горизонте; при непустом `days` это
 * недостижимо, но вызывающий обязан уметь ответить «срабатывания нет» (рутина на паузе —
 * его дело, а не этой функции: здесь считается расписание, а не разрешение работать).
 */
export function nextBucketAt(args: {
  at: string;
  days?: readonly Weekday[];
  timeZone: string;
  now: Date;
}): Date | null {
  const { h, m } = parseHHMM(args.at);
  const today = wallClockIn(args.now, args.timeZone).date;
  for (let ahead = 0; ahead <= NEXT_BUCKET_HORIZON_DAYS; ahead++) {
    const date = addDays(today, ahead);
    if (args.days !== undefined && !args.days.includes(weekdayOfDate(date))) continue;
    const at = instantOfLocal(date, { h, m, s: 0 }, args.timeZone);
    if (at.getTime() > args.now.getTime()) return at;
  }
  return null;
}
