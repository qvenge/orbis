// apps/server/src/router.ts
// Сборка appRouter (§9.1): entity/relation/chat/ai — Task 12; user/aspect — Task 13.
import { aiRouter } from './routers/ai';
import { chatRouter } from './routers/chat';
import { entityRouter } from './routers/entity';
import { relationRouter } from './routers/relation';
import { protectedProcedure, publicProcedure, router } from './trpc';

export const appRouter = router({
  ping: publicProcedure.query(() => ({ ok: true })),
  whoami: protectedProcedure.query(({ ctx }) => ({ actorUserId: ctx.actorUserId })),
  entity: entityRouter,
  relation: relationRouter,
  chat: chatRouter,
  ai: aiRouter,
});

export type AppRouter = typeof appRouter;
