import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc.ts';
import { entities } from '../db/schema.ts';
import { getRelativePeriodRange } from '../utils/date-range.ts';

const SAFE_IDENTIFIER = /^[a-z0-9/_-]+$/;

const metricConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  aspectId: z.string(),
  field: z.string(),
  aggregation: z.enum(['sum', 'avg', 'count', 'latest']),
  period: z.enum(['today', 'week', 'month']),
  format: z.enum(['number', 'currency', 'percent']).optional(),
});

export const metricsRouter = router({
  getMetrics: protectedProcedure
    .input(z.object({ metrics: z.array(metricConfigSchema) }))
    .query(async ({ input, ctx }) => {
      const results: Array<{ id: string; value: number; previousValue?: number }> = [];

      for (const metric of input.metrics) {
        // Validate identifiers to prevent SQL injection
        if (!SAFE_IDENTIFIER.test(metric.aspectId) || !SAFE_IDENTIFIER.test(metric.field)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid metric field identifier' });
        }

        const { start, prevStart, prevEnd } = getRelativePeriodRange(metric.period);

        const conditions = [
          eq(entities.userId, ctx.userId),
          eq(entities.archived, false),
          sql`${entities.aspects} ? ${metric.aspectId}`,
          sql`${entities.createdAt} >= ${start.toISOString()}::timestamptz`,
        ];

        const prevConditions = [
          eq(entities.userId, ctx.userId),
          eq(entities.archived, false),
          sql`${entities.aspects} ? ${metric.aspectId}`,
          sql`${entities.createdAt} >= ${prevStart.toISOString()}::timestamptz`,
          sql`${entities.createdAt} < ${prevEnd.toISOString()}::timestamptz`,
        ];

        // Use parameterized JSON operators instead of sql.raw()
        const fieldExpr = sql`(${entities.aspects}->${metric.aspectId}->>${metric.field})`;

        if (metric.aggregation === 'count') {
          const [current] = await ctx.db
            .select({ val: sql<number>`count(*)` })
            .from(entities)
            .where(and(...conditions));
          const [prev] = await ctx.db
            .select({ val: sql<number>`count(*)` })
            .from(entities)
            .where(and(...prevConditions));

          results.push({
            id: metric.id,
            value: Number(current.val),
            previousValue: Number(prev.val),
          });
        } else if (metric.aggregation === 'sum') {
          const [current] = await ctx.db
            .select({ val: sql<number>`COALESCE(SUM((${fieldExpr})::numeric), 0)` })
            .from(entities)
            .where(and(...conditions));
          const [prev] = await ctx.db
            .select({ val: sql<number>`COALESCE(SUM((${fieldExpr})::numeric), 0)` })
            .from(entities)
            .where(and(...prevConditions));

          results.push({
            id: metric.id,
            value: Number(current.val),
            previousValue: Number(prev.val),
          });
        } else if (metric.aggregation === 'avg') {
          const [current] = await ctx.db
            .select({ val: sql<number>`COALESCE(AVG((${fieldExpr})::numeric), 0)` })
            .from(entities)
            .where(and(...conditions));
          const [prev] = await ctx.db
            .select({ val: sql<number>`COALESCE(AVG((${fieldExpr})::numeric), 0)` })
            .from(entities)
            .where(and(...prevConditions));

          results.push({
            id: metric.id,
            value: Number(current.val),
            previousValue: Number(prev.val),
          });
        } else {
          // latest — read from application layer to avoid SQL complexity
          const items = await ctx.db
            .select({ aspects: entities.aspects })
            .from(entities)
            .where(and(...conditions))
            .orderBy(sql`${entities.createdAt} DESC`)
            .limit(1);

          let value = 0;
          if (items.length > 0) {
            const aspects = items[0].aspects as Record<string, Record<string, unknown>>;
            const aspectData = aspects[metric.aspectId];
            if (aspectData) value = Number(aspectData[metric.field]) || 0;
          }

          results.push({ id: metric.id, value });
        }
      }

      return results;
    }),
});
