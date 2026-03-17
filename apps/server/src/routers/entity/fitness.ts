import { router, protectedProcedure } from '../../trpc.ts';
import { fitnessSummaryInput, fitnessWorkoutsInput } from '@orbis/shared';
import { computeFitnessSummary, queryFitnessWorkouts, getFitnessWorkoutTypes } from '../../services/fitness.service.ts';

export const fitnessRouter = router({
  fitnessSummary: protectedProcedure
    .input(fitnessSummaryInput)
    .query(({ input, ctx }) => computeFitnessSummary(ctx.db, ctx.userId, input.year, input.month)),

  fitnessWorkouts: protectedProcedure
    .input(fitnessWorkoutsInput)
    .query(({ input, ctx }) => queryFitnessWorkouts(ctx.db, ctx.userId, input)),

  fitnessWorkoutTypes: protectedProcedure
    .query(({ ctx }) => getFitnessWorkoutTypes(ctx.db, ctx.userId)),
});
