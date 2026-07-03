import { protectedProcedure, publicProcedure, router } from './trpc';

export const appRouter = router({
  ping: publicProcedure.query(() => ({ ok: true })),
  whoami: protectedProcedure.query(({ ctx }) => ({ actorUserId: ctx.actorUserId })),
});

export type AppRouter = typeof appRouter;
