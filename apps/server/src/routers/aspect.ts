// apps/server/src/routers/aspect.ts
// Роутер aspect (§9.1): реестр аспектов, видимых актору — встроенные (owner_id IS NULL) +
// свои кастомные. RLS сама скоупит SELECT под withIdentity (§4.10, политика
// read_builtin_or_own). Сортировка по id. CRUD кастомных и ретро-миграция §3.10 — вне
// слайса 1. Только трансляция.
import { asc } from 'drizzle-orm';
import { aspectDefinitions } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { protectedProcedure, router } from '../trpc';
import { toWireAspectDefinition, type WireAspectDefinition } from '../wire';

export const aspectRouter = router({
  list: protectedProcedure.query(
    ({ ctx }): Promise<WireAspectDefinition[]> =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const rows = await tx.select().from(aspectDefinitions).orderBy(asc(aspectDefinitions.id));
        return rows.map(toWireAspectDefinition);
      }),
  ),
});
