import { router, protectedProcedure } from '../../trpc.ts';
import { financialSummaryInput, financialTransactionsInput } from '@orbis/shared';
import { computeFinancialSummary, queryFinancialTransactions, getFinancialCategories } from '../../services/financial.service.ts';

export const financialRouter = router({
  financialSummary: protectedProcedure
    .input(financialSummaryInput)
    .query(({ input, ctx }) => computeFinancialSummary(ctx.db, ctx.userId, input.year, input.month)),

  financialTransactions: protectedProcedure
    .input(financialTransactionsInput)
    .query(({ input, ctx }) => queryFinancialTransactions(ctx.db, ctx.userId, input)),

  financialCategories: protectedProcedure
    .query(({ ctx }) => getFinancialCategories(ctx.db, ctx.userId)),
});
