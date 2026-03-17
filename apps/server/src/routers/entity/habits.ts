import { router, protectedProcedure } from '../../trpc.ts';
import { habitCheckInInput, habitsHistoryInput } from '@orbis/shared';
import { getHabitsToday, checkInHabit, getHabitsHistory } from '../../services/habit.service.ts';

export const habitsRouter = router({
  habitsToday: protectedProcedure
    .query(({ ctx }) => getHabitsToday(ctx.db, ctx.userId)),

  habitCheckIn: protectedProcedure
    .input(habitCheckInInput)
    .mutation(({ input, ctx }) => checkInHabit(ctx.db, ctx.userId, input)),

  habitsHistory: protectedProcedure
    .input(habitsHistoryInput)
    .query(({ input, ctx }) => getHabitsHistory(ctx.db, ctx.userId, input.days)),
});
