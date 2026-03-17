import { z } from 'zod';
import { eq, and, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc.ts';
import { relations, entities } from '../db/schema.ts';
import { createRelationInput, deleteRelationInput } from '@orbis/shared';

export const relationRouter = router({
  create: protectedProcedure.input(createRelationInput).mutation(async ({ input, ctx }) => {
    // Validate both entities belong to user
    const [source] = await ctx.db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, input.sourceId), eq(entities.userId, ctx.userId)));

    const [target] = await ctx.db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, input.targetId), eq(entities.userId, ctx.userId)));

    if (!source || !target) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Both entities must exist and belong to you' });
    }

    const id = crypto.randomUUID();
    const [relation] = await ctx.db
      .insert(relations)
      .values({
        id,
        sourceId: input.sourceId,
        targetId: input.targetId,
        relationType: input.relationType,
        meta: input.meta ?? {},
      })
      .returning();

    return relation;
  }),

  delete: protectedProcedure.input(deleteRelationInput).mutation(async ({ input, ctx }) => {
    await ctx.db
      .delete(relations)
      .where(
        and(
          eq(relations.sourceId, input.sourceId),
          eq(relations.targetId, input.targetId),
          eq(relations.relationType, input.relationType),
        ),
      );

    return { success: true };
  }),

  forEntity: protectedProcedure
    .input(z.object({ entityId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const allRelations = await ctx.db
        .select()
        .from(relations)
        .where(
          or(
            eq(relations.sourceId, input.entityId),
            eq(relations.targetId, input.entityId),
          ),
        );

      const outgoing = allRelations.filter((r) => r.sourceId === input.entityId);
      const incoming = allRelations.filter((r) => r.targetId === input.entityId);

      return { outgoing, incoming };
    }),

  // Like forEntity but with entity titles resolved via JOIN
  forEntityResolved: protectedProcedure
    .input(z.object({ entityId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Get all relations with linked entity info
      const rows = await ctx.db.execute(sql`
        SELECT
          r.id,
          r.source_id,
          r.target_id,
          r.relation_type,
          r.meta,
          r.created_at,
          e.id AS linked_id,
          e.title AS linked_title,
          e.emoji AS linked_emoji,
          CASE WHEN r.source_id = ${input.entityId} THEN 'outgoing' ELSE 'incoming' END AS direction
        FROM relations r
        JOIN entities e ON e.id = CASE
          WHEN r.source_id = ${input.entityId} THEN r.target_id
          ELSE r.source_id
        END
        WHERE (r.source_id = ${input.entityId} OR r.target_id = ${input.entityId})
          AND e.user_id = ${ctx.userId}
      `);

      // Get backlinks (entities whose bodyRefs contain this entity)
      const backlinks = await ctx.db
        .select({ id: entities.id, title: entities.title, emoji: entities.emoji })
        .from(entities)
        .where(
          and(
            eq(entities.userId, ctx.userId),
            sql`${input.entityId} = ANY(${entities.bodyRefs})`,
          ),
        );

      type ResolvedRelation = {
        id: string;
        source_id: string;
        target_id: string;
        relation_type: string;
        meta: Record<string, unknown>;
        created_at: string;
        linked_id: string;
        linked_title: string;
        linked_emoji: string | null;
        direction: 'outgoing' | 'incoming';
      };

      return {
        relations: rows as unknown as ResolvedRelation[],
        backlinks,
      };
    }),

  checkCycle: protectedProcedure
    .input(z.object({ sourceId: z.string().uuid(), targetId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const result = await ctx.db.execute(sql`
        WITH RECURSIVE chain AS (
          SELECT target_id AS entity_id, 1 AS depth
          FROM relations
          WHERE source_id = ${input.targetId} AND relation_type = 'blocks'

          UNION ALL

          SELECT r.target_id, c.depth + 1
          FROM relations r
          JOIN chain c ON r.source_id = c.entity_id
          WHERE r.relation_type = 'blocks' AND c.depth < 100
        )
        SELECT EXISTS (
          SELECT 1 FROM chain WHERE entity_id = ${input.sourceId}
        ) AS would_create_cycle
      `);

      return { wouldCreateCycle: result[0]?.would_create_cycle === true };
    }),
});
