// apps/server/src/router.ts
// Сборка appRouter (§9.1): entity/relation/chat/ai — Task 12; user/aspect — Task 13.
import { aiRouter } from './routers/ai';
import { aspectRouter } from './routers/aspect';
import { budgetRouter } from './routers/budget';
import { chatRouter } from './routers/chat';
import { entityRouter } from './routers/entity';
// `import` — зарезервированное слово JS: ключ роутера так назвать можно, переменную нет
import { importRouter } from './routers/import';
import { oauthRouter } from './routers/oauth';
import { relationRouter } from './routers/relation';
import { userRouter } from './routers/user';
import { versionRouter } from './routers/version';
import { protectedProcedure, publicProcedure, router } from './trpc';

export const appRouter = router({
  ping: publicProcedure.query(() => ({ ok: true })),
  whoami: protectedProcedure.query(({ ctx }) => ({ actorUserId: ctx.actorUserId })),
  entity: entityRouter,
  relation: relationRouter,
  chat: chatRouter,
  ai: aiRouter,
  user: userRouter,
  aspect: aspectRouter,
  budget: budgetRouter,
  import: importRouter,
  // Закреплённые версии тела (С11): страховка владельца перед работой агента
  version: versionRouter,
  // Владельческая половина OAuth (§9.3): экран согласия и управление доступами
  oauth: oauthRouter,
});

export type AppRouter = typeof appRouter;
