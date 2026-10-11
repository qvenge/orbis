import { z } from 'zod';

/** IANA-зона: `Intl.DateTimeFormat` её строит. Одна правда на сервер (queryContext, агрегаты) и вход настроек. */
export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Вход операции `settings_set` и ручки `user.updateSettings` — ОДНА схема (довод `setExtensionEnabledInput`: два описания
 * одной операции разъехались бы). `plan` не правится (entitlements, §8); маска расширений — `module_set`.
 * Невалидная зона роняла бы RangeError в `queryContext` на каждом чтении (прежний докблок `routers/user.ts`).
 */
export const settingsSetInput = z
  .object({
    timezone: z
      .string()
      .min(1)
      .refine(isValidTimeZone, { message: 'неизвестная таймзона (IANA, напр. Europe/Moscow)' })
      .optional(),
    defaultCurrency: z.string().length(3).optional(),
    weekStartDay: z.enum(['monday', 'sunday']).optional(),
    tagColors: z.record(z.unknown()).optional(),
    installedViews: z.array(z.string()).optional(),
    pinnedEntities: z
      .array(z.object({ id: z.string().uuid(), order: z.number().int() }).strict())
      .optional(),
    viewPreferences: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'нечего менять: укажите хотя бы одно поле настроек');
export type SettingsSetInput = z.infer<typeof settingsSetInput>;
