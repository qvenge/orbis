// apps/server/src/routers/ai.ts
// Роутер ai (§9.1): LLM-диалог (sendMessage — tool-цикл Task 9), журнал действий —
// Undo (§7.8) и pending-подтверждения (§7.10, Task 6). Обёртки над undoAction/undoLast
// и approvePending/rejectPending: их структурированные результаты мапятся как у мутаций
// (ошибки → TRPCError); запись отмены пишет сам undo-путь тем же tx (internalUndo, путь `ui` —
// кнопка владельца) — undo не порождает нового action (undo неотменяем).
// approve/reject и sendMessage — ownerOnly (§9.3): подтверждение — решение владельца
// аккаунта; внутренний чат — владельческая поверхность: действия sendMessage
// атрибутируются актором 'ai' (§7.8), что верно только для чата владельца —
// PAT-агент работает своим транспортом (MCP, Task 10) с честной атрибуцией 'agent'.
import type { UndoResult } from '@orbis/shared';
import { z } from 'zod';
import { declineRuleSuggestion, RULE_PATTERN_MAX } from '../ai/escalation';
import { defaultAiDeps, type SendMessageResult, sendMessage } from '../ai/send-message';
import { ExecError, execErrorToTRPC } from '../errors';

import { type UndoLastResult, undoAction, undoLast } from '../executor/undo';
import { approvePending, rejectPending } from '../policy/pending';
import { ownerOnlyProcedure, router } from '../trpc';

const pendingIdInput = z.object({ pendingId: z.string().uuid() }).strict();

export const aiRouter = router({
  /**
   * LLM-диалог (Task 9): обычная мутация, ответ целиком (§7.7 D7 — без стриминга).
   * Тело — ai/send-message.ts; deps (провайдер/модель/резолвер §8) — из request-
   * контекста (index.ts / инъекция тестов); отсутствие ctx.ai — дефект DI, а не
   * фолбэк: defaultAiDeps() бросает (fail-fast), боевой путь всегда инжектит ai.
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
          identity: ctx.identity,
          ...input,
        });
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /**
   * Отмена конкретного действия по id из журнала (§7.8) — плашка, Ctrl/Cmd+Z, карточка действия в треде, «Вернуть текст
   * как на …» (путь `ui`). Правило §8.6: текст изменён после отменяемой правки — `CONFLICT` с `data.orbis.code =
   * 'UNDO_TEXT_CHANGED'` и местом продолжения `here`; продолжение «Всё равно отменить» — тот же запрос с `force: true`
   * (Р-15). Повторная отмена — `BAD_REQUEST`, `data.orbis.details.reason = 'already_undone'`. Ответ — `UndoResult`:
   * id записи отмены, что отменено, закреплённые версии (подтверждение называет их владельцу).
   */
  undo: ownerOnlyProcedure
    .input(z.object({ actionId: z.string().uuid(), force: z.literal(true).optional() }).strict())
    .mutation(async ({ ctx, input }): Promise<UndoResult> => {
      const r = await undoAction(ctx.db, {
        identity: ctx.identity,
        actionId: input.actionId,
        path: 'ui',
        force: input.force === true,
        continuation: { kind: 'here' },
      });
      if (!r.ok) throw execErrorToTRPC(r.error);
      return {
        actionId: r.actionId,
        undone: r.undone,
        pinnedVersions: r.pinnedVersions,
        bodyRevisions: r.bodyRevisions,
      };
    }),

  /**
   * «Отмени последнее» (§7.8): inverse первого неотменённого действия с конца журнала. Кнопка владельца (путь `ui`);
   * своего продолжения у «отмени последнее» нет — отказ правила §8.6 называет место `here`: продолжение с того же
   * экрана — точечная отмена `ai.undo({actionId: details.action.id, force: true})` (отказ называет, что отменялось).
   * «Отмени последнее» СЛОВАМИ в чате — другой путь (тул `undo_last`): continuationOf выбирает карточку, вкладку или
   * «карточки нет»; у сменённого сеанса — none (R-23/R-27). menu оставлен в типе ради совместимости, но не производится.
   * Решение заменить текст — только у человека.
   */
  undoLast: ownerOnlyProcedure.mutation(
    async ({ ctx }): Promise<Extract<UndoLastResult, { ok: true }>> => {
      const r = await undoLast(ctx.db, {
        identity: ctx.identity,
        path: 'ui',
        continuation: { kind: 'here' },
      });
      if (!r.ok) throw execErrorToTRPC(r.error);
      return r;
    },
  ),

  /**
   * Одобрение pending-подтверждения (§7.10): исполняет сохранённый payload полным
   * конвейером executor'а (ревалидация текущего состояния), без обращения к LLM;
   * повторный approve — идемпотентный replay по ключу записи журнала пачки (§7.8).
   */
  approve: ownerOnlyProcedure
    .input(pendingIdInput)
    .mutation(
      async ({
        ctx,
        input,
      }): Promise<Exclude<Awaited<ReturnType<typeof approvePending>>, { ok: false }>> => {
        const r = await approvePending(ctx.db, {
          identity: ctx.identity,
          pendingId: input.pendingId,
        });
        if (!r.ok) throw execErrorToTRPC(r.error);
        return r;
      },
    ),

  /**
   * Отклонение pending-подтверждения (§7.10): reject-сообщение в тред карточки.
   * Причина входом НЕ принимается: через эту процедуру отказывает владелец кнопкой, и
   * это всегда 'owner' — 'superseded'/'stale' проставляет раннер рутины, зовя
   * rejectPending напрямую. В ответе причина есть (V1.8): при повторном отказе она
   * ИСХОДНАЯ, и клиенту важно отличить «владелец отказался» от «уже заменено».
   */
  reject: ownerOnlyProcedure.input(pendingIdInput).mutation(async ({ ctx, input }) => {
    const r = await rejectPending(ctx.db, {
      identity: ctx.identity,
      pendingId: input.pendingId,
    });
    if (!r.ok) throw execErrorToTRPC(r.error);
    return { pendingId: r.pendingId, alreadyRejected: r.alreadyRejected, reason: r.reason };
  }),

  /**
   * Отказ от предложенного правила памяти (§7.8, кнопка «Не надо» D3b): журнал
   * append-only — пишется новое системное сообщение с карточкой memory_rule_declined
   * (K4), оно же подавляет повторное предложение по этой паре. Кнопка «Запомнить»
   * своей процедуры НЕ имеет: правило создаётся обычным entity.create.
   */
  declineMemoryRule: ownerOnlyProcedure
    .input(
      z
        .object({
          // Потолок — защита JSONB, не бизнес-правило (конвенция слоя, ср. bank_txn_id):
          // значение ложится в append-only chat_messages и читается каждым подавлением.
          // ОТВЕРГАТЬ длинный паттерн здесь нельзя: карточки-предложения писались до
          // появления границы (журнал append-only), и «Не надо» на такой карточке
          // отвечало бы 400 навсегда. Усекаем — ключ подавления считается по СХОДСТВУ,
          // усечение его не ломает.
          pattern: z
            .string()
            .min(1)
            .transform((p) => p.slice(0, RULE_PATTERN_MAX)),
          fromCategoryId: z.string().uuid(),
          toCategoryId: z.string().uuid(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await declineRuleSuggestion(ctx.db, { identity: ctx.identity, ...input });
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),
});
