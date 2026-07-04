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
  const timezone = rows[0]?.timezone ?? 'Europe/Moscow';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  return { catalog, thisEntityId, today, timezone };
}
