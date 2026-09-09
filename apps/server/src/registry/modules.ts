// apps/server/src/registry/modules.ts
// Маска включённости модулей владельца (§Б8-1/§Б8-3) — чтение и идемпотентная запись колонки
// `user_settings.disabled_modules` (заведена миграцией 0018).
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';

/**
 * Маска включённости (§Б8-3) — ОТДЕЛЬНО от снимка реестра и намеренно. Тем же снимком
 * (`effectiveRegistry`, `registry/cache.ts`) резолвятся СОХРАНЁННЫЕ AST на чтении
 * (`queryContext`, `query/context.ts`), а §Б8-3
 * требует: определения выключенного модуля остаются резолвимыми. Второй довод —
 * `user.updateSettings` (`routers/user.ts`) не двигает `registry_version`, и маска
 * внутри снимка застревала бы в процессном кеше.
 *
 * Следствие, названное вслух: кэш `spent` (`budget/spent-cache.ts`) при переключении модуля
 * НЕ инвалидируется — маска в ключ кеша не входит по построению, а выключенный модуль просто
 * не читает ведомость. Включение обратно отдаёт те же числа, что и до выключения.
 */
export async function disabledModulesOf(tx: Tx, ownerId: string): Promise<readonly string[]> {
  const rows = (await tx.execute(sql`
    SELECT disabled_modules FROM user_settings WHERE owner_id = ${ownerId}::uuid`)) as unknown as {
    disabled_modules: string[] | null;
  }[];
  // Строки настроек может не быть (владелец не проходил онбординг) — законный случай:
  // ничего не выключено. Тот же приём, что у `readRegistryVersions` (`registry/version.ts`).
  return rows[0]?.disabled_modules ?? [];
}

/** Идемпотентно в обе стороны: повтор не дублирует элемент, включение снимает ровно его. */
export async function setModuleDisabled(
  tx: Tx,
  ownerId: string,
  module: string,
  disabled: boolean,
): Promise<void> {
  await tx.execute(
    disabled
      ? sql`INSERT INTO user_settings (owner_id, disabled_modules)
            VALUES (${ownerId}::uuid, ARRAY[${module}]::text[])
            ON CONFLICT (owner_id) DO UPDATE
              SET disabled_modules = array_append(user_settings.disabled_modules, ${module}),
                  updated_at = now()
              WHERE NOT (${module} = ANY(user_settings.disabled_modules))`
      : // Строки нет — выключать нечего: INSERT здесь завёл бы настройки мимо онборда
        sql`UPDATE user_settings
            SET disabled_modules = array_remove(disabled_modules, ${module}), updated_at = now()
            WHERE owner_id = ${ownerId}::uuid AND ${module} = ANY(disabled_modules)`,
  );
}
