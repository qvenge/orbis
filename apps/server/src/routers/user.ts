import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc.ts';
import { userSettings } from '../db/schema.ts';
import { updateSettingsInput, DEFAULT_ASPECT_STATUSES, VIEW_ASPECT_MAP } from '@orbis/shared';
import { ensureSmartViews } from '../db/seed-smart-views.ts';

export const userRouter = router({
  getSettings: protectedProcedure.query(async ({ ctx }) => {
    const [settings] = await ctx.db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, ctx.userId));

    if (settings) {
      // Bootstrap smart views if pinnedEntities is empty
      const pinned = settings.pinnedEntities as Array<{ id: string; order: number }>;
      if (!pinned || pinned.length === 0) {
        const newPinned = await ensureSmartViews(ctx.db as any, ctx.userId);
        if (newPinned.length > 0) {
          // Re-fetch with updated pins
          const [updated] = await ctx.db
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, ctx.userId));
          return updated;
        }
      }
      return settings;
    }

    // Create default settings for new user
    const [created] = await ctx.db
      .insert(userSettings)
      .values({
        userId: ctx.userId,
        aspectStatuses: DEFAULT_ASPECT_STATUSES,
      })
      .returning();

    // Bootstrap smart views for new user
    await ensureSmartViews(ctx.db as any, ctx.userId);
    const [withPins] = await ctx.db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, ctx.userId));

    return withPins ?? created;
  }),

  updateSettings: protectedProcedure
    .input(updateSettingsInput)
    .mutation(async ({ input, ctx }) => {
      const setClause: Record<string, unknown> = { updatedAt: new Date() };

      if (input.displayName !== undefined) setClause.displayName = input.displayName;
      if (input.timezone !== undefined) setClause.timezone = input.timezone;
      if (input.defaultCurrency !== undefined) setClause.defaultCurrency = input.defaultCurrency;
      if (input.weekStartDay !== undefined) setClause.weekStartDay = input.weekStartDay;
      if (input.tagColors !== undefined) setClause.tagColors = input.tagColors;
      if (input.installedViews !== undefined) setClause.installedViews = input.installedViews;
      if (input.pinnedEntities !== undefined) setClause.pinnedEntities = input.pinnedEntities;
      if (input.statusStripMetrics !== undefined) setClause.statusStripMetrics = input.statusStripMetrics;
      if (input.aspectStatuses !== undefined) setClause.aspectStatuses = input.aspectStatuses;
      if (input.viewPreferences !== undefined) setClause.viewPreferences = input.viewPreferences;

      const [updated] = await ctx.db
        .update(userSettings)
        .set(setClause)
        .where(eq(userSettings.userId, ctx.userId))
        .returning();

      return updated;
    }),

  installView: protectedProcedure
    .input(z.object({ viewId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Get current settings
      const [settings] = await ctx.db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, ctx.userId));

      if (!settings) throw new TRPCError({ code: 'NOT_FOUND', message: 'User settings not found' });

      const views = (settings.installedViews as string[]) ?? [];
      if (views.includes(input.viewId)) {
        return { installed: true, migrated: 0 };
      }

      // Add view and activate linked aspects
      const linkedAspects = VIEW_ASPECT_MAP[input.viewId] ?? [];
      const newStatuses = { ...(settings.aspectStatuses as Record<string, string>) };
      for (const aspectId of linkedAspects) {
        newStatuses[aspectId] = 'active';
      }

      await ctx.db
        .update(userSettings)
        .set({
          installedViews: [...views, input.viewId],
          aspectStatuses: newStatuses,
          updatedAt: new Date(),
        })
        .where(eq(userSettings.userId, ctx.userId));

      // TODO: Trigger retroactive migration
      return { installed: true, migrated: 0 };
    }),

  uninstallView: protectedProcedure
    .input(z.object({ viewId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [settings] = await ctx.db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, ctx.userId));

      if (!settings) throw new TRPCError({ code: 'NOT_FOUND', message: 'User settings not found' });

      const views = ((settings.installedViews as string[]) ?? []).filter(
        (v) => v !== input.viewId,
      );

      // Set linked aspects to inactive
      const linkedAspects = VIEW_ASPECT_MAP[input.viewId] ?? [];
      const newStatuses = { ...(settings.aspectStatuses as Record<string, string>) };
      for (const aspectId of linkedAspects) {
        newStatuses[aspectId] = 'inactive';
      }

      await ctx.db
        .update(userSettings)
        .set({
          installedViews: views,
          aspectStatuses: newStatuses,
          updatedAt: new Date(),
        })
        .where(eq(userSettings.userId, ctx.userId));

      return { uninstalled: true };
    }),
});
