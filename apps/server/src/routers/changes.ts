import { changeCursorInput } from '@orbis/shared';
import { withIdentity } from '../db/with-identity';
import { readChanges } from '../freshness/feed';
import { ownerOnlyProcedure, router } from '../trpc';

export const changesRouter = router({
  reconcile: ownerOnlyProcedure.input(changeCursorInput).query(async ({ ctx, input }) => {
    const { page } = await withIdentity(ctx.db, ctx.identity, (tx) => readChanges(tx, input));
    return page;
  }),
});
