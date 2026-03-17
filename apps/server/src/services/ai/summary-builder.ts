import { eq, and, sql, asc } from 'drizzle-orm';
import { entities } from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';

export async function buildBudgetSummary(db: Database, userId: string, year: number, month: number) {
  const periodStart = new Date(year, month - 1, 1);
  const periodEnd = new Date(year, month, 0, 23, 59, 59, 999);

  const financialEntities = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.archived, false),
        sql`${entities.aspects} ? 'orbis/financial'`,
        sql`${entities.createdAt} >= ${periodStart.toISOString()}::timestamptz`,
        sql`${entities.createdAt} <= ${periodEnd.toISOString()}::timestamptz`,
      ),
    );

  let totalIncome = 0;
  let totalExpenses = 0;

  for (const entity of financialEntities) {
    const aspects = entity.aspects as Record<string, Record<string, unknown>>;
    const fin = aspects['orbis/financial'];
    if (!fin || typeof fin.amount !== 'number') continue;
    const direction = fin.direction ?? 'expense';
    if (direction === 'income') totalIncome += fin.amount;
    else if (direction === 'expense') totalExpenses += fin.amount;
  }

  return { totalIncome, totalExpenses, balance: totalIncome - totalExpenses };
}

export async function buildFitnessSummary(db: Database, userId: string, year: number, month: number) {
  const periodStart = new Date(year, month - 1, 1);
  const periodEnd = new Date(year, month, 0, 23, 59, 59, 999);

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
    );

  type FitnessAspect = {
    duration_min?: number;
    perceived_effort?: number;
    total_volume_kg?: number;
    exercises?: Array<{ sets: number; reps: number; weight_kg: number }>;
  };

  let workouts = 0;
  let totalVolume = 0;
  let totalDuration = 0;
  let totalEffort = 0;
  let effortCount = 0;

  for (const entity of fitnessEntities) {
    const aspects = entity.aspects as Record<string, unknown>;
    const fit = aspects['orbis/fitness'] as FitnessAspect | undefined;
    if (!fit) continue;

    workouts++;

    const volume =
      typeof fit.total_volume_kg === 'number'
        ? fit.total_volume_kg
        : Array.isArray(fit.exercises)
          ? fit.exercises.reduce((s, e) => s + (e.sets || 0) * (e.reps || 0) * (e.weight_kg || 0), 0)
          : 0;
    totalVolume += volume;

    if (typeof fit.duration_min === 'number') totalDuration += fit.duration_min;
    if (typeof fit.perceived_effort === 'number') {
      totalEffort += fit.perceived_effort;
      effortCount++;
    }
  }

  return {
    workouts,
    totalVolume: Math.round(totalVolume),
    totalDuration,
    avgEffort: effortCount > 0 ? Math.round((totalEffort / effortCount) * 10) / 10 : 0,
  };
}

export async function buildNutritionSummary(db: Database, userId: string, year: number, month: number) {
  const periodStart = new Date(year, month - 1, 1);
  const periodEnd = new Date(year, month, 0, 23, 59, 59, 999);

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
    );

  type NutritionAspect = {
    total_calories?: number;
    total_protein?: number;
    total_carbs?: number;
    total_fat?: number;
    items?: Array<{ calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number }>;
  };

  let totalMeals = 0;
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

    const dateKey = entity.createdAt.toISOString().slice(0, 10);
    if (!dailyMap[dateKey]) dailyMap[dateKey] = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    dailyMap[dateKey].calories += cal;
    dailyMap[dateKey].protein += pro;
    dailyMap[dateKey].carbs += carb;
    dailyMap[dateKey].fat += fat;
  }

  const days = Object.values(dailyMap);
  const numDays = days.length || 1;

  return {
    totalMeals,
    dailyAvgCalories: Math.round(days.reduce((s, d) => s + d.calories, 0) / numDays),
    dailyAvgProtein: Math.round(days.reduce((s, d) => s + d.protein, 0) / numDays),
    dailyAvgCarbs: Math.round(days.reduce((s, d) => s + d.carbs, 0) / numDays),
    dailyAvgFat: Math.round(days.reduce((s, d) => s + d.fat, 0) / numDays),
  };
}

export async function buildHabitsSummary(db: Database, userId: string) {
  const habitEntities = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.archived, false),
        sql`${entities.aspects} ? 'orbis/habit'`,
        sql`COALESCE((${entities.aspects}->'orbis/habit'->>'active')::boolean, true) = true`,
      ),
    )
    .orderBy(asc(entities.createdAt));

  type CheckIn = { date: string; value?: number; completed: boolean };

  const today = new Date().toISOString().slice(0, 10);

  const habits = habitEntities.map((entity) => {
    const aspects = entity.aspects as Record<string, Record<string, unknown>>;
    const hab = aspects['orbis/habit'] ?? {};
    const checkIns = Array.isArray(hab.check_ins) ? (hab.check_ins as CheckIn[]) : [];
    const checkedInToday = checkIns.some((ci) => ci.date === today && ci.completed);

    let streak = 0;
    const d = new Date();
    for (let i = 0; i < 365; i++) {
      const dateStr = d.toISOString().slice(0, 10);
      if (checkIns.some((ci) => ci.date === dateStr && ci.completed)) {
        streak++;
      } else if (i > 0) {
        break;
      }
      d.setDate(d.getDate() - 1);
    }

    return {
      name: entity.title,
      emoji: entity.emoji,
      streak,
      checkedInToday,
    };
  });

  return { habits };
}

export async function buildDaySummary(db: Database, userId: string, date: string) {
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;

  const dayEntities = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.archived, false),
        sql`${entities.createdAt} >= ${dayStart}::timestamptz`,
        sql`${entities.createdAt} <= ${dayEnd}::timestamptz`,
      ),
    );

  let tasks = 0;
  let completed = 0;
  let events = 0;

  for (const entity of dayEntities) {
    const aspects = entity.aspects as Record<string, Record<string, unknown>>;
    if (aspects['orbis/task']) {
      tasks++;
      if (aspects['orbis/task'].status === 'done') completed++;
    }
    if (aspects['orbis/schedule']) {
      events++;
    }
  }

  return { date, tasks, completed, events };
}

export async function buildWeekSummary(db: Database, userId: string, weekStartDate: string) {
  const start = new Date(weekStartDate + 'T00:00:00');
  const days: Array<{ date: string; weekday: string; tasks: number; events: number }> = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
    const summary = await buildDaySummary(db, userId, dateStr);
    days.push({ date: dateStr, weekday, tasks: summary.tasks, events: summary.events });
  }

  return { days };
}
