// apps/server/src/routers/budget.ts
// Роутер budget (03-budget, Task A5+A6+A7): агрегаты Overview на лету, переход
// planned→fact и rollover. Роутер — ТОЛЬКО трансляция (правило 8 impl-00): формулы и
// SQL живут в budget/aggregates.ts, мутации идут через executor (postDueInstances,
// rolloverCreate).
import {
  type BudgetOverview,
  budgetOverviewInput,
  type CategoryTrendPoint,
  type ConfirmPurchaseResult,
  categoryTrendInput,
  confirmPurchaseInput,
  type EnvelopeStatus,
  envelopeForCategoryInput,
  type RolloverPreview,
  type RolloverResult,
  rolloverInput,
  rolloverPreviewInput,
} from '@orbis/shared';
import {
  budgetOverview,
  categoryTrend,
  envelopeForCategory,
  localToday,
  rolloverCreate,
  rolloverPreview,
} from '../budget/aggregates';
import { confirmPurchase } from '../budget/plan-to-fact';
import { ExecError, execErrorToTRPC } from '../errors';
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

  /** Превью rollover (§2.6, §3.5): carryover/suggestedLimit по прошлому месяцу — чтение. */
  rolloverPreview: protectedProcedure
    .input(rolloverPreviewInput)
    .query(({ ctx, input }): Promise<RolloverPreview> => {
      return rolloverPreview(ctx.db, ctx.actorUserId, input.month);
    }),

  /**
   * Создание конвертов нового периода одним batch_execute (§3.5) — мутация владельца
   * (§9.3). Структурированные отказы (INVARIANT пречека и executor'а) → TRPCError.
   */
  rollover: ownerOnlyProcedure
    .input(rolloverInput)
    .mutation(async ({ ctx, input }): Promise<RolloverResult> => {
      try {
        return await rolloverCreate(ctx.db, ctx.actorUserId, input);
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /**
   * Перевод planned-покупки в факт одним batch (§2.7, §7.6) — мутация владельца (§9.3).
   * Структурированные отказы (INVARIANT пречека и executor'а) → TRPCError.
   */
  confirmPurchase: ownerOnlyProcedure
    .input(confirmPurchaseInput)
    .mutation(async ({ ctx, input }): Promise<ConfirmPurchaseResult> => {
      try {
        return await confirmPurchase(ctx.db, ctx.actorUserId, input);
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  // Мутация состояния графа → ownerOnlyProcedure (§9.3): переход исполняет владелец.
  postDue: ownerOnlyProcedure.mutation(async ({ ctx }): Promise<{ posted: number }> => {
    // «Сегодня» — локальная дата пользователя (user_settings.timezone), как в агрегатах
    const today = await localToday(ctx.db, ctx.actorUserId);
    return postDueInstances({ db: ctx.db, ownerId: ctx.actorUserId, today });
  }),
});
