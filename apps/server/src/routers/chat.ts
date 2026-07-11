// apps/server/src/routers/chat.ts
// Роутер chat (§9.1): треды §4.5 (детерминированные id, ensure-семантика) и сообщения
// §4.6 (append-only). Только трансляция: примитивы — chat/threads.ts и chat/messages.ts.
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { appendMessageIdempotent, excludeInfraSystemRows } from '../chat/messages';
import { ensureEntityThread, ensureGlobalThread } from '../chat/threads';
import { chatMessages, chatThreads } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { ExecError, execErrorToTRPC } from '../errors';
import { ownerOnlyProcedure, protectedProcedure, router } from '../trpc';
import { toWireChatMessage } from '../wire';

/** ExecError доменных примитивов (NOT_FOUND треда/сущности) → TRPCError; прочее — наружу. */
function mapExecError(e: unknown): never {
  if (e instanceof ExecError) throw execErrorToTRPC(e);
  throw e;
}

// Курсор пагинации listMessages: строгий ISO-UTC (форма Date.toISOString(), опц. дробные
// секунды) + опциональный `|<uuid>`. Строгая regex (а не Date.parse): отсекает мусор
// («2026») и невалидный id (`<iso>|not-a-uuid`) чистым 400 — иначе кривой uuid дошёл бы
// до Postgres и упал 500 (invalid input syntax for type uuid).
const BEFORE_CURSOR_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z(\|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?$/;

export const chatRouter = router({
  // Без entityId — глобальный тред владельца; ensure идемпотентен (§4.5)
  ensureThread: ownerOnlyProcedure
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

  // created_at DESC (свежие первыми), default limit 50. Курсор before — составной
  // `"<iso>|<id>"` (createdAt+id самого старого загруженного, §2.1 UUIDv7): устойчив к
  // ms-коллизии двух сообщений в одну createdAt. Легаси-форма `<iso>` (клиент 1c-1, без
  // `|`) принимается как раньше — фильтр только по createdAt (обратная совместимость).
  listMessages: protectedProcedure
    .input(
      z
        .object({
          threadId: z.string().uuid(),
          // `<iso>` ИЛИ `<iso>|<uuid>` — строгая форма курсора (мусор/кривой uuid → 400)
          before: z
            .string()
            .regex(BEFORE_CURSOR_RE, 'before: ожидается "<iso>" или "<iso>|<uuid>"')
            .optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const conds: (SQL | undefined)[] = [
          eq(chatMessages.threadId, input.threadId),
          // Инфраструктурные system-строки (processing-маркеры §7.9, audit системных
          // действий §5.4) — не контент треда; журнал §7.8 остаётся в chat_messages.
          // Общий SQL-фрагмент с historyMessages LLM-контекста — фильтры зеркальны
          ...excludeInfraSystemRows(),
        ];
        if (input.before !== undefined) {
          const sep = input.before.indexOf('|');
          if (sep === -1) {
            // Легаси-курсор `<iso>` (клиент 1c-1): фильтр только по createdAt
            conds.push(lt(chatMessages.createdAt, new Date(input.before)));
          } else {
            // Составной `<iso>|<id>`: строгое «раньше» в лексикографике (createdAt, id) —
            // зеркалит DESC-сортировку (createdAt, id), устойчиво к ms-коллизии
            const createdAt = new Date(input.before.slice(0, sep));
            const id = input.before.slice(sep + 1);
            conds.push(
              or(
                lt(chatMessages.createdAt, createdAt),
                and(eq(chatMessages.createdAt, createdAt), lt(chatMessages.id, id)),
              ),
            );
          }
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
  appendUserMessage: ownerOnlyProcedure
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
