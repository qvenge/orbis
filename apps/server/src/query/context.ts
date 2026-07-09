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

export async function queryContext(
  tx: Tx,
  actorUserId: string,
  thisEntityId: string | null,
): Promise<CompileContext> {
  const catalog = await loadCatalog(tx);
  const rows = await tx
    .select({ timezone: userSettings.timezone })
    .from(userSettings)
    .where(eq(userSettings.ownerId, actorUserId));
  const stored = rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  // Валидация зоны стоит на входе (routers/user.ts), но строка может прийти из БД
  // мимо него (старая запись, админ-скрипт): RangeError здесь означал бы 500 на КАЖДОМ
  // чтении графа, поэтому мусор деградирует до дефолта, а не роняет запрос.
  const timezone = isValidTimeZone(stored) ? stored : DEFAULT_TIMEZONE;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  return { catalog, thisEntityId, today, timezone };
}
