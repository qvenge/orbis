import { router, protectedProcedure } from '../../trpc.ts';
import { nutritionSummaryInput, nutritionMealsInput } from '@orbis/shared';
import { computeNutritionSummary, queryNutritionMeals } from '../../services/nutrition.service.ts';

export const nutritionRouter = router({
  nutritionSummary: protectedProcedure
    .input(nutritionSummaryInput)
    .query(({ input, ctx }) => computeNutritionSummary(ctx.db, ctx.userId, input.year, input.month)),

  nutritionMeals: protectedProcedure
    .input(nutritionMealsInput)
    .query(({ input, ctx }) => queryNutritionMeals(ctx.db, ctx.userId, input)),
});
