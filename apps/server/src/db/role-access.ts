// Факт роли отличает пустой корпус от корпуса, невидимого под FORCE RLS.
import { sql } from 'drizzle-orm';
import type { Db } from './client';
/** Принимает и Db, и транзакцию: SET LOCAL ROLE проверяется без отдельного соединения. */
export type RoleAccessExecutor = Pick<Db, 'execute'>;
/** Под кем команда пришла в базу и видит ли она строки вообще. */
export type RoleAccess = { role: string; bypassRls: boolean };
/**
 * На entities включён FORCE ROW LEVEL SECURITY с политикой current_graph_select (0021).
 * Прямое подключение не выставляет граф и актора: роль с грантами без BYPASSRLS видит ноль строк
 * без ошибки. Поэтому нули отчёта не означают «корпус пуст» — нужен факт роли.
 */
export async function describeRoleAccess(db: RoleAccessExecutor): Promise<RoleAccess> {
  const rows = await db.execute(sql`SELECT current_user::text AS role,
      coalesce((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypass_rls`);
  const row = rows[0] as { role: string; bypass_rls: boolean };
  return { role: row.role, bypassRls: row.bypass_rls };
}
