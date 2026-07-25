// apps/server/src/routers/import.ts
// Роутер импорта CSV (03-budget §3.4): analyze → review → confirm. Роутер — ТОЛЬКО
// трансляция (правило 8 impl-00): логика, SQL и обращения к исполнителю живут в
// import/review.ts, структурированные отказы (ExecError) маппятся в TRPCError.
//
// Все три процедуры — ownerOnlyProcedure (§9.3): импорт по определению путь владельца,
// LLM/MCP этот роутер не зовут (карточка import_review в чате инициирует тот же
// клиентский флоу от имени владельца).
//
// Почему analyze/review объявлены .mutation(), хотя ничего не мутируют: их вход —
// сотни канонических строк выписки, а tRPC-query уезжает в URL (лимит длины URL и
// логирование содержимого выписки прокси). Это осознанное решение, а не недосмотр.
import {
  type ImportAnalyzeResult,
  type ImportConfirmResult,
  type ImportReviewResult,
  importAnalyzeInput,
  importConfirmInput,
  importReviewInput,
} from '@orbis/shared';
import { type AiDeps, defaultAiDeps } from '../ai/send-message';
import { ExecError, execErrorToTRPC } from '../errors';
import { analyzeCsv, confirmImport, type ImportDeps, reviewImport } from '../import/review';
import { ownerOnlyProcedure, router } from '../trpc';

/**
 * Резолвер §8 для review/confirm — из ctx.ai (тот же канал инъекции, что у
 * ai.sendMessage и analyze): боевой контекст (makeAiDeps) entitlements не ставит —
 * домен подставит resolveEntitlement; тесты инжектируют отказ. Трансляция контекста
 * в deps домена, не логика (правило 8 impl-00).
 */
function importDeps(ctx: { ai?: AiDeps }): ImportDeps {
  return ctx.ai?.entitlements !== undefined ? { entitlements: ctx.ai.entitlements } : {};
}

export const importRouter = router({
  /**
   * Распознавание структуры файла по образцам строк (§3.4 шаг 2) — единственный
   * LLM-вызов флоу. deps берутся из ctx.ai (как ai.sendMessage); отсутствие ctx.ai —
   * дефект DI, а не фолбэк: defaultAiDeps() бросает. Недоступность провайдера →
   * LLM_UNAVAILABLE (503, §7.9): клиент мапит колонки вручную.
   */
  analyze: ownerOnlyProcedure
    .input(importAnalyzeInput)
    .mutation(async ({ ctx, input }): Promise<ImportAnalyzeResult> => {
      try {
        return await analyzeCsv(ctx.db, ctx.ai ?? defaultAiDeps(), {
          ownerId: ctx.actorUserId,
          sampleRows: input.sampleRows,
        });
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /** Статусы строк ревью (§3.4 шаг 3, §3.4.1): ⟳ уже импортирована / ⊘ дубль / ✓ новая. */
  review: ownerOnlyProcedure
    .input(importReviewInput)
    .mutation(async ({ ctx, input }): Promise<ImportReviewResult> => {
      try {
        return await reviewImport(ctx.db, ctx.actorUserId, input, importDeps(ctx));
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /** Подтверждение импорта одним batch_execute (§3.4 шаг 4): атомарно и идемпотентно. */
  confirm: ownerOnlyProcedure
    .input(importConfirmInput)
    .mutation(async ({ ctx, input }): Promise<ImportConfirmResult> => {
      try {
        return await confirmImport(ctx.db, ctx.actorUserId, input, importDeps(ctx));
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),
});
