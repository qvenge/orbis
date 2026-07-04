// apps/server/src/routers/ai.ts
// Роутер ai (§9.1): владеет журналом действий — Undo (§7.8) и pending-подтверждения
// (§7.10, Task 6); sendMessage добавит 1b. Обёртки над undoAction/undoLast и
// approvePending/rejectPending: их структурированные результаты мапятся как у мутаций
// (ошибки → TRPCError); undo-сообщение пишет сам undo-путь тем же tx (internalUndo),
// JournalSink ему не нужен — undo не порождает нового action (undo неотменяем).
// approve/reject — ownerOnly (§9.3): подтверждение — решение владельца аккаунта;
// PAT-агент не может одобрить собственный (или чужой) pending другим транспортом.
import { z } from 'zod';
import { execErrorToTRPC } from '../errors';
import type { ExecuteOk } from '../executor/types';
import { undoAction, undoLast } from '../executor/undo';
import { approvePending, rejectPending } from '../policy/pending';
import { ownerOnlyProcedure, protectedProcedure, router } from '../trpc';

const pendingIdInput = z.object({ pendingId: z.string().uuid() }).strict();

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

  /**
   * Одобрение pending-подтверждения (§7.10): исполняет сохранённый payload полным
   * конвейером executor'а (ревалидация текущего состояния), без обращения к LLM;
   * повторный approve — идемпотентный replay по PK audit-сообщения (§7.8).
   */
  approve: ownerOnlyProcedure
    .input(pendingIdInput)
    .mutation(async ({ ctx, input }): Promise<ExecuteOk> => {
      const r = await approvePending(ctx.db, {
        ownerId: ctx.actorUserId,
        pendingId: input.pendingId,
      });
      if (!r.ok) throw execErrorToTRPC(r.error);
      return r;
    }),

  /** Отклонение pending-подтверждения (§7.10): reject-сообщение в тред карточки. */
  reject: ownerOnlyProcedure.input(pendingIdInput).mutation(async ({ ctx, input }) => {
    const r = await rejectPending(ctx.db, {
      ownerId: ctx.actorUserId,
      pendingId: input.pendingId,
    });
    if (!r.ok) throw execErrorToTRPC(r.error);
    return { pendingId: r.pendingId, alreadyRejected: r.alreadyRejected };
  }),
});
