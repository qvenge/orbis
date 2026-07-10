// apps/server/src/routers/budget.ts
// Роутер budget (03-budget, Task A5+A6): агрегаты Overview на лету + переход
// planned→fact. Роутер — ТОЛЬКО трансляция (правило 8 impl-00): формулы и SQL живут
// в budget/aggregates.ts, мутации идут через executor внутри postDueInstances.
import {
  type BudgetOverview,
  budgetOverviewInput,
  type CategoryTrendPoint,
  categoryTrendInput,
  type EnvelopeStatus,
  envelopeForCategoryInput,
} from '@orbis/shared';
import {
  budgetOverview,
  categoryTrend,
  envelopeForCategory,
  localToday,
} from '../budget/aggregates';
import { postDueInstances } from '../recurring/post-due';
import { ownerOnlyProcedure, protectedProcedure, router } from '../trpc';

export const budgetRouter = router({
  /**
   * Overview месяца (§3.1). Сначала конвейер §2.8 (postDue + материализация окна
   * [today; today+14]) — «при первом открытии или финансовом запросе», затем агрегаты.
   * Чтение → protectedProcedure (системные due-переходы внутри — идемпотентные
   * batch'и executor'а от имени владельца, не пользовательская мутация).
   */
  overview: protectedProcedure
    .input(budgetOverviewInput)
    .query(({ ctx, input }): Promise<BudgetOverview> => {
      return budgetOverview(ctx.db, ctx.actorUserId, input.month);
    }),

  /** Мини-тренд категории (§3.2): spent/limit по месяцам конвертов категории. */
  categoryTrend: protectedProcedure
    .input(categoryTrendInput)
    .query(({ ctx, input }): Promise<CategoryTrendPoint[]> => {
      return categoryTrend(ctx.db, ctx.actorUserId, input);
    }),

  /** Конверт категории на дату — fast-path-карточка «осталось N ₽» (§4.1) и quick-add. */
  envelopeForCategory: protectedProcedure
    .input(envelopeForCategoryInput)
    .query(({ ctx, input }): Promise<EnvelopeStatus | null> => {
      return envelopeForCategory(ctx.db, ctx.actorUserId, input);
    }),

  // Мутация состояния графа → ownerOnlyProcedure (§9.3): переход исполняет владелец.
  postDue: ownerOnlyProcedure.mutation(async ({ ctx }): Promise<{ posted: number }> => {
    // «Сегодня» — локальная дата пользователя (user_settings.timezone), как в агрегатах
    const today = await localToday(ctx.db, ctx.actorUserId);
    return postDueInstances({ db: ctx.db, ownerId: ctx.actorUserId, today });
  }),
});
