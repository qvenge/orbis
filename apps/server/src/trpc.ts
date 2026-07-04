import { initTRPC, TRPCError } from '@trpc/server';
import { verifyAccessToken } from './auth';
import type { Db } from './db/client';

// Identity течёт только через request-контекст; имя — actorUserId, не userId (D11).
// db — один инстанс на процесс (index.ts), в контекст кладётся ссылкой (Task 12).
// type, а не interface: у interface нет неявной index signature, и он не проходит
// требование Record<string, unknown> у createContext в @hono/trpc-server.
export type Context = {
  actorUserId: string | null;
  db: Db;
};

/** Фабрика createContext: db создаётся один раз при старте (index.ts) и замыкается здесь. */
export function makeCreateContext(db: Db) {
  return async function createContext({ req }: { req: Request }): Promise<Context> {
    const header = req.headers.get('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token) return { actorUserId: null, db };
    return { actorUserId: await verifyAccessToken(token), db };
  };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.actorUserId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { actorUserId: ctx.actorUserId } });
});
