import { changeCursorInput, changeXidInput } from '@orbis/shared';
import { TRPCError, tracked } from '@trpc/server';
import { withIdentity } from '../db/with-identity';
import { readChanges } from '../freshness/feed';
import { changeStreamEnabled } from '../freshness/listener';
import { watchChanges } from '../freshness/stream';
import { ownerOnlyProcedure, router } from '../trpc';

export const changesRouter = router({
  watch: ownerOnlyProcedure
    .input(changeCursorInput.extend({ lastEventId: changeXidInput.optional() }))
    .subscription(async function* ({ ctx, input, signal }) {
      const { expiresAt } = ctx;
      if (expiresAt === undefined) throw new TRPCError({ code: 'UNAUTHORIZED' });
      if (!changeStreamEnabled()) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE' });
      for await (const item of watchChanges(
        { ...ctx, expiresAt },
        input.lastEventId ?? input.from,
        signal,
      )) {
        yield 'kind' in item ? item : tracked(item.watermark, item);
      }
    }),
  reconcile: ownerOnlyProcedure.input(changeCursorInput).query(async ({ ctx, input }) => {
    const { page } = await withIdentity(ctx.db, ctx.identity, (tx) => readChanges(tx, input));
    return page;
  }),
});
