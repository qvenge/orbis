// apps/server/src/query/context.ts
// CompileContext запроса (§6.1) — общий хелпер роутера entity (tRPC) и диспатча
// тулов LLM/MCP (tools/dispatch.ts): каталог — из реестра на запрос (решение Task 8 1a);
// timezone — из user_settings владельца (RLS скоупит выборку), без строки
// (онбординг-сидирование — Task 13 1a) — дефолт 'Europe/Moscow'; today — «сегодня»
// в этой таймзоне (en-CA даёт ровно YYYY-MM-DD). Вызывается ТОЛЬКО под withIdentity.
import { eq } from 'drizzle-orm';
import { userSettings } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { type CompileContext, loadCatalog } from './compile';

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

/**
 * Таймзона владельца из user_settings — под ЕГО identity (RLS скоупит выборку). Без строки
 * (онбординг не пройден) — дефолт. Валидация зоны стоит на входе (routers/user.ts), но
 * строка может прийти из БД мимо него (старая запись, админ-скрипт): RangeError означал бы
 * 500 на КАЖДОМ чтении графа (а у планировщика — сломанный тик по всем рутинам владельца),
 * поэтому мусор деградирует до дефолта, а не роняет вызывающего.
 */
export async function ownerTimeZone(tx: Tx, ownerId: string): Promise<string> {
  const rows = await tx
    .select({ timezone: userSettings.timezone })
    .from(userSettings)
    .where(eq(userSettings.ownerId, ownerId));
  const stored = rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  return isValidTimeZone(stored) ? stored : DEFAULT_TIMEZONE;
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

export async function queryContext(
  tx: Tx,
  actorUserId: string,
  thisEntityId: string | null,
): Promise<CompileContext> {
  const catalog = await loadCatalog(tx);
  const timezone = await ownerTimeZone(tx, actorUserId);
  return { catalog, thisEntityId, today: todayInTimeZone(timezone), timezone };
}
