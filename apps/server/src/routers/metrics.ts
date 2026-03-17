import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { router, protectedProcedure } from '../trpc.ts';
import { entities } from '../db/schema.ts';

const metricConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  aspectId: z.string(),
  field: z.string(),
  aggregation: z.enum(['sum', 'avg', 'count', 'latest']),
  period: z.enum(['today', 'week', 'month']),
  format: z.enum(['number', 'currency', 'percent']).optional(),
});

function getPeriodRange(period: 'today' | 'week' | 'month'): { start: Date; prevStart: Date; prevEnd: Date } {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (period === 'today') {
    const prevStart = new Date(todayStart);
    prevStart.setDate(prevStart.getDate() - 1);
    return { start: todayStart, prevStart, prevEnd: todayStart };
  }

  if (period === 'week') {
    const day = now.getDay();
    const diff = day === 0 ? -6 : 1 - day; // Monday start
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() + diff);
    const prevWeekStart = new Date(weekStart);
    prevWeekStart.setDate(prevWeekStart.getDate() - 7);
    return { start: weekStart, prevStart: prevWeekStart, prevEnd: weekStart };
  }

  // month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { start: monthStart, prevStart: prevMonthStart, prevEnd: monthStart };
}

export const metricsRouter = router({
  getMetrics: protectedProcedure
    .input(z.object({ metrics: z.array(metricConfigSchema) }))
    .query(async ({ input, ctx }) => {
      const results: Array<{ id: string; value: number; previousValue?: number }> = [];

      for (const metric of input.metrics) {
        const { start, prevStart, prevEnd } = getPeriodRange(metric.period);

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

        const fieldPath = `${entities.aspects}->>${sql.raw(`'${metric.aspectId}'`)}->>'${metric.field}'`;

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
            .select({ val: sql<number>`COALESCE(SUM((${sql.raw(fieldPath)})::numeric), 0)` })
            .from(entities)
            .where(and(...conditions));
          const [prev] = await ctx.db
            .select({ val: sql<number>`COALESCE(SUM((${sql.raw(fieldPath)})::numeric), 0)` })
            .from(entities)
            .where(and(...prevConditions));

          results.push({
            id: metric.id,
            value: Number(current.val),
            previousValue: Number(prev.val),
          });
        } else if (metric.aggregation === 'avg') {
          const [current] = await ctx.db
            .select({ val: sql<number>`COALESCE(AVG((${sql.raw(fieldPath)})::numeric), 0)` })
            .from(entities)
            .where(and(...conditions));
          const [prev] = await ctx.db
            .select({ val: sql<number>`COALESCE(AVG((${sql.raw(fieldPath)})::numeric), 0)` })
            .from(entities)
            .where(and(...prevConditions));

          results.push({
            id: metric.id,
            value: Number(current.val),
            previousValue: Number(prev.val),
          });
        } else {
          // latest
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
