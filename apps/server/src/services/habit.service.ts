import { eq, and, sql, asc } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { entities } from '../db/schema.ts';
import type { Database } from '../db/client.ts';
import { computeCurrentStreak } from '../utils/streak.ts';
import type { HabitAspect, CheckIn } from '../utils/aspect-types.ts';

export async function getHabitsToday(db: Database, userId: string) {
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

  const today = new Date().toISOString().slice(0, 10);

  return habitEntities.map((entity) => {
    const aspects = entity.aspects as Record<string, unknown>;
    const hab = aspects['orbis/habit'] as HabitAspect | undefined;
    const checkIns = Array.isArray(hab?.check_ins) ? hab.check_ins : [];
    const checkedIn = checkIns.some((ci) => ci.date === today && ci.completed);
    const streak = computeCurrentStreak(checkIns);

    return { entity, checkedIn, currentStreak: streak };
  });
}

export async function checkInHabit(
  db: Database,
  userId: string,
  input: { entityId: string; date: string; completed: boolean; value?: number },
) {
  const [entity] = await db
    .select()
    .from(entities)
    .where(and(eq(entities.id, input.entityId), eq(entities.userId, userId)));

  if (!entity) throw new TRPCError({ code: 'NOT_FOUND', message: 'Entity not found' });

  const aspects = { ...(entity.aspects as Record<string, Record<string, unknown>>) };
  const habit = { ...(aspects['orbis/habit'] ?? {}) };
  const checkIns = Array.isArray(habit.check_ins)
    ? [...(habit.check_ins as CheckIn[])]
    : [];

  const existingIdx = checkIns.findIndex((ci) => ci.date === input.date);
  if (existingIdx >= 0) {
    checkIns[existingIdx] = { date: input.date, value: input.value, completed: input.completed };
  } else {
    checkIns.push({ date: input.date, value: input.value, completed: input.completed });
  }

  const currentStreak = computeCurrentStreak(checkIns);
  const bestStreak = Math.max(currentStreak, typeof habit.best_streak === 'number' ? habit.best_streak : 0);

  habit.check_ins = checkIns;
  habit.current_streak = currentStreak;
  habit.best_streak = bestStreak;
  aspects['orbis/habit'] = habit;

  const [updated] = await db
    .update(entities)
    .set({ aspects, updatedAt: new Date() })
    .where(and(eq(entities.id, input.entityId), eq(entities.userId, userId)))
    .returning();

  return updated;
}

export async function getHabitsHistory(db: Database, userId: string, days: number) {
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

  const dates: string[] = [];
  const d = new Date();
  for (let i = days - 1; i >= 0; i--) {
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
}
