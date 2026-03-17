import { z } from 'zod';
import { eq, or, isNull, sql } from 'drizzle-orm';
import { router, protectedProcedure } from '../trpc.ts';
import { aspectDefinitions, userSettings } from '../db/schema.ts';
import { createAspectInput } from '@orbis/shared';

export const aspectRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const aspects = await ctx.db
      .select()
      .from(aspectDefinitions)
      .where(or(isNull(aspectDefinitions.userId), eq(aspectDefinitions.userId, ctx.userId)));

    return aspects;
  }),

  create: protectedProcedure.input(createAspectInput).mutation(async ({ input, ctx }) => {
    const [aspect] = await ctx.db
      .insert(aspectDefinitions)
      .values({
        id: input.id,
        userId: ctx.userId,
        name: input.name,
        namespace: 'user',
        schema: input.schema,
        aiInstructions: input.aiInstructions ?? null,
        tagMappings: input.tagMappings ?? [],
        viewConfig: input.viewConfig ?? {},
      })
      .returning();

    // Auto-activate user-created aspects
    await ctx.db
      .update(userSettings)
      .set({
        aspectStatuses: sql`jsonb_set(${userSettings.aspectStatuses}, ${`{${input.id}}`}, '"active"')`,
        updatedAt: new Date(),
      })
      .where(eq(userSettings.userId, ctx.userId));

    return aspect;
  }),

  activate: protectedProcedure
    .input(z.object({ aspectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .update(userSettings)
        .set({
          aspectStatuses: sql`jsonb_set(${userSettings.aspectStatuses}, ${`{${input.aspectId}}`}, '"active"')`,
          updatedAt: new Date(),
        })
        .where(eq(userSettings.userId, ctx.userId));

      // TODO: Retroactive migration (migration.service.ts)
      return { migrated: 0 };
    }),

  deactivate: protectedProcedure
    .input(z.object({ aspectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .update(userSettings)
        .set({
          aspectStatuses: sql`jsonb_set(${userSettings.aspectStatuses}, ${`{${input.aspectId}}`}, '"inactive"')`,
          updatedAt: new Date(),
        })
        .where(eq(userSettings.userId, ctx.userId));

      return { success: true };
    }),
});
