import { initTRPC, TRPCError } from '@trpc/server';
import { createClient } from '@supabase/supabase-js';
import { db, type Database } from './db/client.ts';

export interface Context {
  userId: string | null;
  db: Database;
  [key: string]: unknown;
}

export async function createContext({ req }: { req: Request }): Promise<Context> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  let userId: string | null = null;

  if (token) {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!,
    );
    const { data } = await supabase.auth.getUser(token);
    userId = data.user?.id ?? null;
  }

  return { userId, db };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
