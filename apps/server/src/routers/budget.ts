// apps/server/src/routers/budget.ts
// Роутер budget (03-budget) — ЗАГОТОВКА Task A5: единственная процедура postDue
// (переход planned→fact recurring-инстансов §2.8; web зовёт при маунте Budget/Agenda).
// Агрегаты Overview и остальное наполнение — Task A6 (там же postDue встанет в начало
// budget.overview: «при первом открытии или финансовом запросе»).
import { eq } from 'drizzle-orm';
import { userSettings } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { DEFAULT_TIMEZONE, isValidTimeZone } from '../query/context';
import { postDueInstances } from '../recurring/post-due';
import { ownerOnlyProcedure, router } from '../trpc';

export const budgetRouter = router({
  // Мутация состояния графа → ownerOnlyProcedure (§9.3): переход исполняет владелец.
  postDue: ownerOnlyProcedure.mutation(async ({ ctx }): Promise<{ posted: number }> => {
    // «Сегодня» — локальная дата пользователя (user_settings.timezone, как queryContext);
    // мусорная зона из БД деградирует до дефолта, не роняя запрос
    const today = await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
      const rows = await tx
        .select({ timezone: userSettings.timezone })
        .from(userSettings)
        .where(eq(userSettings.ownerId, ctx.actorUserId));
      const stored = rows[0]?.timezone ?? DEFAULT_TIMEZONE;
      const timezone = isValidTimeZone(stored) ? stored : DEFAULT_TIMEZONE;
      return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
    });
    return postDueInstances({ db: ctx.db, ownerId: ctx.actorUserId, today });
  }),
});
