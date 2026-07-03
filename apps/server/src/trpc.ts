import { initTRPC, TRPCError } from '@trpc/server';
import { verifyAccessToken } from './auth';

// Identity течёт только через request-контекст; имя — actorUserId, не userId (D11).
// type, а не interface: у interface нет неявной index signature, и он не проходит
// требование Record<string, unknown> у createContext в @hono/trpc-server.
export type Context = {
  actorUserId: string | null;
};

export async function createContext({ req }: { req: Request }): Promise<Context> {
  const header = req.headers.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) return { actorUserId: null };
  return { actorUserId: await verifyAccessToken(token) };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.actorUserId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { actorUserId: ctx.actorUserId } });
});
