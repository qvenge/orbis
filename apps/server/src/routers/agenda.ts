// apps/server/src/routers/agenda.ts
// Роутер agenda (§А5-5, §Б5-6): одна ручка поверхности «Повестка». Роутер — ТОЛЬКО трансляция
// (правило 8 impl-00): выборку держит движок подписки, декларацию — реестр подписок.
import { type AgendaListResult, addDays, agendaListInput } from '@orbis/shared';
import { withIdentity } from '../db/with-identity';
import { ExecError, execErrorToTRPC } from '../errors';
import { ownerTimeZone, queryContext, todayInTimeZone } from '../query/context';
import { materializeInstances } from '../recurring/materialize';
import { agendaListOf, agendaSubscriptionOf } from '../subscriptions/agenda';
import { protectedProcedure, router } from '../trpc';

export const agendaRouter = router({
  /**
   * Повестка одним вызовом. Материализация повторяющихся идёт ДО выборки и МЕЖДУ транзакциями
   * (executor открывает свои — вложенность истощала бы пул), окно берётся из горизонта
   * подписки, а не из дерева запроса: дерева у подписки нет (Р-К-12; урок `materialize.ts:31-36`
   * — без этого повторяющаяся задача в окне просто не появлялась).
   */
  list: protectedProcedure
    .input(agendaListInput)
    .query(async ({ ctx, input }): Promise<AgendaListResult> => {
      try {
        const { today, timeZone } = await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
          const tz = await ownerTimeZone(tx, ctx.actorUserId);
          return { today: todayInTimeZone(tz), timeZone: tz };
        });
        await materializeInstances({
          db: ctx.db,
          ownerId: ctx.actorUserId,
          from: today,
          to: addDays(today, input.days - 1),
          today,
        });
        return await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
          const cctx = await queryContext(tx, ctx.actorUserId, null);
          return agendaListOf(tx, ctx.actorUserId, agendaSubscriptionOf(cctx.reg), {
            today,
            timeZone,
            days: input.days,
          });
        });
      } catch (e) {
        // SLOT_AMBIGUOUS (§С8-21), незасеянная подписка, отказ компиляции — структурно
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),
});
