// apps/server/src/routers/user.ts
// Роутер user (§9.1): онбординг-сидирование (02 §7), настройки §7.3/§4.4, экспорт §9.4.
// Только трансляция: сид/экспорт — примитивы seed/onboarding.ts и export.ts под одним
// withIdentity-tx (RLS §4.10). user_settings — конфигурация, НЕ сущность: пишется напрямую,
// не через executor/журнал (§2.2).
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { userSettings } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execErrorToTRPC } from '../errors';
import { exportData, type OrbisExport } from '../export';
import { seedOnboarding } from '../seed/onboarding';
import { protectedProcedure, router } from '../trpc';
import { toWireUserSettings, type WireUserSettings } from '../wire';

// Партиал настроек §1.6/§7.3: правятся «Общие» (timezone/currency/weekStartDay) и
// прикладные поля (pinned/views/цвета тегов/preferences). plan НЕ редактируется отсюда —
// это entitlements (§8), меняется серверным конфигом.
const updateSettingsInput = z
  .object({
    timezone: z.string().min(1).optional(),
    defaultCurrency: z.string().length(3).optional(),
    weekStartDay: z.enum(['monday', 'sunday']).optional(),
    tagColors: z.record(z.unknown()).optional(),
    installedViews: z.array(z.string()).optional(),
    pinnedEntities: z
      .array(z.object({ id: z.string().uuid(), order: z.number().int() }).strict())
      .optional(),
    viewPreferences: z.record(z.unknown()).optional(),
  })
  .strict();

export const userRouter = router({
  // Идемпотентно (02 §7): { seeded: false } — уже было. Один withIdentity-tx.
  seedOnboarding: protectedProcedure.mutation(({ ctx }) =>
    withIdentity(ctx.db, ctx.actorUserId, (tx) => seedOnboarding(tx, ctx.actorUserId)),
  ),

  getSettings: protectedProcedure.query(
    ({ ctx }): Promise<WireUserSettings> =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const rows = await tx
          .select()
          .from(userSettings)
          .where(eq(userSettings.ownerId, ctx.actorUserId));
        if (!rows[0]) {
          // Нет строки → онбординг не проходил (или чужая под RLS): единый NOT_FOUND
          throw execErrorToTRPC({ code: 'NOT_FOUND', message: 'настройки не найдены' });
        }
        return toWireUserSettings(rows[0]);
      }),
  ),

  updateSettings: protectedProcedure.input(updateSettingsInput).mutation(
    ({ ctx, input }): Promise<WireUserSettings> =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        // LWW-правка конфигурации (§5.2): body-optimistic-check не применяется — это не сущность
        const rows = await tx
          .update(userSettings)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(userSettings.ownerId, ctx.actorUserId))
          .returning();
        if (!rows[0]) {
          throw execErrorToTRPC({ code: 'NOT_FOUND', message: 'настройки не найдены' });
        }
        return toWireUserSettings(rows[0]);
      }),
  ),

  exportData: protectedProcedure.query(
    ({ ctx }): Promise<OrbisExport> =>
      withIdentity(ctx.db, ctx.actorUserId, (tx) => exportData(tx, ctx.actorUserId)),
  ),
});
