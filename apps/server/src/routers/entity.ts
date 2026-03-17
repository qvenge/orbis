import { z } from 'zod';
import { eq, and, sql, desc, asc } from 'drizzle-orm';
import { router, protectedProcedure } from '../trpc.ts';
import { entities, relations as relationsTable } from '../db/schema.ts';
import { createEntityInput, updateEntityInput, entityQueryInput, financialSummaryInput, financialTransactionsInput, fitnessSummaryInput, fitnessWorkoutsInput, nutritionSummaryInput, nutritionMealsInput, habitCheckInInput, habitsHistoryInput } from '@orbis/shared';

// Extract entity UUIDs from [[entity:uuid|text]] syntax in body
function extractBodyRefs(body: string): string[] {
  const regex = /\[\[entity:([0-9a-f-]{36})\|[^\]]*\]\]/g;
  const refs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    refs.push(match[1]);
  }
  return [...new Set(refs)];
}

export const entityRouter = router({
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

    // Re-extract body_refs if body changed
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

      // Aspect filter
      if (input.aspect) {
        conditions.push(sql`${entities.aspects} ? ${input.aspect}`);
      }

      // Tags
      if (input.tags && input.tags.length > 0) {
        conditions.push(sql`${entities.tags} @> ${input.tags}`);
      }
      if (input.excludeTags && input.excludeTags.length > 0) {
        for (const tag of input.excludeTags) {
          conditions.push(sql`NOT (${entities.tags} @> ARRAY[${tag}])`);
        }
      }

      // Status filter (aspect-specific) — parameterized
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

      // Due date filter — parameterized
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

      // Search
      if (input.search) {
        conditions.push(
          sql`(to_tsvector('simple', ${entities.title}) || to_tsvector('simple', ${entities.body})) @@ plainto_tsquery('simple', ${input.search})`,
        );
      }

      // Build query
      let query = ctx.db
        .select()
        .from(entities)
        .where(and(...conditions))
        .limit(input.limit ?? 50);

      // Exclude blocked
      if (input.excludeBlocked) {
        // Subquery: entities that have unfinished blockers
        conditions.push(
          sql`NOT EXISTS (
            SELECT 1 FROM relations r
            JOIN entities blocker ON blocker.id = r.source_id
            WHERE r.target_id = ${entities.id}
              AND r.relation_type = 'blocks'
              AND (blocker.aspects->'orbis/task'->>'status') NOT IN ('done', 'cancelled')
          )`,
        );
        // Re-build with new condition
        query = ctx.db
          .select()
          .from(entities)
          .where(and(...conditions))
          .limit(input.limit ?? 50);
      }

      // Sort — whitelist built-in fields, parameterize aspect fields
      const ALLOWED_SORT_FIELDS = ['created_at', 'updated_at', 'title', 'status', 'priority', 'due_date', 'amount'];

      if (input.sortBy && input.sortBy.length > 0) {
        const sortClauses = input.sortBy
          .filter((s) => ALLOWED_SORT_FIELDS.includes(s.field))
          .map((s) => {
            if (s.field === 'created_at') return s.order === 'desc' ? desc(entities.createdAt) : asc(entities.createdAt);
            if (s.field === 'updated_at') return s.order === 'desc' ? desc(entities.updatedAt) : asc(entities.updatedAt);
            if (s.field === 'title') return s.order === 'desc' ? desc(entities.title) : asc(entities.title);
            // Aspect field sort — use parameterized aspect name, whitelisted field name
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

  financialSummary: protectedProcedure
    .input(financialSummaryInput)
    .query(async ({ input, ctx }) => {
      const periodStart = new Date(input.year, input.month - 1, 1);
      const periodEnd = new Date(input.year, input.month, 0, 23, 59, 59, 999);

      // Get all financial entities in the period
      const financialEntities = await ctx.db
        .select()
        .from(entities)
        .where(
          and(
            eq(entities.userId, ctx.userId),
            eq(entities.archived, false),
            sql`${entities.aspects} ? 'orbis/financial'`,
            sql`${entities.createdAt} >= ${periodStart.toISOString()}::timestamptz`,
            sql`${entities.createdAt} <= ${periodEnd.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(desc(entities.createdAt));

      let totalIncome = 0;
      let totalExpenses = 0;
      const categoryTotals: Record<string, { income: number; expense: number }> = {};
      const envelopeCategories = new Set<string>();
      const dailyExpenses: Record<string, number> = {};

      type FinancialAspect = {
        amount?: number;
        direction?: string;
        category?: string;
      };

      // Process entities
      const envelopes: Array<{
        entityId: string;
        title: string;
        category: string;
        limit: number;
        effectiveLimit: number;
        spent: number;
        remaining: number;
      }> = [];

      for (const entity of financialEntities) {
        const aspects = entity.aspects as Record<string, unknown>;
        const fin = aspects['orbis/financial'] as FinancialAspect | undefined;
        if (!fin || typeof fin.amount !== 'number') continue;

        const category = fin.category ?? 'other';
        const direction = fin.direction ?? 'expense';

        if (direction === 'budget') {
          const meta = (entity.meta ?? {}) as Record<string, unknown>;
          const carryover = typeof meta.carryover === 'number' ? meta.carryover : 0;
          envelopes.push({
            entityId: entity.id,
            title: entity.title,
            category,
            limit: fin.amount,
            effectiveLimit: fin.amount + carryover,
            spent: 0,
            remaining: fin.amount + carryover,
          });
          envelopeCategories.add(category);
        } else if (direction === 'income') {
          totalIncome += fin.amount;
          if (!categoryTotals[category]) categoryTotals[category] = { income: 0, expense: 0 };
          categoryTotals[category].income += fin.amount;
        } else {
          totalExpenses += fin.amount;
          if (!categoryTotals[category]) categoryTotals[category] = { income: 0, expense: 0 };
          categoryTotals[category].expense += fin.amount;
          // Track daily spending
          const day = entity.createdAt.toISOString().slice(0, 10);
          dailyExpenses[day] = (dailyExpenses[day] ?? 0) + fin.amount;
        }
      }

      // Compute spent per envelope — match by category
      for (const env of envelopes) {
        const catTotal = categoryTotals[env.category];
        env.spent = catTotal?.expense ?? 0;
        env.remaining = env.effectiveLimit - env.spent;
      }

      // Also compute spent via parent relations for more accuracy
      if (envelopes.length > 0) {
        const envelopeIds = envelopes.map((e) => e.entityId);
        const childExpenses = await ctx.db
          .select({
            parentId: relationsTable.targetId,
            total: sql<number>`COALESCE(SUM((${entities.aspects}->'orbis/financial'->>'amount')::numeric), 0)`,
          })
          .from(relationsTable)
          .innerJoin(entities, eq(entities.id, relationsTable.sourceId))
          .where(
            and(
              sql`${relationsTable.targetId} = ANY(${envelopeIds})`,
              eq(relationsTable.relationType, 'parent'),
              sql`${entities.aspects}->'orbis/financial'->>'direction' = 'expense'`,
            ),
          )
          .groupBy(relationsTable.targetId);

        for (const row of childExpenses) {
          const env = envelopes.find((e) => e.entityId === row.parentId);
          if (env && row.total > 0) {
            // Use relation-based total if higher (more accurate)
            if (row.total > env.spent) {
              env.spent = Number(row.total);
              env.remaining = env.effectiveLimit - env.spent;
            }
          }
        }
      }

      // Unbudgeted: expense categories without an envelope
      let unbudgetedTotal = 0;
      for (const [category, totals] of Object.entries(categoryTotals)) {
        if (!envelopeCategories.has(category) && totals.expense > 0) {
          unbudgetedTotal += totals.expense;
        }
      }

      // Category breakdown
      const categoryBreakdown = Object.entries(categoryTotals).flatMap(([category, totals]) => {
        const result: Array<{ category: string; total: number; direction: string }> = [];
        if (totals.income > 0) result.push({ category, total: totals.income, direction: 'income' });
        if (totals.expense > 0) result.push({ category, total: totals.expense, direction: 'expense' });
        return result;
      });

      // Build daily spending array for the period
      const daysInMonth = new Date(input.year, input.month, 0).getDate();
      const dailySpending: Array<{ date: string; amount: number }> = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${input.year}-${String(input.month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        dailySpending.push({ date: dateStr, amount: dailyExpenses[dateStr] ?? 0 });
      }

      return {
        totalIncome,
        totalExpenses,
        balance: totalIncome - totalExpenses,
        envelopes,
        categoryBreakdown,
        unbudgetedTotal,
        dailySpending,
      };
    }),

  financialTransactions: protectedProcedure
    .input(financialTransactionsInput)
    .query(async ({ input, ctx }) => {
      const periodStart = new Date(input.year, input.month - 1, 1);
      const periodEnd = new Date(input.year, input.month, 0, 23, 59, 59, 999);

      const conditions = [
        eq(entities.userId, ctx.userId),
        eq(entities.archived, false),
        sql`${entities.aspects} ? 'orbis/financial'`,
        sql`${entities.createdAt} >= ${periodStart.toISOString()}::timestamptz`,
        sql`${entities.createdAt} <= ${periodEnd.toISOString()}::timestamptz`,
        // Exclude budget envelopes from transaction list
        sql`${entities.aspects}->'orbis/financial'->>'direction' != 'budget'`,
      ];

      if (input.category) {
        conditions.push(sql`${entities.aspects}->'orbis/financial'->>'category' = ${input.category}`);
      }

      if (input.direction) {
        conditions.push(sql`${entities.aspects}->'orbis/financial'->>'direction' = ${input.direction}`);
      }

      if (input.search) {
        conditions.push(
          sql`(to_tsvector('simple', ${entities.title}) || to_tsvector('simple', ${entities.body})) @@ plainto_tsquery('simple', ${input.search})`,
        );
      }

      const items = await ctx.db
        .select()
        .from(entities)
        .where(and(...conditions))
        .orderBy(desc(entities.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      return { items, total: items.length };
    }),

  financialCategories: protectedProcedure.query(async ({ ctx }) => {
    const result = await ctx.db
      .select({
        category: sql<string>`DISTINCT ${entities.aspects}->'orbis/financial'->>'category'`,
      })
      .from(entities)
      .where(
        and(
          eq(entities.userId, ctx.userId),
          eq(entities.archived, false),
          sql`${entities.aspects} ? 'orbis/financial'`,
          sql`${entities.aspects}->'orbis/financial'->>'category' IS NOT NULL`,
        ),
      );

    return result.map((r) => r.category).filter(Boolean);
  }),

  // ─── Fitness ───

  fitnessSummary: protectedProcedure
    .input(fitnessSummaryInput)
    .query(async ({ input, ctx }) => {
      const periodStart = new Date(input.year, input.month - 1, 1);
      const periodEnd = new Date(input.year, input.month, 0, 23, 59, 59, 999);

      const fitnessEntities = await ctx.db
        .select()
        .from(entities)
        .where(
          and(
            eq(entities.userId, ctx.userId),
            eq(entities.archived, false),
            sql`${entities.aspects} ? 'orbis/fitness'`,
            sql`${entities.createdAt} >= ${periodStart.toISOString()}::timestamptz`,
            sql`${entities.createdAt} <= ${periodEnd.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(desc(entities.createdAt));

      type FitnessAspect = {
        workout_type?: string;
        duration_min?: number;
        perceived_effort?: number;
        total_volume_kg?: number;
        exercises?: Array<{ sets: number; reps: number; weight_kg: number }>;
      };

      let totalWorkouts = 0;
      let totalVolume = 0;
      let totalDuration = 0;
      let totalEffort = 0;
      let effortCount = 0;
      const typeCounts: Record<string, number> = {};
      const weeklyVolume: number[] = [0, 0, 0, 0, 0];
      const effortTrend: Array<{ date: string; effort: number }> = [];

      for (const entity of fitnessEntities) {
        const aspects = entity.aspects as Record<string, unknown>;
        const fit = aspects['orbis/fitness'] as FitnessAspect | undefined;
        if (!fit) continue;

        totalWorkouts++;

        const volume = typeof fit.total_volume_kg === 'number'
          ? fit.total_volume_kg
          : Array.isArray(fit.exercises)
            ? fit.exercises.reduce((s, e) => s + (e.sets || 0) * (e.reps || 0) * (e.weight_kg || 0), 0)
            : 0;
        totalVolume += volume;

        if (typeof fit.duration_min === 'number') totalDuration += fit.duration_min;
        if (typeof fit.perceived_effort === 'number') {
          totalEffort += fit.perceived_effort;
          effortCount++;
          effortTrend.push({ date: entity.createdAt.toISOString().slice(0, 10), effort: fit.perceived_effort });
        }

        const wType = fit.workout_type ?? 'other';
        typeCounts[wType] = (typeCounts[wType] ?? 0) + 1;

        // Weekly bucket (0-based week of month)
        const dayOfMonth = entity.createdAt.getDate();
        const weekIndex = Math.min(Math.floor((dayOfMonth - 1) / 7), 4);
        weeklyVolume[weekIndex] += volume;
      }

      return {
        totalWorkouts,
        totalVolume: Math.round(totalVolume),
        totalDuration,
        avgEffort: effortCount > 0 ? Math.round((totalEffort / effortCount) * 10) / 10 : 0,
        workoutTypeBreakdown: Object.entries(typeCounts).map(([type, count]) => ({ type, count })),
        weeklyVolume,
        effortTrend: effortTrend.sort((a, b) => a.date.localeCompare(b.date)),
      };
    }),

  fitnessWorkouts: protectedProcedure
    .input(fitnessWorkoutsInput)
    .query(async ({ input, ctx }) => {
      const periodStart = new Date(input.year, input.month - 1, 1);
      const periodEnd = new Date(input.year, input.month, 0, 23, 59, 59, 999);

      const conditions = [
        eq(entities.userId, ctx.userId),
        eq(entities.archived, false),
        sql`${entities.aspects} ? 'orbis/fitness'`,
        sql`${entities.createdAt} >= ${periodStart.toISOString()}::timestamptz`,
        sql`${entities.createdAt} <= ${periodEnd.toISOString()}::timestamptz`,
      ];

      if (input.workoutType) {
        conditions.push(
          sql`${entities.aspects}->'orbis/fitness'->>'workout_type' = ${input.workoutType}`,
        );
      }

      const items = await ctx.db
        .select()
        .from(entities)
        .where(and(...conditions))
        .orderBy(desc(entities.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      return { items, total: items.length };
    }),

  fitnessWorkoutTypes: protectedProcedure.query(async ({ ctx }) => {
    const result = await ctx.db
      .select({
        workoutType: sql<string>`DISTINCT ${entities.aspects}->'orbis/fitness'->>'workout_type'`,
      })
      .from(entities)
      .where(
        and(
          eq(entities.userId, ctx.userId),
          eq(entities.archived, false),
          sql`${entities.aspects} ? 'orbis/fitness'`,
          sql`${entities.aspects}->'orbis/fitness'->>'workout_type' IS NOT NULL`,
        ),
      );

    return result.map((r) => r.workoutType).filter(Boolean);
  }),

  // ─── Nutrition ───

  nutritionSummary: protectedProcedure
    .input(nutritionSummaryInput)
    .query(async ({ input, ctx }) => {
      const periodStart = new Date(input.year, input.month - 1, 1);
      const periodEnd = new Date(input.year, input.month, 0, 23, 59, 59, 999);

      const nutritionEntities = await ctx.db
        .select()
        .from(entities)
        .where(
          and(
            eq(entities.userId, ctx.userId),
            eq(entities.archived, false),
            sql`${entities.aspects} ? 'orbis/nutrition'`,
            sql`${entities.createdAt} >= ${periodStart.toISOString()}::timestamptz`,
            sql`${entities.createdAt} <= ${periodEnd.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(desc(entities.createdAt));

      type NutritionAspect = {
        meal_type?: string;
        total_calories?: number;
        total_protein?: number;
        total_carbs?: number;
        total_fat?: number;
        items?: Array<{ calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number }>;
      };

      let totalMeals = 0;
      const typeCounts: Record<string, number> = {};
      const dailyMap: Record<string, { calories: number; protein: number; carbs: number; fat: number }> = {};

      for (const entity of nutritionEntities) {
        const aspects = entity.aspects as Record<string, unknown>;
        const nut = aspects['orbis/nutrition'] as NutritionAspect | undefined;
        if (!nut) continue;

        totalMeals++;

        // Compute macros from totals or items
        let cal = typeof nut.total_calories === 'number' ? nut.total_calories : 0;
        let pro = typeof nut.total_protein === 'number' ? nut.total_protein : 0;
        let carb = typeof nut.total_carbs === 'number' ? nut.total_carbs : 0;
        let fat = typeof nut.total_fat === 'number' ? nut.total_fat : 0;

        if (cal === 0 && Array.isArray(nut.items)) {
          for (const item of nut.items) {
            cal += Number(item.calories ?? 0);
            pro += Number(item.protein_g ?? 0);
            carb += Number(item.carbs_g ?? 0);
            fat += Number(item.fat_g ?? 0);
          }
        }

        const mealType = nut.meal_type ?? 'other';
        typeCounts[mealType] = (typeCounts[mealType] ?? 0) + 1;

        const dateKey = entity.createdAt.toISOString().slice(0, 10);
        if (!dailyMap[dateKey]) dailyMap[dateKey] = { calories: 0, protein: 0, carbs: 0, fat: 0 };
        dailyMap[dateKey].calories += cal;
        dailyMap[dateKey].protein += pro;
        dailyMap[dateKey].carbs += carb;
        dailyMap[dateKey].fat += fat;
      }

      const dailyTotals = Object.entries(dailyMap)
        .map(([date, totals]) => ({ date, ...totals }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const daysWithData = dailyTotals.length || 1;

      return {
        totalMeals,
        dailyAvgCalories: Math.round(dailyTotals.reduce((s, d) => s + d.calories, 0) / daysWithData),
        dailyAvgProtein: Math.round(dailyTotals.reduce((s, d) => s + d.protein, 0) / daysWithData),
        dailyAvgCarbs: Math.round(dailyTotals.reduce((s, d) => s + d.carbs, 0) / daysWithData),
        dailyAvgFat: Math.round(dailyTotals.reduce((s, d) => s + d.fat, 0) / daysWithData),
        mealTypeBreakdown: Object.entries(typeCounts).map(([type, count]) => ({ type, count })),
        dailyTotals,
      };
    }),

  nutritionMeals: protectedProcedure
    .input(nutritionMealsInput)
    .query(async ({ input, ctx }) => {
      const periodStart = new Date(input.year, input.month - 1, 1);
      const periodEnd = new Date(input.year, input.month, 0, 23, 59, 59, 999);

      const conditions = [
        eq(entities.userId, ctx.userId),
        eq(entities.archived, false),
        sql`${entities.aspects} ? 'orbis/nutrition'`,
        sql`${entities.createdAt} >= ${periodStart.toISOString()}::timestamptz`,
        sql`${entities.createdAt} <= ${periodEnd.toISOString()}::timestamptz`,
      ];

      if (input.date) {
        conditions.push(sql`${entities.createdAt}::date = ${input.date}::date`);
      }

      if (input.mealType) {
        conditions.push(
          sql`${entities.aspects}->'orbis/nutrition'->>'meal_type' = ${input.mealType}`,
        );
      }

      const items = await ctx.db
        .select()
        .from(entities)
        .where(and(...conditions))
        .orderBy(desc(entities.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      return { items, total: items.length };
    }),

  // ─── Habits ───

  habitsToday: protectedProcedure.query(async ({ ctx }) => {
    const habitEntities = await ctx.db
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.userId, ctx.userId),
          eq(entities.archived, false),
          sql`${entities.aspects} ? 'orbis/habit'`,
          sql`COALESCE((${entities.aspects}->'orbis/habit'->>'active')::boolean, true) = true`,
        ),
      )
      .orderBy(asc(entities.createdAt));

    type HabitAspect = {
      active?: boolean;
      check_ins?: Array<{ date: string; value?: number; completed: boolean }>;
      current_streak?: number;
    };

    const today = new Date().toISOString().slice(0, 10);

    return habitEntities.map((entity) => {
      const aspects = entity.aspects as Record<string, unknown>;
      const hab = aspects['orbis/habit'] as HabitAspect | undefined;
      const checkIns = Array.isArray(hab?.check_ins) ? hab.check_ins : [];
      const checkedIn = checkIns.some((ci) => ci.date === today && ci.completed);

      // Compute current streak
      let streak = 0;
      const d = new Date();
      for (let i = 0; i < 365; i++) {
        const dateStr = d.toISOString().slice(0, 10);
        if (checkIns.some((ci) => ci.date === dateStr && ci.completed)) {
          streak++;
        } else if (i > 0) {
          break;
        } else {
          // Today not checked in yet — don't break, check yesterday
        }
        d.setDate(d.getDate() - 1);
      }

      return { entity, checkedIn, currentStreak: streak };
    });
  }),

  habitCheckIn: protectedProcedure
    .input(habitCheckInInput)
    .mutation(async ({ input, ctx }) => {
      const [entity] = await ctx.db
        .select()
        .from(entities)
        .where(and(eq(entities.id, input.entityId), eq(entities.userId, ctx.userId)));

      if (!entity) throw new Error('Entity not found');

      const aspects = { ...(entity.aspects as Record<string, Record<string, unknown>>) };
      const habit = { ...(aspects['orbis/habit'] ?? {}) };
      const checkIns = Array.isArray(habit.check_ins)
        ? [...(habit.check_ins as Array<{ date: string; value?: number; completed: boolean }>)]
        : [];

      // Update or add check-in
      const existingIdx = checkIns.findIndex((ci) => ci.date === input.date);
      if (existingIdx >= 0) {
        checkIns[existingIdx] = { date: input.date, value: input.value, completed: input.completed };
      } else {
        checkIns.push({ date: input.date, value: input.value, completed: input.completed });
      }

      // Recompute streaks
      let currentStreak = 0;
      const d = new Date();
      for (let i = 0; i < 365; i++) {
        const dateStr = d.toISOString().slice(0, 10);
        if (checkIns.some((ci) => ci.date === dateStr && ci.completed)) {
          currentStreak++;
        } else if (i > 0) {
          break;
        }
        d.setDate(d.getDate() - 1);
      }

      const bestStreak = Math.max(currentStreak, typeof habit.best_streak === 'number' ? habit.best_streak : 0);

      habit.check_ins = checkIns;
      habit.current_streak = currentStreak;
      habit.best_streak = bestStreak;
      aspects['orbis/habit'] = habit;

      const [updated] = await ctx.db
        .update(entities)
        .set({ aspects, updatedAt: new Date() })
        .where(and(eq(entities.id, input.entityId), eq(entities.userId, ctx.userId)))
        .returning();

      return updated;
    }),

  habitsHistory: protectedProcedure
    .input(habitsHistoryInput)
    .query(async ({ input, ctx }) => {
      const habitEntities = await ctx.db
        .select()
        .from(entities)
        .where(
          and(
            eq(entities.userId, ctx.userId),
            eq(entities.archived, false),
            sql`${entities.aspects} ? 'orbis/habit'`,
            sql`COALESCE((${entities.aspects}->'orbis/habit'->>'active')::boolean, true) = true`,
          ),
        )
        .orderBy(asc(entities.createdAt));

      type HabitAspect = {
        check_ins?: Array<{ date: string; value?: number; completed: boolean }>;
      };

      // Generate date range for last N days
      const dates: string[] = [];
      const d = new Date();
      for (let i = input.days - 1; i >= 0; i--) {
        const day = new Date(d);
        day.setDate(day.getDate() - i);
        dates.push(day.toISOString().slice(0, 10));
      }

      return {
        dates,
        habits: habitEntities.map((entity) => {
          const aspects = entity.aspects as Record<string, unknown>;
          const hab = aspects['orbis/habit'] as HabitAspect | undefined;
          const checkIns = Array.isArray(hab?.check_ins) ? hab.check_ins : [];

          return {
            entity: { id: entity.id, title: entity.title, emoji: entity.emoji },
            checkIns: dates.map((date) => {
              const ci = checkIns.find((c) => c.date === date);
              return { date, completed: ci?.completed ?? false, value: ci?.value };
            }),
          };
        }),
      };
    }),
});
