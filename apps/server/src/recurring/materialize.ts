// apps/server/src/recurring/materialize.ts
// Ленивая материализация recurring-инстансов (PRD 01 §5.4, §3.3; 02 §6).
//
// Порождает ТОЛЬКО сервер: инстансы получают детерминированные uuidv5-id
// (recurringInstanceId), поэтому конкурентные материализации сходятся к одним и тем же
// строкам — дубль невозможен по построению. Записи — единственным путём через executor
// (source='system'), по одному batch на шаблон с детерминированным batch_id: повтор
// того же окна идемпотентен и по SELECT-предпроверке, и по audit-PK batch (§7.8),
// а конфликт PK сущности у конкурентов резолвится перечитыванием (retry ниже).
import {
  expandRecurrence,
  materializeBatchId,
  type QueryAst,
  type RecurrenceRule,
  recurringInstanceId,
} from '@orbis/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { entities, userSettings } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { DEFAULT_TIMEZONE, isValidTimeZone } from '../query/context';

/** Горизонт материализации: не дальше 14 дней вперёд от сегодня (§5.4). */
const HORIZON_DAYS = 14;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Поля-триггеры хука: date/timestamp-поля аспектов orbis/schedule и orbis/financial. */
const MATERIALIZABLE_FIELDS = new Set(['start_at', 'occurred_on']);

/** Попыток на шаблон при гонке конкурентных материализаций пересекающихся окон. */
const MAX_ATTEMPTS = 3;

// Один инстанс синка на модуль (как в routers/entity.ts): состояния не хранит,
// audit-сообщение batch пишется тем же tx, что операции executor'а (§7.8).
const sink = makeChatJournalSink();

type AspectsMap = Record<string, Record<string, unknown>>;
type TemplateRow = typeof entities.$inferSelect;

/** Сдвиг ISO-даты на days дней — чистая календарная арифметика через Date.UTC. */
function addDays(dateISO: string, days: number): string {
  if (!DATE_RE.test(dateISO)) {
    throw new RangeError(`Некорректная дата (ожидается YYYY-MM-DD): "${dateISO}"`);
  }
  const [y, m, d] = dateISO.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

interface WallClock {
  date: string; // 'YYYY-MM-DD' — локальная дата instant'а в таймзоне
  time: { h: number; m: number; s: number }; // локальное время суток
}

/** Локальные дата и время instant'а в IANA-таймзоне (hourCycle h23: полночь — 00, не 24). */
function wallClockIn(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: { h: Number(get('hour')), m: Number(get('minute')), s: Number(get('second')) },
  };
}

/**
 * Instant локального wall-clock-времени `dateISO T time` в таймзоне: итеративная
 * подгонка смещения (сходится за ≤2 шага; в DST-провале даёт ближайший валидный момент).
 * Сохраняет время суток шаблона на каждую дату инстанса — сдвиг «дата + N суток в мс»
 * ломал бы час при переходе на летнее/зимнее время.
 */
function instantOfLocal(dateISO: string, time: WallClock['time'], timeZone: string): Date {
  const [y, m, d] = dateISO.split('-').map(Number) as [number, number, number];
  const desired = Date.UTC(y, m - 1, d, time.h, time.m, time.s);
  let guess = desired;
  for (let i = 0; i < 3; i++) {
    const wc = wallClockIn(new Date(guess), timeZone);
    const [wy, wm, wd] = wc.date.split('-').map(Number) as [number, number, number];
    const rendered = Date.UTC(wy, wm - 1, wd, wc.time.h, wc.time.m, wc.time.s);
    if (rendered === desired) break;
    guess += desired - rendered;
  }
  return new Date(guess);
}

/**
 * Окно материализации из AST запроса (§5.4: любой запрос диапазона дат материализует
 * видимый диапазон). Чистая AST-прогулка без обращений к БД — запросы без date-условий
 * не платят ничего. Условие — по полям start_at/occurred_on (аспекты orbis/schedule,
 * orbis/financial): относительные токены дают явный диапазон (overdue и прочий
 * «открытый низ» — только сегодня и будущее: прошлое лениво не порождаем),
 * литеральная 'YYYY-MM-DD' — окно этого дня. Несколько условий объединяются
 * в [min from; max to]; горизонт +14д обрезает materializeInstances.
 */
export function materializationWindow(
  ast: QueryAst,
  today: string,
): { from: string; to: string } | null {
  let from: string | null = null;
  let to: string | null = null;
  const widen = (f: string, t: string) => {
    from = from === null || f < from ? f : from;
    to = to === null || t > to ? t : to;
  };
  for (const filter of ast.filters) {
    if (filter.kind !== 'field' || !MATERIALIZABLE_FIELDS.has(filter.field)) continue;
    // noneOf («не эти даты») диапазона не задаёт
    if (filter.condition.kind !== 'anyOf') continue;
    for (const v of filter.condition.values) {
      if (v.kind === 'date_token') {
        switch (v.token) {
          case 'today':
          case 'overdue': // открытый низ: материализуем только сегодня и будущее
            widen(today, today);
            break;
          case 'next_7d':
            widen(today, addDays(today, 7));
            break;
          case 'after_7d':
            widen(addDays(today, 8), addDays(today, HORIZON_DAYS));
            break;
        }
      } else if (DATE_RE.test(v.value)) {
        widen(v.value, v.value);
      }
    }
  }
  return from !== null && to !== null ? { from, to } : null;
}

export interface MaterializeDeps {
  db: Db;
  ownerId: string;
  /** Окно запроса, 'YYYY-MM-DD' включительно с обеих сторон. */
  from: string;
  to: string;
  /** «Сегодня» в таймзоне пользователя (queryContext) — якорь горизонта +14д. */
  today: string;
}

/**
 * Материализует инстансы всех recurring-шаблонов владельца в окне
 * [from; min(to, today+14d)] (§5.4). Идемпотентна: существующие детерминированные id
 * пропускаются (SELECT id = ANY перед вставкой), повтор окна — replay batch по audit-PK,
 * гонка конкурентов — retry с перечитыванием. Битый шаблон (кривое recurrence-правило,
 * невалидные данные) пропускается, не роняя запрос вызывающего.
 */
export async function materializeInstances(deps: MaterializeDeps): Promise<{ created: number }> {
  const { db, ownerId, from, today } = deps;
  if (!DATE_RE.test(from) || !DATE_RE.test(deps.to)) {
    throw new RangeError(`Некорректное окно материализации: [${from}; ${deps.to}]`);
  }
  const horizon = addDays(today, HORIZON_DAYS);
  const to = deps.to < horizon ? deps.to : horizon;
  if (to < from) return { created: 0 };

  // Фаза чтения (короткий tx под RLS): шаблоны владельца + его таймзона.
  // Шаблон = неархивная сущность с orbis/schedule.recurrence (§3.1); financial без
  // recurrence шаблоном не является и сюда не попадает (§3.3 — пропуск по построению).
  const { templates, userTimezone } = await withIdentity(db, ownerId, async (tx) => {
    const rows = await tx
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.archived, false),
          sql`${entities.aspects} -> 'orbis/schedule' -> 'recurrence' IS NOT NULL`,
        ),
      );
    const settings = await tx
      .select({ timezone: userSettings.timezone })
      .from(userSettings)
      .where(eq(userSettings.ownerId, ownerId));
    const stored = settings[0]?.timezone ?? DEFAULT_TIMEZONE;
    return {
      templates: rows,
      userTimezone: isValidTimeZone(stored) ? stored : DEFAULT_TIMEZONE,
    };
  });

  let created = 0;
  for (const template of templates) {
    created += await materializeTemplate(db, ownerId, template, userTimezone, from, to);
  }
  return { created };
}

/** Материализация одного шаблона; возвращает число созданных инстансов. */
async function materializeTemplate(
  db: Db,
  ownerId: string,
  template: TemplateRow,
  userTimezone: string,
  from: string,
  to: string,
): Promise<number> {
  const aspects = template.aspects as AspectsMap;
  const schedule = aspects['orbis/schedule'];
  if (!schedule || typeof schedule.start_at !== 'string') return 0;

  // Таймзона дат инстансов: orbis/schedule.timezone шаблона, фолбэк — таймзона
  // пользователя (§5.4); мусорная зона деградирует до фолбэка, не роняя запрос
  const tzRaw = typeof schedule.timezone === 'string' ? schedule.timezone : undefined;
  const timezone = tzRaw !== undefined && isValidTimeZone(tzRaw) ? tzRaw : userTimezone;
  const startInstant = new Date(schedule.start_at);
  if (Number.isNaN(startInstant.getTime())) return 0;
  // seriesStart = локальная дата start_at шаблона в этой таймзоне; time — время суток
  const wall = wallClockIn(startInstant, timezone);

  let dates: string[];
  try {
    dates = expandRecurrence(schedule.recurrence as RecurrenceRule, wall.date, from, to);
  } catch (e) {
    // Битое правило (RangeError, fail-fast A2): пропускаем ШАБЛОН, а не роняем весь
    // запрос вызывающего — остальные шаблоны материализуются (закреплено тестом)
    if (e instanceof RangeError) return 0;
    throw e;
  }
  if (dates.length === 0) return 0;

  // batch_id детерминирован окном: повтор того же окна → replay по audit-PK (§7.8)
  const batchId = materializeBatchId(template.id, from, to);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Идемпотентность: SELECT существующих id перед вставкой; архивированный владельцем
    // (в т.ч. Undo материализации) инстанс тоже «существует» — не пересоздаём и
    // не перезаписываем правки (02 §6 «Правка инстанса recurring»)
    const idByDate = new Map(dates.map((d) => [d, recurringInstanceId(template.id, d)]));
    const existing = new Set(
      (
        await withIdentity(db, ownerId, (tx) =>
          tx
            .select({ id: entities.id })
            .from(entities)
            .where(inArray(entities.id, [...idByDate.values()])),
        )
      ).map((r) => r.id),
    );
    const missing = dates.filter((d) => !existing.has(idByDate.get(d) as string));
    if (missing.length === 0) return 0;

    // Один batch на шаблон: create+relation каждой даты; derived_from в том же batch
    // легитимирует financial-инвариант инстанса (recurring=true без recurrence, §3.3)
    const operations = missing.flatMap((date) =>
      instanceOps(template, schedule, timezone, wall, date),
    );
    const r = await execute(
      db,
      { actorUserId: ownerId, actorKind: 'owner', source: 'system', operations, batchId },
      { sink },
    );
    if (r.ok) return r.idempotentReplay ? 0 : missing.length;
    // Гонка: конкурент с ДРУГИМ окном вставил тот же детерминированный id между нашим
    // SELECT и INSERT → executor вернул CONFLICT (id_conflict, batch откачен целиком).
    // Перечитываем и повторяем без уже созданного. Тот же batch_id конкурента ловится
    // выше по audit-PK как replay, сюда не доходит.
    if (r.error.code === 'CONFLICT') continue;
    // Прочие структурированные отказы (INVARIANT битых данных, LIMIT): шаблон
    // пропускается — материализация не имеет права ронять запрос пользователя
    return 0;
  }
  return 0;
}

/** Пара операций batch для одной даты: entity_create инстанса + derived_from шаблон→инстанс. */
function instanceOps(
  template: TemplateRow,
  schedule: Record<string, unknown>,
  timezone: string,
  wall: WallClock,
  date: string,
): Array<{ tool: string; input: unknown }> {
  const id = recurringInstanceId(template.id, date);
  const start = instantOfLocal(date, wall.time, timezone);

  // orbis/schedule инстанса: копия шаблона без recurrence, start_at — дата инстанса
  // со временем суток шаблона (в его таймзоне); end_at сдвигается той же длительностью
  const instSchedule: Record<string, unknown> = { ...schedule, start_at: start.toISOString() };
  delete instSchedule.recurrence;
  if (typeof schedule.end_at === 'string') {
    const templStart = new Date(schedule.start_at as string).getTime();
    const templEnd = new Date(schedule.end_at).getTime();
    if (Number.isNaN(templEnd)) delete instSchedule.end_at;
    else instSchedule.end_at = new Date(start.getTime() + (templEnd - templStart)).toISOString();
  }

  const instAspects: AspectsMap = { 'orbis/schedule': instSchedule as Record<string, unknown> };
  const fin = (template.aspects as AspectsMap)['orbis/financial'];
  if (fin) {
    // §5.4/§3.3: occurred_on = дата инстанса, planned=true (до перехода в факт),
    // recurring=true (инстанс шаблона); привязка к конверту — при переходе в факт (A6+)
    instAspects['orbis/financial'] = { ...fin, occurred_on: date, planned: true, recurring: true };
  }

  const input: Record<string, unknown> = {
    id,
    title: template.title,
    tags: template.tags,
    aspects: instAspects,
  };
  if (template.emoji !== null) input.emoji = template.emoji;

  return [
    { tool: 'entity_create', input },
    {
      tool: 'relation_create',
      input: { source_id: template.id, target_id: id, relation_type: 'derived_from' },
    },
  ];
}
