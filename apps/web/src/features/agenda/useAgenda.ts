// Хуки Повестки (02-core-os §4, Task D1). Сервер отдаёт ОДИН плоский список с тегом секции
// (§А5-5): отбор строк, скрытие шаблонов повторения и слияние «Просроченного» по двум датам
// уехали в движок подписки (§Б5-6), окно материализации он расширяет сам.
//
// Клиентским осталось ровно то, чего нет в контракте: раскладка по дням, порядок внутри дня
// и подписи (Р-И-18). Границы дня сервер считает в таймзоне ВЛАДЕЛЬЦА и присылает её же
// ответом — клиент группирует ТОЙ ЖЕ зоной, иначе строки у полуночи уехали бы в соседнюю
// секцию. Дата-арифметика — addDays из @orbis/shared, «сегодня» — поле ответа.
import { type AgendaRow, addDays } from '@orbis/shared';
import { type RouterOutputs, trpc } from '../../trpc';
import { todayISO } from '../budget/useBudget';

export type AgendaEntity = RouterOutputs['entity']['query'][number];

/** §4.1: горизонт «Сегодня → +7 дней» — ровно 8 секций; пустые не скрываются. */
export const AGENDA_DAYS = 8;

// Бейдж вкладки Agenda (§1.5, Task D2) смонтирован на ЛЮБОМ экране и делит кэш с этим
// хуком. Без явного staleTime каждый маунт бейджа бил бы в сервер; 60 с — потолок K16.
//
// Этот staleTime корректен ТОЛЬКО потому, что каждый пишущий путь инвалидирует повестку
// явно (`invalidateGraph`): detail-экран (useEntityDetail.useEntityUpdate — закрытие задачи,
// перенос даты, архивация: приёмка §8.2), QuickCapture, QuickAddBar, fast-path чата, импорт.
// refetchOnWindowFocus в trpc.ts выключен — само по себе ничто не протухнет.
// Заводя новый путь записи в граф, инвалидируй agenda.list, иначе строка провисит минуту.
const AGENDA_STALE_MS = 60_000;

/**
 * Значения — плоско в `props` по id свойства (§А1-1): те же адреса, что в текстах запросов
 * выше (`orbis/start_at`, `orbis/due_date`). Прежде запрос спрашивал одним именем, а клиент
 * читал ответ другим («аспект + поле»), и переименование поля рвало ровно одну из двух
 * половин — молча.
 */
function stringProp(e: AgendaEntity, propertyId: string): string | null {
  const v = e.props[propertyId];
  return typeof v === 'string' ? v : null;
}

export const endAt = (e: AgendaEntity) => stringProp(e, 'orbis/end_at');

/**
 * Шаблон повторения — сущность с заданным `orbis/recurrence`. ПОВЕСТКЕ БОЛЬШЕ НЕ НУЖЕН: там
 * шаблоны прячет набор `templates` контракта повторения, объявленный подпиской (§Б5-6), а не
 * второй фильтр на клиенте.
 *
 * Функция жива ради двух читателей вне Повестки — `budget/CategoryScreen.tsx` и
 * `budget/TransactionsScreen.tsx`: своей подписки у Финансов в Б-1 ещё нет, и до неё они
 * фильтруют шаблоны сами (Б-2).
 */
export function isRecurringTemplate(e: AgendaEntity): boolean {
  return e.props['orbis/recurrence'] !== undefined;
}

function intl(tz: string | undefined, opts: Intl.DateTimeFormatOptions, locale: string) {
  return new Intl.DateTimeFormat(locale, { ...(tz ? { timeZone: tz } : {}), ...opts });
}

const DAY_OPTS = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;

/**
 * Локальный день 'YYYY-MM-DD' значения слота в таймзоне пользователя; битый вход → null.
 *
 * Date-значение возвращается КАК ЕСТЬ — зеркало серверного `localDay` (`subscriptions/agenda.ts`).
 * Слот `moment` объявлен `any_of[timestamp, date]` (§Б1-2), и у date-значения дня уже нет часов:
 * `new Date('2026-09-08')` — полночь UTC, то есть в любой зоне западнее Гринвича «вчера», и дело,
 * назначенное на сегодня, молча исчезало бы с Повестки.
 */
export function localDay(iso: string, tz?: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
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

export type AgendaDay = { date: string; rows: AgendaRow[] };
/** Одна выборка на обе секции — её делят вкладка и бейдж (§1.5), как раньше делили три. */
const useAgendaList = () =>
  trpc.agenda.list.useQuery({ days: AGENDA_DAYS }, { staleTime: AGENDA_STALE_MS });

/**
 * Дневные секции §4.1: 8 дней от «сегодня», строки окна разложены по локальному дню своего
 * момента. Внутри дня all_day идут первыми, дальше сохраняется порядок сервера (`sortBy`
 * подписки — Array#sort стабилен). Шаблоны повторения отбирает сервер (§Б5-6).
 */
export function useAgendaDays(): {
  days: AgendaDay[];
  timezone: string | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const q = useAgendaList();
  // «Сегодня» и таймзона приезжают ОТВЕТОМ: сервер уже посчитал их, отбирая строки, и второй
  // счёт на клиенте разъезжался бы с ним на границе суток.
  const tz = q.data?.timezone;
  const today = q.data?.today ?? todayISO(tz);
  const days: AgendaDay[] = Array.from({ length: AGENDA_DAYS }, (_, i) => ({
    date: addDays(today, i),
    rows: [],
  }));
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const r of q.data?.rows ?? []) {
    if (r.section !== 'window') continue;
    const day = localDay(r.at, tz);
    // Вне окна (расхождение таймзоны на границе суток) — молча мимо, как и раньше
    if (day !== null) byDate.get(day)?.rows.push(r);
  }
  for (const d of days) d.rows.sort((a, b) => Number(b.allDay) - Number(a.allDay));
  return { days, timezone: tz, isLoading: q.isLoading, isError: q.isError };
}

/**
 * Секция «Просроченное» (§4.2) — ОБЩИЙ хук вкладки Повестки и её бейджа (§1.5, Task D2):
 * оба читают один кэш TanStack Query, локального состояния нет.
 */
export function useAgendaOverdue(): {
  items: AgendaRow[];
  countLabel: string;
  /**
   * Подпись бейджа вкладки (§1.5) или `null`, если бейджа быть не должно. Отдельное
   * поле, а не `count > 0` у потребителей: при отказе выборки бейдж скрывается целиком —
   * «3» вместо семи читается как «всё под контролем», а сигнала неполноты в бейдже нет
   * (прецедент Budget: ошибка alertCount → бейджа нет, useBudget.ts). Плашка неполноты
   * остаётся на самой вкладке, где она видна явно.
   */
  badgeLabel: string | null;
  isLoading: boolean;
  isError: boolean;
} {
  const q = useAgendaList();
  // Слияние двух выборок по id и выбор более ранней даты уехали на сервер (§Б5-6): здесь
  // остаётся ровно порядок — старейшие сверху.
  const items = [...(q.data?.rows ?? [])]
    .filter((r) => r.section === 'overdue')
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const countLabel = q.data?.truncated.overdue === true ? `${items.length}+` : String(items.length);
  return {
    items,
    countLabel,
    badgeLabel: q.isError || items.length === 0 ? null : countLabel,
    isLoading: q.isLoading,
    isError: q.isError,
  };
}
