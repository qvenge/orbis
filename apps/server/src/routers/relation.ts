// apps/server/src/routers/relation.ts
// Роутер relation (§9.1): мутации — единственным путём через execute (§9.2),
// чтение графа — под withIdentity (RLS). Только трансляция, без бизнес-логики.
import { relationCreateInput, relationDeleteInput } from '@orbis/shared';
import { eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { relations } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execErrorToTRPC } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { WireRelation } from '../executor/types';
import { protectedProcedure, router } from '../trpc';
import { toWireRelation } from '../wire';

// Боевой синк — один инстанс на модуль (без состояния, пишет тем же tx, §7.8)
const sink = makeChatJournalSink();

export const relationRouter = router({
  create: protectedProcedure
    .input(relationCreateInput)
    .mutation(async ({ ctx, input }): Promise<WireRelation> => {
      const r = await execute(
        ctx.db,
        {
          actorUserId: ctx.actorUserId,
          actorKind: 'owner',
          source: 'ui', // прямое действие владельца в UI
          operations: [{ tool: 'relation_create', input }],
        },
        { sink },
      );
      if (!r.ok) throw execErrorToTRPC(r.error);
      return r.results[0] as WireRelation;
    }),

  delete: protectedProcedure.input(relationDeleteInput).mutation(async ({ ctx, input }) => {
    const r = await execute(
      ctx.db,
      {
        actorUserId: ctx.actorUserId,
        actorKind: 'owner',
        source: 'ui', // прямое действие владельца в UI
        operations: [{ tool: 'relation_delete', input }],
      },
      { sink },
    );
    if (!r.ok) throw execErrorToTRPC(r.error);
    return { ok: true as const };
  }),

  /** Связи сущности, обе стороны (source и target); RLS скоупит владельцем. */
  listFor: protectedProcedure
    .input(z.object({ entityId: z.string().uuid() }).strict())
    .query(({ ctx, input }) =>
      withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
        const rows = await tx
          .select()
          .from(relations)
          .where(or(eq(relations.sourceId, input.entityId), eq(relations.targetId, input.entityId)))
          .orderBy(relations.createdAt, relations.id);
        return rows.map(toWireRelation);
      }),
    ),
});
