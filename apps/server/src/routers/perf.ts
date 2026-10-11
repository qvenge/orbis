// perf.report (спека скорости §3.2): пачка полевых замеров владельца. Не граф и не журнал — прямая вставка в свою
// таблицу, писатель у неё один (этот роутер); RLS — по аккаунту (0024).
import { type PerfReportResult, perfReportInput } from '@orbis/shared';
import { and, eq, gt, sql } from 'drizzle-orm';
import { perfSamples } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { roomToday, takeBatchSlot } from '../perf/rate-limit';
import { ownerOnlyProcedure, router } from '../trpc';

/**
 * Приём пачки: минутный потолок — в памяти процесса, суточный — пробой `count(*)` по аккаунту за сутки в той же
 * транзакции, что вставка. Две пачки одного аккаунта, пришедшие одновременно у суточного потолка, видят один и тот же
 * остаток, и перебор возможен на одну пачку (≤ 100 строк): замок ради замеров не берётся — цена перебора ничтожна, а
 * таблицу держит и минутный потолок. Агенту ручка закрыта (`ownerOnlyProcedure`): замер — про устройство владельца.
 */
export const perfRouter = router({
  report: ownerOnlyProcedure
    .input(perfReportInput)
    .mutation(async ({ ctx, input }): Promise<PerfReportResult> => {
      const account = ctx.identity.actor;
      // Лишнее отбрасывается с ответом, а не отказом: клиент не повторяет замеры (РП-26).
      if (!takeBatchSlot(account, Date.now()))
        return { accepted: 0, dropped: input.samples.length };
      return withIdentity(ctx.db, ctx.identity, async (tx) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(perfSamples)
          .where(
            and(
              eq(perfSamples.accountId, account),
              gt(perfSamples.createdAt, sql`now() - interval '1 day'`),
            ),
          );
        const kept = input.samples.slice(0, roomToday(row?.n ?? 0));
        if (kept.length > 0) {
          await tx.insert(perfSamples).values(
            kept.map((s) => ({
              metric: s.metric,
              screen: s.screen ?? null,
              kind: s.kind ?? null,
              procedure: s.procedure ?? null,
              durMs: s.durMs,
              serverMs: s.serverMs ?? null,
              dbMs: s.dbMs ?? null,
              device: s.device,
              net: s.net ?? null,
              appVersion: s.appVersion,
              cached: s.cached ?? null,
            })),
          );
        }
        return { accepted: kept.length, dropped: input.samples.length - kept.length };
      });
    }),
});
