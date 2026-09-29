// apps/server/src/query/context.ts
// CompileCtx запроса (§А5-7) — общий хелпер роутера entity (tRPC) и диспатча тулов
// LLM/MCP (tools/dispatch.ts): снимок реестров — на запрос (§А10-1, из процессного кеша по
// `(владелец, его версия, системная)` — `registry/cache.ts`); timezone и валюта — из user_settings
// владельца одной выборкой (RLS скоупит её), без строки (онбординг-сидирование — Task 13 1a) —
// дефолты 'Europe/Moscow' и 'RUB';
// today — «сегодня» в этой таймзоне (en-CA даёт ровно YYYY-MM-DD). Вызывается ТОЛЬКО
// под withIdentity.
//
// Что здесь изменила Задача 9b: контекст больше не носит каталог полей старой грамматики
// (`FieldCatalog` собирался из колонки `aspect_definitions.schema`), а носит СНИМОК
// РЕЕСТРА — из него компилятор берёт тип свойства, служебность аспекта и семейство ролей,
// и из него же разбирает текст запроса `query/parse-text.ts`. Один снимок на запрос, а не
// два чтения: реестр читается пятью запросами, и второй его загрузкой ради разбора текста
// платил бы каждый вызов entity.query.
import type { GraphId } from '@orbis/shared';
import type { WeekStart } from '@orbis/shared/query';
import { eq } from 'drizzle-orm';
import { userSettings } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { effectiveRegistry } from '../registry/cache';
import type { CompileCtx } from './compile-ast';

/** Дефолт таймзоны при отсутствующей строке настроек (онбординг ещё не пройден). */
export const DEFAULT_TIMEZONE = 'Europe/Moscow';

/** Принимает ли Intl эту зону как IANA-идентификатор (иначе конструктор бросает RangeError). */
export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Валюта владельца при отсутствующей строке настроек — умолчание схемы `user_settings.defaultCurrency`. */
export const DEFAULT_CURRENCY = 'RUB';

/** Настройки владельца, которые читает КАЖДЫЙ сборщик контекста компиляции. */
export interface OwnerQuerySettings {
  timeZone: string;
  currency: string;
}

/**
 * Пояс и валюта владельца из user_settings — ОДНОЙ выборкой, под ЕГО identity (RLS скоупит её).
 * Без строки (онбординг не пройден) — умолчания. Валидация зоны стоит на входе (routers/user.ts), но
 * строка может прийти из БД мимо него (старая запись, админ-скрипт): RangeError означал бы 500 на
 * КАЖДОМ чтении графа (а у планировщика — сломанный тик по всем рутинам владельца), поэтому мусор
 * деградирует до дефолта, а не роняет вызывающего.
 *
 * Одна функция на все сборщики контекста (`queryContext`, `executor.ts` `compileCtxOf`,
 * `actions/resolve.ts`, `subscriptions/budget.ts`) и на чтение валюты Бюджетом (`defaultCurrencyOf`):
 * валюта владельца — правило контракта «движения денег» (спека 1в §3.6), и второе чтение с другим
 * умолчанием разошлось бы с плиткой суммы на первом же графе без строки настроек.
 */
export async function ownerQuerySettings(tx: Tx, graph: GraphId): Promise<OwnerQuerySettings> {
  const rows = await tx
    .select({ timezone: userSettings.timezone, currency: userSettings.defaultCurrency })
    .from(userSettings)
    .where(eq(userSettings.graphId, graph));
  const stored = rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  return {
    timeZone: isValidTimeZone(stored) ? stored : DEFAULT_TIMEZONE,
    currency: rows[0]?.currency ?? DEFAULT_CURRENCY,
  };
}

/** Таймзона владельца — см. `ownerQuerySettings` (там же правило умолчания и мусора). */
export async function ownerTimeZone(tx: Tx, graph: GraphId): Promise<string> {
  return (await ownerQuerySettings(tx, graph)).timeZone;
}

/** Валюта владельца — см. `ownerQuerySettings`. */
export async function ownerCurrency(tx: Tx, graph: GraphId): Promise<string> {
  return (await ownerQuerySettings(tx, graph)).currency;
}

/**
 * «Сегодня» в указанной зоне, YYYY-MM-DD (en-CA даёт ровно этот вид).
 *
 * Отдельной функцией, а не строкой внутри queryContext: ту же дату кладут в системный
 * канал LLM оба сборщика (llm/context.ts, routines/context.ts, §Б7-6-1). Пересчитанная
 * на месте формула разъехалась бы с той, по которой резолвятся date-токены грамматики
 * (today/overdue) — модель видела бы одно «сегодня», а её же запрос считался бы от другого.
 */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}

/**
 * Начало недели для токена `this_week` — КОНСТАНТА «понедельник» по букве спеки 1в §3.4 («начало
 * недели — понедельник, константа 1в»). Настройка владельца `weekStartDay` (`monday|sunday`, «Общие»)
 * уже существует (Д-18), и читать ли её здесь — вопрос владельцу В-1. До ответа владелец с
 * «воскресеньем» видит `this_week` с понедельника.
 *
 * Цена ответа «да» — не одна строка: константу читают ЧЕТЫРЕ сборщика контекста (`queryContext`
 * ниже, `executor.ts` `compileCtxOf`, `actions/resolve.ts` `queryTargets`, `subscriptions/budget.ts`
 * `runLedgers`). Все четыре уже читают настройки владельца одной выборкой `ownerQuerySettings` (пояс,
 * валюта; резолв действия — через `actionDateArgs`, `actions/precondition.ts`), поэтому ответ «да» —
 * поле `weekStartDay` в этой выборке (и в `ActionDateArgs`) и неделя из настроек вместо константы у
 * тех же четырёх; окно материализации и разбор берут неделю из контекста.
 */
export const WEEK_START: WeekStart = 'monday';

/**
 * `now` — часы вызывающего (по умолчанию — настоящие): «сегодня» считается от них в поясе владельца.
 * Параметр — ради пачки блоков (`runBlocks`), чьи группы по дням сверяются тестом на фиксированном
 * «сегодня» мира; так же часы передаёт сборщик канала LLM (`buildContext`, `clock`).
 */
export async function queryContext(
  tx: Tx,
  graph: GraphId,
  thisEntityId: string | null,
  now: Date = new Date(),
): Promise<CompileCtx> {
  const reg = await effectiveRegistry(tx, graph);
  const settings = await ownerQuerySettings(tx, graph);
  return {
    graphId: graph,
    reg,
    thisEntityId,
    today: todayInTimeZone(settings.timeZone, now),
    timeZone: settings.timeZone,
    weekStart: WEEK_START,
    ownerCurrency: settings.currency,
  };
}
