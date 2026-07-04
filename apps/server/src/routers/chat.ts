// apps/server/src/routers/chat.ts
// Роутер chat (§9.1): треды §4.5 (детерминированные id, ensure-семантика) и сообщения
// §4.6 (append-only). Только трансляция: примитивы — chat/threads.ts и chat/messages.ts.
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { appendMessageIdempotent } from '../chat/messages';
import { ensureEntityThread, ensureGlobalThread } from '../chat/threads';
import { chatMessages, chatThreads } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { ExecError, execErrorToTRPC } from '../errors';
import { protectedProcedure, router } from '../trpc';
import { toWireChatMessage } from '../wire';

/** ExecError доменных примитивов (NOT_FOUND треда/сущности) → TRPCError; прочее — наружу. */
function mapExecError(e: unknown): never {
  if (e instanceof ExecError) throw execErrorToTRPC(e);
  throw e;
}

export const chatRouter = router({
  // Без entityId — глобальный тред владельца; ensure идемпотентен (§4.5)
  ensureThread: protectedProcedure
    .input(z.object({ entityId: z.string().uuid().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const threadId = await withIdentity(ctx.db, ctx.actorUserId, (tx) =>
          input.entityId !== undefined
            ? ensureEntityThread(tx, ctx.actorUserId, input.entityId)
            : ensureGlobalThread(tx, ctx.actorUserId),
        );
        return { threadId };
      } catch (e) {
        mapExecError(e);
      }
    }),

  // created_at DESC (свежие первыми), default limit 50; before — курсор по createdAt
  // wire-формы самого старого загруженного сообщения (ms-точность toISOString)
  listMessages: protectedProcedure
    .input(
      z
        .object({
          threadId: z.string().uuid(),
          before: z.string().datetime().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const conds = [eq(chatMessages.threadId, input.threadId)];
        if (input.before !== undefined) {
          conds.push(lt(chatMessages.createdAt, new Date(input.before)));
        }
        const rows = await tx
          .select()
          .from(chatMessages)
          .where(and(...conds))
          .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
          .limit(input.limit ?? 50);
        return rows.map(toWireChatMessage);
      }),
    ),

  // id — client-generated UUIDv7 (§2.1); role всегда 'user' — assistant/system пишет
  // только сервер (audit §7.8, ответы 1b). Повтор с тем же id — идемпотентный replay
  // (штатный ретрай отправки, зеркально §5.3); чужой id → CONFLICT (fix round Task 12)
  appendUserMessage: protectedProcedure
    .input(
      z
        .object({
          id: z.string().uuid(),
          threadId: z.string().uuid(),
          content: z.string().min(1),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
          // Видимость треда под RLS: чужой и несуществующий неразличимы → NOT_FOUND
          // (иначе INSERT упал бы сырой RLS-ошибкой 42501 вместо структурированной)
          const visible = await tx
            .select({ id: chatThreads.id })
            .from(chatThreads)
            .where(eq(chatThreads.id, input.threadId));
          if (visible.length === 0) {
            throw new ExecError('NOT_FOUND', 'тред не найден', { threadId: input.threadId });
          }
          // wire-контракт прежний: наружу — сообщение (флаг replayed — для ai.sendMessage)
          return (await appendMessageIdempotent(tx, { ...input, role: 'user' })).message;
        });
      } catch (e) {
        mapExecError(e);
      }
    }),
});
