import { z } from 'zod';
import { eq, and, sql, desc, asc } from 'drizzle-orm';
import { router, protectedProcedure } from '../../trpc.ts';
import { entities } from '../../db/schema.ts';
import { createEntityInput, updateEntityInput, entityQueryInput } from '@orbis/shared';
import { extractBodyRefs } from '../../utils/body-refs.ts';

export const entityCrudRouter = router({
  create: protectedProcedure.input(createEntityInput).mutation(async ({ input, ctx }) => {
    const id = input.id ?? crypto.randomUUID();
    const bodyRefs = extractBodyRefs(input.body ?? '');
    const now = new Date();

    const [entity] = await ctx.db
      .insert(entities)
      .values({
        id,
        userId: ctx.userId,
        title: input.title,
        emoji: input.emoji ?? null,
        body: input.body ?? '',
        bodyRefs,
        tags: input.tags ?? [],
        meta: input.meta ?? {},
        aspects: input.aspects ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return entity;
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const [entity] = await ctx.db
        .select()
        .from(entities)
        .where(and(eq(entities.id, input.id), eq(entities.userId, ctx.userId)));

      if (!entity) return null;
      return entity;
    }),

  update: protectedProcedure.input(updateEntityInput).mutation(async ({ input, ctx }) => {
    const { id, ...updates } = input;

    const bodyRefs =
      updates.body !== undefined ? extractBodyRefs(updates.body) : undefined;

    const setClause: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.title !== undefined) setClause.title = updates.title;
    if (updates.emoji !== undefined) setClause.emoji = updates.emoji;
    if (updates.body !== undefined) setClause.body = updates.body;
    if (bodyRefs !== undefined) setClause.bodyRefs = bodyRefs;
    if (updates.tags !== undefined) setClause.tags = updates.tags;
    if (updates.meta !== undefined) setClause.meta = updates.meta;
    if (updates.aspects !== undefined) setClause.aspects = updates.aspects;
    if (updates.archived !== undefined) setClause.archived = updates.archived;

    const [entity] = await ctx.db
      .update(entities)
      .set(setClause)
      .where(and(eq(entities.id, id), eq(entities.userId, ctx.userId)))
      .returning();

    return entity;
  }),

  archive: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const [entity] = await ctx.db
        .update(entities)
        .set({ archived: true, updatedAt: new Date() })
        .where(and(eq(entities.id, input.id), eq(entities.userId, ctx.userId)))
        .returning();

      return entity;
    }),

  list: protectedProcedure.input(entityQueryInput).query(async ({ input, ctx }) => {
    const conditions = [
      eq(entities.userId, ctx.userId),
      eq(entities.archived, input.archived),
    ];

    if (input.tags && input.tags.length > 0) {
      conditions.push(sql`${entities.tags} @> ${input.tags}`);
    }

    if (input.aspects && input.aspects.length > 0) {
      for (const aspect of input.aspects) {
        conditions.push(sql`${entities.aspects} ? ${aspect}`);
      }
    }

    if (input.search) {
      conditions.push(
        sql`(to_tsvector('simple', ${entities.title}) || to_tsvector('simple', ${entities.body})) @@ plainto_tsquery('simple', ${input.search})`,
      );
    }

    if (input.dateRange) {
      const { from, to, aspectField } = input.dateRange;
      conditions.push(
        sql`${entities.aspects}->>${aspectField} IS NOT NULL`,
      );
      conditions.push(
        sql`(${entities.aspects}->${aspectField}->>'start_at')::timestamptz >= ${from}::timestamptz`,
      );
      conditions.push(
        sql`(${entities.aspects}->${aspectField}->>'start_at')::timestamptz < ${to}::timestamptz`,
      );
    }

    const orderBy =
      input.sortBy === 'title'
        ? input.sortOrder === 'asc'
          ? asc(entities.title)
          : desc(entities.title)
        : input.sortBy === 'created_at'
          ? input.sortOrder === 'asc'
            ? asc(entities.createdAt)
            : desc(entities.createdAt)
          : input.sortOrder === 'asc'
            ? asc(entities.updatedAt)
            : desc(entities.updatedAt);

    const items = await ctx.db
      .select()
      .from(entities)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(input.limit)
      .offset(input.offset);

    return { items, total: items.length };
  }),

  queryBlock: protectedProcedure
    .input(
      z.object({
        aspect: z.string().optional(),
        tags: z.array(z.string()).optional(),
        excludeTags: z.array(z.string()).optional(),
        status: z.array(z.string()).optional(),
        excludeStatus: z.array(z.string()).optional(),
        due: z.string().optional(),
        excludeBlocked: z.boolean().optional(),
        sortBy: z
          .array(z.object({ field: z.string(), order: z.enum(['asc', 'desc']) }))
          .optional(),
        limit: z.number().int().min(1).max(200).optional(),
        display: z.enum(['compact', 'list', 'table']).optional(),
        title: z.string().optional(),
        search: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const conditions = [
        eq(entities.userId, ctx.userId),
        eq(entities.archived, false),
      ];

      if (input.aspect) {
        conditions.push(sql`${entities.aspects} ? ${input.aspect}`);
      }

      if (input.tags && input.tags.length > 0) {
        conditions.push(sql`${entities.tags} @> ${input.tags}`);
      }
      if (input.excludeTags && input.excludeTags.length > 0) {
        for (const tag of input.excludeTags) {
          conditions.push(sql`NOT (${entities.tags} @> ARRAY[${tag}])`);
        }
      }

      if (input.aspect && input.status && input.status.length > 0) {
        const statusChecks = input.status.map(
          (s) => sql`${entities.aspects}->${input.aspect}->>'status' = ${s}`,
        );
        conditions.push(
          statusChecks.length === 1
            ? statusChecks[0]
            : sql`(${sql.join(statusChecks, sql` OR `)})`,
        );
      }
      if (input.aspect && input.excludeStatus && input.excludeStatus.length > 0) {
        for (const s of input.excludeStatus) {
          conditions.push(
            sql`(${entities.aspects}->${input.aspect}->>'status' IS NULL OR ${entities.aspects}->${input.aspect}->>'status' != ${s})`,
          );
        }
      }

      if (input.aspect && input.due) {
        const dueParts = input.due.split('|');
        const dueConditions: ReturnType<typeof sql>[] = [];

        for (const part of dueParts) {
          const duePath = sql`(${entities.aspects}->${input.aspect}->>'due_date')`;
          switch (part.trim()) {
            case 'today':
              dueConditions.push(sql`${duePath}::date = CURRENT_DATE`);
              break;
            case 'overdue':
              dueConditions.push(
                sql`${duePath}::date < CURRENT_DATE AND ${duePath} IS NOT NULL`,
              );
              break;
            case 'next_7d':
              dueConditions.push(
                sql`${duePath}::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7`,
              );
              break;
            case 'after_7d':
              dueConditions.push(sql`${duePath}::date > CURRENT_DATE + 7`);
              break;
            case 'this_week':
              dueConditions.push(
                sql`${duePath}::date BETWEEN date_trunc('week', CURRENT_DATE) AND date_trunc('week', CURRENT_DATE) + 6`,
              );
              break;
          }
        }

        if (dueConditions.length === 1) {
          conditions.push(dueConditions[0]);
        } else if (dueConditions.length > 1) {
          conditions.push(sql`(${sql.join(dueConditions, sql` OR `)})`);
        }
      }

      if (input.search) {
        conditions.push(
          sql`(to_tsvector('simple', ${entities.title}) || to_tsvector('simple', ${entities.body})) @@ plainto_tsquery('simple', ${input.search})`,
        );
      }

      let query = ctx.db
        .select()
        .from(entities)
        .where(and(...conditions))
        .limit(input.limit ?? 50);

      if (input.excludeBlocked) {
        conditions.push(
          sql`NOT EXISTS (
            SELECT 1 FROM relations r
            JOIN entities blocker ON blocker.id = r.source_id
            WHERE r.target_id = ${entities.id}
              AND r.relation_type = 'blocks'
              AND (blocker.aspects->'orbis/task'->>'status') NOT IN ('done', 'cancelled')
          )`,
        );
        query = ctx.db
          .select()
          .from(entities)
          .where(and(...conditions))
          .limit(input.limit ?? 50);
      }

      const ALLOWED_SORT_FIELDS = ['created_at', 'updated_at', 'title', 'status', 'priority', 'due_date', 'amount'];

      if (input.sortBy && input.sortBy.length > 0) {
        const sortClauses = input.sortBy
          .filter((s) => ALLOWED_SORT_FIELDS.includes(s.field))
          .map((s) => {
            if (s.field === 'created_at') return s.order === 'desc' ? desc(entities.createdAt) : asc(entities.createdAt);
            if (s.field === 'updated_at') return s.order === 'desc' ? desc(entities.updatedAt) : asc(entities.updatedAt);
            if (s.field === 'title') return s.order === 'desc' ? desc(entities.title) : asc(entities.title);
            const direction = s.order === 'desc' ? sql`DESC` : sql`ASC`;
            if (input.aspect) {
              return sql`(${entities.aspects}->${input.aspect}->>${s.field}) ${direction} NULLS LAST`;
            }
            return s.order === 'desc' ? desc(entities.updatedAt) : asc(entities.updatedAt);
          });
        if (sortClauses.length > 0) {
          query = query.orderBy(...sortClauses) as typeof query;
        } else {
          query = query.orderBy(desc(entities.updatedAt)) as typeof query;
        }
      } else {
        query = query.orderBy(desc(entities.updatedAt)) as typeof query;
      }

      const items = await query;

      return {
        items,
        title: input.title,
        display: input.display ?? 'list',
      };
    }),
});
