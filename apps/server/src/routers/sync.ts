import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { router, protectedProcedure } from '../trpc.ts';
import { entities } from '../db/schema.ts';
import { syncPushInput } from '@orbis/shared';

export const syncRouter = router({
  push: protectedProcedure.input(syncPushInput).mutation(async ({ input, ctx }) => {
    const incomingEntities = input.changes.entities as Array<Record<string, unknown>>;
    let conflictCount = 0;

    for (const entityData of incomingEntities) {
      if (!entityData.id) continue;
      const id = String(entityData.id);

      // Check if entity exists
      const [existing] = await ctx.db
        .select({ id: entities.id, updatedAt: entities.updatedAt })
        .from(entities)
        .where(and(eq(entities.id, id), eq(entities.userId, ctx.userId)));

      if (existing) {
        // LWW: only update if incoming is newer
        const incomingUpdatedAt = entityData.updatedAt ? new Date(String(entityData.updatedAt)) : new Date();
        if (incomingUpdatedAt > existing.updatedAt) {
          const { id: _id, userId: _uid, createdAt: _cat, ...updateFields } = entityData;
          await ctx.db
            .update(entities)
            .set({
              ...updateFields,
              updatedAt: incomingUpdatedAt,
              syncedAt: new Date(),
            } as Record<string, unknown>)
            .where(and(eq(entities.id, id), eq(entities.userId, ctx.userId)));
        } else {
          // Server version is newer — conflict (server wins)
          conflictCount++;
        }
      } else {
        // Insert new
        await ctx.db
          .insert(entities)
          .values({
            id,
            userId: ctx.userId,
            title: String(entityData.title ?? 'Untitled'),
            emoji: entityData.emoji ? String(entityData.emoji) : null,
            body: String(entityData.body ?? ''),
            bodyRefs: (entityData.bodyRefs as string[]) ?? [],
            tags: (entityData.tags as string[]) ?? [],
            meta: (entityData.meta as Record<string, unknown>) ?? {},
            aspects: (entityData.aspects as Record<string, unknown>) ?? {},
            createdAt: entityData.createdAt ? new Date(String(entityData.createdAt)) : new Date(),
            updatedAt: entityData.updatedAt ? new Date(String(entityData.updatedAt)) : new Date(),
            syncedAt: new Date(),
          })
          .onConflictDoNothing();
      }
    }

    if (conflictCount > 0) {
      console.log(`[Sync] ${conflictCount} conflict(s) resolved (server wins) for user ${ctx.userId}`);
    }

    return {
      serverChanges: { entities: [], relations: [] },
      newSyncAt: new Date().toISOString(),
      conflictCount,
    };
  }),

  pull: protectedProcedure
    .input(
      z.object({
        lastSyncAt: z.string().datetime().nullable(),
        deviceId: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const conditions = [eq(entities.userId, ctx.userId)];

      if (input.lastSyncAt) {
        conditions.push(
          sql`${entities.updatedAt} > ${input.lastSyncAt}::timestamptz`,
        );
      }

      const changedEntities = await ctx.db
        .select()
        .from(entities)
        .where(and(...conditions))
        .limit(500);

      return {
        entities: changedEntities,
        relations: [],
        syncAt: new Date().toISOString(),
      };
    }),
});
