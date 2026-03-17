import { router } from './trpc.ts';
import { entityRouter } from './routers/entity.ts';
import { relationRouter } from './routers/relation.ts';
import { aspectRouter } from './routers/aspect.ts';
import { userRouter } from './routers/user.ts';
import { syncRouter } from './routers/sync.ts';
import { aiRouter } from './routers/ai.ts';
import { metricsRouter } from './routers/metrics.ts';
import { shareRouter } from './routers/share.ts';

export const appRouter = router({
  entity: entityRouter,
  relation: relationRouter,
  aspect: aspectRouter,
  user: userRouter,
  sync: syncRouter,
  ai: aiRouter,
  metrics: metricsRouter,
  share: shareRouter,
});

export type AppRouter = typeof appRouter;
