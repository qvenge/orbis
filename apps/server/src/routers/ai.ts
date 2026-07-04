// apps/server/src/routers/ai.ts
// Роутер ai (§9.1): LLM-диалог (sendMessage — tool-цикл Task 9), журнал действий —
// Undo (§7.8) и pending-подтверждения (§7.10, Task 6). Обёртки над undoAction/undoLast
// и approvePending/rejectPending: их структурированные результаты мапятся как у мутаций
// (ошибки → TRPCError); undo-сообщение пишет сам undo-путь тем же tx (internalUndo),
// JournalSink ему не нужен — undo не порождает нового action (undo неотменяем).
// approve/reject и sendMessage — ownerOnly (§9.3): подтверждение — решение владельца
// аккаунта; внутренний чат — владельческая поверхность: действия sendMessage
// атрибутируются актором 'ai' (§7.8), что верно только для чата владельца —
// PAT-агент работает своим транспортом (MCP, Task 10) с честной атрибуцией 'agent'.
import { z } from 'zod';
import { defaultAiDeps, type SendMessageResult, sendMessage } from '../ai/send-message';
import { ExecError, execErrorToTRPC } from '../errors';
import type { ExecuteOk } from '../executor/types';
import { undoAction, undoLast } from '../executor/undo';
import { approvePending, rejectPending } from '../policy/pending';
import { ownerOnlyProcedure, protectedProcedure, router } from '../trpc';

const pendingIdInput = z.object({ pendingId: z.string().uuid() }).strict();

export const aiRouter = router({
  /**
   * LLM-диалог (Task 9): обычная мутация, ответ целиком (§7.7 D7 — без стриминга).
   * Тело — ai/send-message.ts; deps (провайдер/модель/резолвер §8) — из request-
   * контекста (index.ts / инъекция тестов), фолбэк — боевые deps по env.
   * Доменные отказы (NOT_FOUND треда, LIMIT §8, LLM_UNAVAILABLE §7.9) → TRPCError.
   */
  sendMessage: ownerOnlyProcedure
    .input(
      z
        .object({
          id: z.string().uuid(), // client-generated UUID user-сообщения (§2.1)
          threadId: z.string().uuid(),
          content: z.string().min(1),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }): Promise<SendMessageResult> => {
      try {
        return await sendMessage(ctx.db, ctx.ai ?? defaultAiDeps(), {
          ownerId: ctx.actorUserId,
          ...input,
        });
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

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
