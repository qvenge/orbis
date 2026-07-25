// Хуки Agenda-lite (02-core-os §4, Task D1). Сервер отдаёт ПЛОСКИЕ выборки грамматики
// §6.1 (окно материализации recurring он расширяет сам — 01-arch §5.4); группировка по
// дням, скрытие recurring-шаблонов и слияние «Просроченного» — работа клиента.
//
// Границы дня сервер считает в таймзоне пользователя (AT TIME ZONE в компиляторе), поэтому
// клиент группирует ТОЙ ЖЕ таймзоной (settings.timezone) — иначе строки у полуночи уехали
// бы в соседнюю секцию. Дата-арифметика — addDays из @orbis/shared, «сегодня» — todayISO.
import { addDays } from '@orbis/shared';
import { type RouterOutputs, trpc } from '../../trpc';
import { todayISO } from '../budget/useBudget';

export type AgendaEntity = RouterOutputs['entity']['query'][number];

/** §4.1: горизонт «Сегодня → +7 дней» — ровно 8 секций; пустые не скрываются. */
export const AGENDA_DAYS = 8;

// Потолок выборки окна. offset в грамматике §6.1 нет, пагинация в Agenda спекой не
// предусмотрена: 200 строк на 8 дней — осознанный потолок (K18), заведомо больше
// любой реальной недели. Упор в него означал бы календарь другого масштаба — это
// уже полный Calendar view (§4.3, Future).
const WINDOW_LIMIT = 200;

// «Просроченное» растёт без ограничения давности (§4.2), потому тот же потолок — но
// молчаливо резать его нельзя (урок C6): при упоре счётчик показывает «200+».
const OVERDUE_LIMIT = 200;

// Бейдж вкладки Agenda (§1.5, Task D2) смонтирован на ЛЮБОМ экране и делит кэш с этим
// хуком. Без явного staleTime каждый маунт бейджа бил бы в сервер; 60 с — потолок K16.
//
// Этот staleTime корректен ТОЛЬКО потому, что каждый пишущий путь инвалидирует
// entity.query явно: detail-экран (useEntityDetail.useEntityUpdate — закрытие задачи,
// перенос даты, архивация: приёмка §8.2), QuickCapture, QuickAddBar, fast-path чата,
// импорт. refetchOnWindowFocus в trpc.ts выключен — само по себе ничто не протухнет.
// Заводя новый путь записи в граф, инвалидируй entity.query, иначе строка провисит минуту.
const AGENDA_STALE_MS = 60_000;

/** §4.1: дневное окно — только сущности с orbis/schedule, сортировка по времени. */
export const AGENDA_DAYS_QUERY = `aspect=orbis/schedule, start_at=today|next_7d, sortBy=start_at:asc, limit=${WINDOW_LIMIT}`;

/**
 * §4.2 п.1 — незакрытые задачи с прошедшим сроком. due_date НЕ материализуемое поле
 * (materialize.ts MATERIALIZABLE_FIELDS), поэтому запрос идёт дешёвым путём и держится
 * ОТДЕЛЬНО от start_at=overdue, который проходит через двухфазный каркас материализации (K16).
 */
export const AGENDA_OVERDUE_DUE_QUERY = `aspect=orbis/task, due_date=overdue, status=!done&!cancelled, sortBy=due_date:asc, limit=${OVERDUE_LIMIT}`;

/**
 * §4.2 п.2 — незакрытые scheduled-задачи, время которых прошло. Два aspect= в одном
 * запросе грамматика принимает (K14) — и именно они отсекают чистые события (§4.2:
 * прошедшее время события не означает «пропущено», приёмка §8.1).
 */
export const AGENDA_OVERDUE_START_QUERY = `aspect=orbis/task, aspect=orbis/schedule, start_at=overdue, status=!done&!cancelled, sortBy=start_at:asc, limit=${OVERDUE_LIMIT}`;

function aspectOf(e: AgendaEntity, id: string): Record<string, unknown> | undefined {
  return (e.aspects as Record<string, Record<string, unknown> | undefined>)[id];
}

function stringField(e: AgendaEntity, aspect: string, field: string): string | null {
  const v = aspectOf(e, aspect)?.[field];
  return typeof v === 'string' ? v : null;
}

export const startAt = (e: AgendaEntity) => stringField(e, 'orbis/schedule', 'start_at');
export const endAt = (e: AgendaEntity) => stringField(e, 'orbis/schedule', 'end_at');
export const dueDate = (e: AgendaEntity) => stringField(e, 'orbis/task', 'due_date');
export const isAllDay = (e: AgendaEntity) => aspectOf(e, 'orbis/schedule')?.all_day === true;

/**
 * §4.1: шаблон recurring — сущность с заданным `orbis/schedule.recurrence`; в Agenda
 * скрыт (инстансы recurrence не несут — materialize.ts). Грамматика «поле IS NULL»
 * не выражает, поэтому фильтр только клиентский. Действует и в «Просроченном»:
 * иначе якорный start_at шаблона висел бы там вечно.
 */
export function isRecurringTemplate(e: AgendaEntity): boolean {
  return aspectOf(e, 'orbis/schedule')?.recurrence !== undefined;
}

function intl(tz: string | undefined, opts: Intl.DateTimeFormatOptions, locale: string) {
  return new Intl.DateTimeFormat(locale, { ...(tz ? { timeZone: tz } : {}), ...opts });
}

const DAY_OPTS = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;

/** Локальный день 'YYYY-MM-DD' момента в таймзоне пользователя; битый вход → null. */
export function localDay(iso: string, tz?: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return intl(tz, DAY_OPTS, 'en-CA').format(d);
  } catch {
    return intl(undefined, DAY_OPTS, 'en-CA').format(d); // битая tz из настроек
  }
}

const TIME_OPTS = { hour: '2-digit', minute: '2-digit', hour12: false } as const;

/** 'HH:MM' момента в таймзоне пользователя; битый вход → null. */
export function localTime(iso: string, tz?: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return intl(tz, TIME_OPTS, 'ru-RU').format(d);
  } catch {
    return intl(undefined, TIME_OPTS, 'ru-RU').format(d); // битая tz из настроек
  }
}

export type AgendaDay = { date: string; entities: AgendaEntity[] };

/**
 * Дневные секции §4.1: 8 дней от «сегодня», сущности разложены по локальному дню
 * `start_at`. Шаблоны recurring отфильтрованы; внутри дня all_day идут первыми,
 * дальше сохраняется порядок сервера (sortBy=start_at:asc — Array#sort стабилен).
 */
export function useAgendaDays(): {
  days: AgendaDay[];
  timezone: string | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const settings = trpc.user.getSettings.useQuery();
  const tz = settings.data?.timezone;
  const q = trpc.entity.query.useQuery(
    { query: AGENDA_DAYS_QUERY },
    { staleTime: AGENDA_STALE_MS },
  );

  const today = todayISO(tz);
  const days: AgendaDay[] = Array.from({ length: AGENDA_DAYS }, (_, i) => ({
    date: addDays(today, i),
    entities: [],
  }));
  const byDate = new Map(days.map((d) => [d.date, d]));

  for (const e of q.data ?? []) {
    if (isRecurringTemplate(e)) continue;
    const start = startAt(e);
    const day = start === null ? null : localDay(start, tz);
    if (day === null) continue;
    // Вне окна (сервер отдал лишнее / расхождение таймзоны на границе суток) — молча мимо
    byDate.get(day)?.entities.push(e);
  }
  for (const d of days) {
    d.entities.sort((a, b) => Number(isAllDay(b)) - Number(isAllDay(a)));
  }

  // Настройки — часть раскладки, а не украшение: без timezone дни считались бы в зоне
  // браузера и строки у полуночи перескакивали бы в соседнюю секцию после её прихода.
  return { days, timezone: tz, isLoading: q.isLoading || settings.isLoading, isError: q.isError };
}

/** Элемент «Просроченного»: сущность + релевантная дата (более ранняя из двух, §4.2). */
export type OverdueItem = { entity: AgendaEntity; date: string };

/**
 * Секция «Просроченное» (§4.2) — ОБЩИЙ хук вкладки Agenda и её бейджа (§1.5, Task D2):
 * оба читают один кэш TanStack Query, локального состояния нет.
 *
 * Слияние двух выборок по id сущности: один элемент на сущность, релевантная дата —
 * более ранняя из `due_date` и локального дня `start_at`. Сортировка — старейшие сверху.
 * `truncated` (упор в OVERDUE_LIMIT) отражается в `countLabel` как «200+».
 */
export function useAgendaOverdue(): {
  items: OverdueItem[];
  count: number;
  countLabel: string;
  truncated: boolean;
  isLoading: boolean;
  isError: boolean;
} {
  const settings = trpc.user.getSettings.useQuery();
  const tz = settings.data?.timezone;
  const byDue = trpc.entity.query.useQuery(
    { query: AGENDA_OVERDUE_DUE_QUERY },
    { staleTime: AGENDA_STALE_MS },
  );
  const byStart = trpc.entity.query.useQuery(
    { query: AGENDA_OVERDUE_START_QUERY },
    { staleTime: AGENDA_STALE_MS },
  );

  const merged = new Map<string, OverdueItem>();
  const add = (entity: AgendaEntity, date: string) => {
    const prev = merged.get(entity.id);
    if (prev === undefined || date < prev.date) merged.set(entity.id, { entity, date });
  };
  for (const e of byDue.data ?? []) {
    if (isRecurringTemplate(e)) continue;
    const due = dueDate(e);
    if (due !== null) add(e, due);
  }
  for (const e of byStart.data ?? []) {
    if (isRecurringTemplate(e)) continue;
    const start = startAt(e);
    const day = start === null ? null : localDay(start, tz);
    if (day !== null) add(e, day);
  }

  const items = [...merged.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const truncated =
    (byDue.data?.length ?? 0) >= OVERDUE_LIMIT || (byStart.data?.length ?? 0) >= OVERDUE_LIMIT;

  return {
    items,
    count: items.length,
    countLabel: truncated ? `${items.length}+` : String(items.length),
    truncated,
    // Настройки входят в загрузку по той же причине, что в useAgendaDays: релевантная
    // дата scheduled-строки — локальный день start_at, до timezone он неверен.
    isLoading: byDue.isLoading || byStart.isLoading || settings.isLoading,
    isError: byDue.isError || byStart.isError,
  };
}
