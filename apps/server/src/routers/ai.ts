// apps/server/src/routers/ai.ts
// Роутер ai (§9.1): владеет журналом действий — в 1a это Undo (§7.8); sendMessage
// добавит 1b. Обёртки над undoAction/undoLast: их ExecuteResult мапится как у мутаций
// (ошибки → TRPCError); undo-сообщение пишет сам undo-путь тем же tx (internalUndo),
// JournalSink ему не нужен — undo не порождает нового action (undo неотменяем).
import { z } from 'zod';
import { execErrorToTRPC } from '../errors';
import type { ExecuteOk } from '../executor/types';
import { undoAction, undoLast } from '../executor/undo';
import { protectedProcedure, router } from '../trpc';

export const aiRouter = router({
  /** Отмена конкретного действия по id из журнала (§7.8). */
  undo: protectedProcedure
    .input(z.object({ actionId: z.string().uuid() }).strict())
    .mutation(async ({ ctx, input }): Promise<ExecuteOk> => {
      const r = await undoAction(ctx.db, {
        actorUserId: ctx.actorUserId,
        actionId: input.actionId,
      });
      if (!r.ok) throw execErrorToTRPC(r.error);
      return r;
    }),

  /** «Отмени последнее» (§7.8): inverse первого неотменённого действия с конца журнала. */
  undoLast: protectedProcedure.mutation(async ({ ctx }): Promise<ExecuteOk> => {
    const r = await undoLast(ctx.db, { actorUserId: ctx.actorUserId });
    if (!r.ok) throw execErrorToTRPC(r.error);
    return r;
  }),
});
