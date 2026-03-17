import { eq, and, sql, desc } from 'drizzle-orm';
import { entities } from '../db/schema.ts';
import type { Database } from '../db/client.ts';
import { getMonthRange } from '../utils/date-range.ts';
import type { NutritionAspect } from '../utils/aspect-types.ts';

export async function computeNutritionSummary(db: Database, userId: string, year: number, month: number) {
  const { start: periodStart, end: periodEnd } = getMonthRange(year, month);

  const nutritionEntities = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.archived, false),
        sql`${entities.aspects} ? 'orbis/nutrition'`,
        sql`${entities.createdAt} >= ${periodStart.toISOString()}::timestamptz`,
        sql`${entities.createdAt} <= ${periodEnd.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(entities.createdAt));

  let totalMeals = 0;
  const typeCounts: Record<string, number> = {};
  const dailyMap: Record<string, { calories: number; protein: number; carbs: number; fat: number }> = {};

  for (const entity of nutritionEntities) {
    const aspects = entity.aspects as Record<string, unknown>;
    const nut = aspects['orbis/nutrition'] as NutritionAspect | undefined;
    if (!nut) continue;

    totalMeals++;

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
}

export async function queryNutritionMeals(
  db: Database,
  userId: string,
  input: { year: number; month: number; date?: string; mealType?: string; limit: number; offset: number },
) {
  const { start: periodStart, end: periodEnd } = getMonthRange(input.year, input.month);

  const conditions = [
    eq(entities.userId, userId),
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

  const items = await db
    .select()
    .from(entities)
    .where(and(...conditions))
    .orderBy(desc(entities.createdAt))
    .limit(input.limit)
    .offset(input.offset);

  return { items, total: items.length };
}
