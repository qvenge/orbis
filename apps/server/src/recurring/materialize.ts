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
  addDays,
  expandRecurrence,
  materializeBatchId,
  type RecurrenceRule,
  ROLE_INSTANCE_OF,
  recurringInstanceId,
} from '@orbis/shared';
import type {
  QueryAst,
  QueryBound,
  QueryDateToken,
  QueryFilterNode,
  QueryRangeValue,
} from '@orbis/shared/query';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { entities, userSettings } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { DEFAULT_TIMEZONE, isValidTimeZone } from '../query/context';

/** Горизонт материализации: не дальше 14 дней вперёд от сегодня (§5.4). */
const HORIZON_DAYS = 14;

/**
 * Ретро-пол материализации: не глубже 92 дней (квартал) назад от сегодня.
 * Абсолютные диапазоны дат в грамматике (B5) сделали выразимым окно «2020..today» —
 * без пола такой запрос синхронно материализовал бы годы инстансов, а post-due
 * следом переписал бы spent исторических месяцев. Квартал покрывает легитимный
 * кейс «не открывал приложение месяц». Кап — решение контролёра B5,
 * sign-off владельца — на финале фазы B.
 */
const RETRO_DAYS = 92;

/** Формат даты окна/фильтра — только структура; арифметика живёт в @orbis/shared addDays. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Свойства-триггеры хука (§А5-2: в дереве лежат id, не имена полей). Три, а не два:
 * `orbis/due_date` добавлен Задачей 9b — списки «Сегодня», «Ближайшие 7 дней» и «Позже»
 * отбирают recurring-задачи именно по сроку, и без него материализация под них не
 * запускалась вовсе (окно давал только соседний `start_at`, которого у задачи может не
 * быть). Список — константа кода: это свойство ИСПОЛНЕНИЯ (что мы умеем порождать лениво),
 * а не свойство запроса.
 */
const MATERIALIZABLE_PROPERTIES = new Set([
  'orbis/start_at',
  'orbis/due_date',
  'orbis/occurred_on',
]);

/** Попыток на шаблон при гонке конкурентных материализаций пересекающихся окон. */
const MAX_ATTEMPTS = 3;

// Один инстанс синка на модуль (как в routers/entity.ts): состояния не хранит,
// audit-сообщение batch пишется тем же tx, что операции executor'а (§7.8).
const sink = makeChatJournalSink();

type TemplateRow = typeof entities.$inferSelect;

/**
 * ЯВНЫЙ перечень наследуемых инстансом свойств РАСПИСАНИЯ (Р-28) — весь аспект
 * `orbis/schedule` без `orbis/recurrence`: правило повторения принадлежит шаблону, и
 * инстанс, унёсший его с собой, сам стал бы шаблоном (§3.3).
 *
 * Перечень, а не «всё, что было минус одно», потому что в новой форме «всё, что было» —
 * это ВСЕ `props` строки: у шаблона-задачи там лежат `orbis/task_status` и `orbis/priority`,
 * у шаблона-транзакции — `orbis/bank_txn_id`. Копирование по остаточному принципу молча
 * порождало бы инстансы с чужими свойствами; закрытый список делает наследование решением.
 *
 * `orbis/start_at` и `orbis/end_at` в перечне ЕСТЬ, но копируются не как есть: их
 * пересчитывает `instanceScheduleProps` — дата инстанса со временем суток шаблона.
 */
const INHERITED_SCHEDULE_PROPERTIES: readonly string[] = [
  'orbis/start_at',
  'orbis/end_at',
  'orbis/duration_min',
  'orbis/all_day',
  'orbis/location',
  'orbis/timezone',
];

/**
 * ЯВНЫЙ перечень наследуемых инстансом свойств ФИНАНСОВ (Р-28). Шесть, а не десять:
 *  • `orbis/occurred_on`, `orbis/planned`, `orbis/recurring` инстанс получает СВОИ
 *    (дата инстанса, `true`, `true` — §5.4/§3.3), а не шаблонные;
 *  • `orbis/bank_txn_id` не наследуется вовсе: это тождество ОДНОЙ строки банковской
 *    выписки, и общий идентификатор у всех инстансов объявил бы их одной операцией —
 *    дедуп импорта (§3.4.1 п.3) считал бы повтором каждую.
 */
const INHERITED_FINANCIAL_PROPERTIES: readonly string[] = [
  'orbis/amount',
  'orbis/currency',
  'orbis/direction',
  'orbis/finance_category',
  'orbis/payment_method',
  'orbis/counterparty',
];

const SCHEDULE_ASPECT = 'orbis/schedule';
const FINANCIAL_ASPECT = 'orbis/financial';

// Стеночные часы владельца — экспортированы: планировщик рутин (routines/schedule.ts)
// считает бакеты 'YYYY-MM-DDTЧЧ:ММ' в таймзоне владельца теми же двумя функциями, что
// материализация — свой перевод «локальное время → instant» разошёлся бы с этим на первом
// же переходе DST.
export interface WallClock {
  date: string; // 'YYYY-MM-DD' — локальная дата instant'а в таймзоне
  time: { h: number; m: number; s: number }; // локальное время суток
}

/** Локальные дата и время instant'а в IANA-таймзоне (hourCycle h23: полночь — 00, не 24). */
export function wallClockIn(instant: Date, timeZone: string): WallClock {
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
export function instantOfLocal(dateISO: string, time: WallClock['time'], timeZone: string): Date {
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
 * Окно материализации из Q-AST запроса (§5.4: любой запрос диапазона дат материализует
 * видимый диапазон). Чистая прогулка по ДЕРЕВУ фильтра без обращений к БД — запросы без
 * условий по датам не платят ничего.
 *
 * ЧТО ЗНАЧИТ «ПО ДЕРЕВУ» И ПОЧЕМУ ИМЕННО ТАК. Окно — это ВЕРХНЯЯ ОЦЕНКА того, что запрос
 * способен показать, поэтому ветки `and` и `or` дают в него одинаковый вклад: у `or`
 * показаться может любая из них, а у `and` лишнее окно стоит нескольких лишних инстансов,
 * которых никто не увидит, — но пропущенное окно стоит пустого списка у владельца.
 * Поддерево под `not` окно НЕ СУЖАЕТ и вклада не даёт: «срок не сегодня» не обещает, что
 * сегодняшних инстансов в выдаче не будет, — они просто отберутся другим условием.
 *
 * Правила по узлам: относительный токен разворачивается в свой диапазон (`overdue` и
 * прочий «открытый низ» — только сегодня и будущее: прошлое лениво не порождаем),
 * литеральная 'YYYY-MM-DD' — окно этого дня, `range` — [from; to] с подстановкой открытой
 * границы (низ — сегодня, верх — горизонт +14д), `gt`/`lt` — от следующего дня и до дня
 * перед. Несколько условий объединяются в [min from; max to]; горизонт +14д и ретро-пол
 * −92д (RETRO_DAYS) обрезает `materializeInstances` — окно здесь не клампится.
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ПЛОСКОГО ОБХОДА, который был до Задачи 9b, — двумя местами, и оба
 * РАСШИРЯЮТ окно, а не сужают (то есть могут породить лишние инстансы, но не спрятать
 * нужные): старый брал `range` только когда ОБЕ границы литеральные даты, новый
 * подставляет открытую; старый игнорировал токен в `>`/`<`, новый переводит его в якорь.
 * Расширение намеренное: канон выражает `<=`/`>=` односторонним `range`, и «пропустить»
 * такое условие значило бы отдать владельцу пустой список там, где он ждёт инстансы.
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
  const horizon = () => addDays(today, HORIZON_DAYS);

  /** Диапазон, который токен задаёт САМ ПО СЕБЕ (позиция равенства). */
  const tokenWindow = (token: QueryDateToken): { from: string; to: string } => {
    switch (token) {
      case 'today':
      case 'overdue': // открытый низ: материализуем только сегодня и будущее
        return { from: today, to: today };
      case 'next_7d':
        return { from: today, to: addDays(today, 7) };
      case 'after_7d':
        return { from: addDays(today, 8), to: horizon() };
    }
  };

  /** День, ВОКРУГ которого токен определён, — когда он стоит границей диапазона. */
  const tokenAnchor = (token: QueryDateToken): string =>
    token === 'next_7d' || token === 'after_7d' ? addDays(today, 7) : today;

  /** Календарный день границы: литерал 'YYYY-MM-DD', токен — его якорь; иначе null. */
  const boundDay = (bound: QueryBound | undefined): string | null => {
    if (bound === undefined) return null;
    if (typeof bound === 'object') return tokenAnchor(bound.token);
    return typeof bound === 'string' && DATE_RE.test(bound) ? bound : null;
  };

  const visitProp = (node: { prop: string; op: string; value: unknown }): void => {
    if (!MATERIALIZABLE_PROPERTIES.has(node.prop)) return;
    const value = node.value;
    switch (node.op) {
      case 'eq': {
        if (typeof value === 'object' && value !== null && 'token' in value) {
          const w = tokenWindow((value as { token: QueryDateToken }).token);
          widen(w.from, w.to);
          return;
        }
        const day = boundDay(value as QueryBound);
        if (day !== null) widen(day, day);
        return;
      }
      case 'in': {
        for (const v of value as unknown[]) {
          const day = boundDay(v as QueryBound);
          if (day !== null) widen(day, day);
        }
        return;
      }
      case 'gt': {
        // Строго после X; верх не ограничен → горизонт +14д от сегодня.
        const day = boundDay(value as QueryBound);
        if (day !== null) widen(addDays(day, 1), horizon());
        return;
      }
      case 'lt': {
        // Строго до X — открытый низ: материализуем только сегодня и будущее (как overdue).
        const day = boundDay(value as QueryBound);
        if (day !== null) widen(today, addDays(day, -1));
        return;
      }
      case 'range': {
        const range = value as QueryRangeValue;
        const lo = boundDay(range.from);
        const hi = boundDay(range.to);
        if (lo === null && hi === null) return;
        // Открытая граница берётся оттуда же, откуда её брали сравнения: низ — сегодня,
        // верх — горизонт. `range` несёт и `<=`/`>=` — у канона своих операторов для них нет.
        widen(lo ?? today, hi ?? horizon());
        return;
      }
      // `ne` и `contains` диапазона не задают: «не эта дата» — это не интервал.
      default:
        return;
    }
  };

  const visit = (node: QueryFilterNode): void => {
    if ('not' in node) return; // отрицание окно не сужает — см. докблок
    if ('and' in node) {
      for (const child of node.and) visit(child);
      return;
    }
    if ('or' in node) {
      for (const child of node.or) visit(child);
      return;
    }
    if ('prop' in node) visitProp(node);
  };

  if (ast.filter !== null) visit(ast.filter);
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
  const { db, ownerId, today } = deps;
  if (!DATE_RE.test(deps.from) || !DATE_RE.test(deps.to)) {
    throw new RangeError(`Некорректное окно материализации: [${deps.from}; ${deps.to}]`);
  }
  // Окно = [from; to] ∩ [today−92д; today+14д]: верх — горизонт §5.4, низ — ретро-пол
  // (см. RETRO_DAYS; кламп здесь — единая точка для всех вызывающих, включая budget-роутер)
  const horizon = addDays(today, HORIZON_DAYS);
  const retroFloor = addDays(today, -RETRO_DAYS);
  const to = deps.to < horizon ? deps.to : horizon;
  const from = deps.from > retroFloor ? deps.from : retroFloor;
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
          // Признак носителя обязателен (Р9): `orbis/recurrence` остаётся в `props` и
          // после снятия аспекта расписания, а из старой карты уходил вместе с ним.
          // Без него сущность, расписания лишившаяся, продолжала бы плодить инстансы.
          sql`${SCHEDULE_ASPECT} = ANY(${entities.aspects})`,
          sql`${entities.props} -> 'orbis/recurrence' IS NOT NULL`,
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
  // Признак носителя здесь не повторяется: строки отобрал SELECT выше, где
  // `'orbis/schedule' = ANY(aspects)` уже стоит, — вторая проверка была бы тавтологией.
  const props = template.props as Record<string, unknown>;
  const startAt = props['orbis/start_at'];
  if (typeof startAt !== 'string') return 0;

  // Таймзона дат инстансов: orbis/timezone шаблона, фолбэк — таймзона
  // пользователя (§5.4); мусорная зона деградирует до фолбэка, не роняя запрос
  const tzProp = props['orbis/timezone'];
  const tzRaw = typeof tzProp === 'string' ? tzProp : undefined;
  const timezone = tzRaw !== undefined && isValidTimeZone(tzRaw) ? tzRaw : userTimezone;
  const startInstant = new Date(startAt);
  if (Number.isNaN(startInstant.getTime())) return 0;
  // seriesStart = локальная дата start_at шаблона в этой таймзоне; time — время суток
  const wall = wallClockIn(startInstant, timezone);

  let dates: string[];
  try {
    dates = expandRecurrence(props['orbis/recurrence'] as RecurrenceRule, wall.date, from, to);
  } catch (e) {
    // Битое правило (RangeError, fail-fast A2): пропускаем ШАБЛОН, а не роняем весь
    // запрос вызывающего — остальные шаблоны материализуются (закреплено тестом).
    // warn с id — иначе «вечно нематериализуемый» шаблон недиагностируем (fix round A3)
    if (e instanceof RangeError) {
      console.warn(
        `[recurring/materialize] шаблон ${template.id} пропущен: битое recurrence-правило — ${e.message}`,
      );
      return 0;
    }
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
    const operations = missing.flatMap((date) => instanceOps(template, timezone, wall, date));
    const r = await execute(
      db,
      {
        actorUserId: ownerId,
        actorKind: 'owner',
        source: 'system',
        // Механизм — материализация (§А4-4): экземпляры повторяющегося рождает сервер
        mechanism: 'materialize',
        operations,
        batchId,
      },
      { sink },
    );
    if (r.ok) return r.idempotentReplay ? 0 : missing.length;
    // Гонка: конкурент с ДРУГИМ окном вставил тот же детерминированный id между нашим
    // SELECT и INSERT → executor вернул CONFLICT (id_conflict, batch откачен целиком).
    // Перечитываем и повторяем без уже созданного. Тот же batch_id конкурента ловится
    // выше по audit-PK как replay, сюда не доходит.
    if (r.error.code === 'CONFLICT') continue;
    // Прочие структурированные отказы (INVARIANT битых данных, LIMIT): шаблон
    // пропускается — материализация не имеет права ронять запрос пользователя;
    // warn с id и кодом — для диагностики «вечно нематериализуемого» шаблона
    console.warn(
      `[recurring/materialize] шаблон ${template.id} пропущен: отказ executor ${r.error.code} — ${r.error.message}`,
    );
    return 0;
  }
  return 0;
}

/**
 * Свойства расписания инстанса: перечень Р-28 из свойств шаблона, где `orbis/start_at` —
 * дата инстанса со временем суток шаблона (в его таймзоне), а `orbis/end_at` сдвинут той
 * же длительностью. `orbis/recurrence` в перечень не входит и потому не переносится.
 */
function instanceScheduleProps(
  props: Record<string, unknown>,
  start: Date,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const propertyId of INHERITED_SCHEDULE_PROPERTIES) {
    if (Object.hasOwn(props, propertyId)) out[propertyId] = props[propertyId];
  }
  out['orbis/start_at'] = start.toISOString();
  const endAt = props['orbis/end_at'];
  if (typeof endAt === 'string') {
    const templStart = new Date(props['orbis/start_at'] as string).getTime();
    const templEnd = new Date(endAt).getTime();
    if (Number.isNaN(templEnd)) delete out['orbis/end_at'];
    else out['orbis/end_at'] = new Date(start.getTime() + (templEnd - templStart)).toISOString();
  } else {
    // Нестроковый конец интервала инстанс не наследует: старая форма клала его в аспект
    // только вместе с пересчётом, а без пересчёта он означал бы конец ШАБЛОНА.
    delete out['orbis/end_at'];
  }
  return out;
}

/** Пара операций batch для одной даты: entity_create инстанса + derived_from шаблон→инстанс. */
function instanceOps(
  template: TemplateRow,
  timezone: string,
  wall: WallClock,
  date: string,
): Array<{ tool: string; input: unknown }> {
  const id = recurringInstanceId(template.id, date);
  const start = instantOfLocal(date, wall.time, timezone);
  const templateProps = template.props as Record<string, unknown>;

  const props: Record<string, unknown> = instanceScheduleProps(templateProps, start);
  const aspects: string[] = [SCHEDULE_ASPECT];
  if (template.aspects.includes(FINANCIAL_ASPECT)) {
    for (const propertyId of INHERITED_FINANCIAL_PROPERTIES) {
      if (Object.hasOwn(templateProps, propertyId)) props[propertyId] = templateProps[propertyId];
    }
    // §5.4/§3.3: occurred_on = дата инстанса, planned=true (до перехода в факт),
    // recurring=true (инстанс шаблона); к конверту инстанс авто-привязывается бюджет-
    // хуком executor'а уже при создании (A4, 03-budget §2.3) — planned не входит в spent
    props['orbis/occurred_on'] = date;
    props['orbis/planned'] = true;
    props['orbis/recurring'] = true;
    aspects.push(FINANCIAL_ASPECT);
  }

  // Внутренняя форма создания (§А1-1): плоские `props` плюс СПИСОК аспектов.
  const input: Record<string, unknown> = {
    id,
    title: template.title,
    tags: template.tags,
    props,
    aspects,
  };
  if (template.emoji !== null) input.emoji = template.emoji;

  return [
    { tool: 'entity_create', input },
    {
      // РП-5: направление как у прежнего `derived_from` — источник ШАБЛОН, цель экземпляр
      tool: 'relation_create',
      input: { source_id: template.id, target_id: id, role: ROLE_INSTANCE_OF },
    },
  ];
}
