import { eq, and, sql } from 'drizzle-orm';
import { entities } from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';
import { computeFinancialSummary } from '../financial.service.ts';
import { computeFitnessSummary } from '../fitness.service.ts';
import { computeNutritionSummary } from '../nutrition.service.ts';
import { getHabitsToday } from '../habit.service.ts';

export async function buildBudgetSummary(db: Database, userId: string, year: number, month: number) {
  const result = await computeFinancialSummary(db, userId, year, month);
  return { totalIncome: result.totalIncome, totalExpenses: result.totalExpenses, balance: result.balance };
}

export async function buildFitnessSummary(db: Database, userId: string, year: number, month: number) {
  const result = await computeFitnessSummary(db, userId, year, month);
  return {
    workouts: result.totalWorkouts,
    totalVolume: result.totalVolume,
    totalDuration: result.totalDuration,
    avgEffort: result.avgEffort,
  };
}

export async function buildNutritionSummary(db: Database, userId: string, year: number, month: number) {
  const result = await computeNutritionSummary(db, userId, year, month);
  return {
    totalMeals: result.totalMeals,
    dailyAvgCalories: result.dailyAvgCalories,
    dailyAvgProtein: result.dailyAvgProtein,
    dailyAvgCarbs: result.dailyAvgCarbs,
    dailyAvgFat: result.dailyAvgFat,
  };
}

export async function buildHabitsSummary(db: Database, userId: string) {
  const habitsToday = await getHabitsToday(db, userId);
  return {
    habits: habitsToday.map((h) => ({
      name: h.entity.title,
      emoji: h.entity.emoji,
      streak: h.currentStreak,
      checkedInToday: h.checkedIn,
    })),
  };
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
