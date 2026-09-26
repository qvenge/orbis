// apps/server/src/registry/extensions.ts
// Маска включённости расширений владельца (§Б8-1/§Б8-3, спека 1б §4.1) — чтение и идемпотентная
// запись колонки `user_settings.disabled_modules` (заведена миграцией 0018). Имя колонки прежнее
// (РП-10): переименование — миграция ради слова.
import type { GraphId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';

/**
 * Маска включённости (§Б8-3) — ОТДЕЛЬНО от снимка реестра и намеренно. Тем же снимком
 * (`effectiveRegistry`, `registry/cache.ts`) резолвятся СОХРАНЁННЫЕ AST на чтении
 * (`queryContext`, `query/context.ts`), а §Б8-3
 * требует: определения выключенного расширения остаются резолвимыми. Второй довод —
 * `user.updateSettings` (`routers/user.ts`) не двигает `registry_version`, и маска
 * внутри снимка застревала бы в процессном кеше.
 *
 * Следствие, названное вслух: кэш `spent` (`budget/spent-cache.ts`) при переключении расширения
 * НЕ инвалидируется — маска в ключ кеша не входит по построению, а выключенное расширение просто
 * не читает ведомость. Включение обратно отдаёт те же числа, что и до выключения.
 */
export async function disabledExtensionsOf(tx: Tx, graphId: GraphId): Promise<readonly string[]> {
  const rows = (await tx.execute(sql`
    SELECT disabled_modules FROM user_settings WHERE graph_id = ${graphId}::uuid`)) as unknown as {
    disabled_modules: string[] | null;
  }[];
  // Строки настроек может не быть (владелец не проходил онбординг) — законный случай:
  // ничего не выключено. Тот же приём, что у `readRegistryVersions` (`registry/version.ts`).
  return rows[0]?.disabled_modules ?? [];
}

/** Идемпотентно в обе стороны: повтор не дублирует элемент, включение снимает ровно его. */
export async function setExtensionDisabled(
  tx: Tx,
  graphId: GraphId,
  ext: string,
  disabled: boolean,
): Promise<void> {
  await tx.execute(
    disabled
      ? sql`INSERT INTO user_settings (graph_id, disabled_modules)
            VALUES (${graphId}::uuid, ARRAY[${ext}]::text[])
            ON CONFLICT (graph_id) DO UPDATE
              SET disabled_modules = array_append(user_settings.disabled_modules, ${ext}),
                  updated_at = now()
              WHERE NOT (${ext} = ANY(user_settings.disabled_modules))`
      : // Строки нет — выключать нечего: INSERT здесь завёл бы настройки мимо онборда
        sql`UPDATE user_settings
            SET disabled_modules = array_remove(disabled_modules, ${ext}), updated_at = now()
            WHERE graph_id = ${graphId}::uuid AND ${ext} = ANY(disabled_modules)`,
  );
}
