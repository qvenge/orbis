import { eq, and, sql, desc } from 'drizzle-orm';
import { entities } from '../db/schema.ts';
import type { Database } from '../db/client.ts';
import { getMonthRange } from '../utils/date-range.ts';
import type { FitnessAspect } from '../utils/aspect-types.ts';

export async function computeFitnessSummary(db: Database, userId: string, year: number, month: number) {
  const { start: periodStart, end: periodEnd } = getMonthRange(year, month);

  const fitnessEntities = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.archived, false),
        sql`${entities.aspects} ? 'orbis/fitness'`,
        sql`${entities.createdAt} >= ${periodStart.toISOString()}::timestamptz`,
        sql`${entities.createdAt} <= ${periodEnd.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(entities.createdAt));

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
}

export async function queryFitnessWorkouts(
  db: Database,
  userId: string,
  input: { year: number; month: number; workoutType?: string; limit: number; offset: number },
) {
  const { start: periodStart, end: periodEnd } = getMonthRange(input.year, input.month);

  const conditions = [
    eq(entities.userId, userId),
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

  const items = await db
    .select()
    .from(entities)
    .where(and(...conditions))
    .orderBy(desc(entities.createdAt))
    .limit(input.limit)
    .offset(input.offset);

  return { items, total: items.length };
}

export async function getFitnessWorkoutTypes(db: Database, userId: string) {
  const result = await db
    .select({
      workoutType: sql<string>`DISTINCT ${entities.aspects}->'orbis/fitness'->>'workout_type'`,
    })
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.archived, false),
        sql`${entities.aspects} ? 'orbis/fitness'`,
        sql`${entities.aspects}->'orbis/fitness'->>'workout_type' IS NOT NULL`,
      ),
    );

  return result.map((r) => r.workoutType).filter(Boolean);
}
