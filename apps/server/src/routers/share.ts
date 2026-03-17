import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { router, protectedProcedure } from '../trpc.ts';
import { sharedPackages } from '../db/schema.ts';
import { TRPCError } from '@trpc/server';

function generateShortId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export const shareRouter = router({
  createShareLink: protectedProcedure
    .input(
      z.object({
        packageData: z.record(z.unknown()),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const id = generateShortId();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30-day expiry

      await ctx.db.insert(sharedPackages).values({
        id,
        userId: ctx.userId,
        data: input.packageData,
        expiresAt,
      });

      return { id, expiresAt: expiresAt.toISOString() };
    }),

  getSharedPackage: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [pkg] = await ctx.db
        .select()
        .from(sharedPackages)
        .where(eq(sharedPackages.id, input.id));

      if (!pkg) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Package not found' });
      }

      if (pkg.expiresAt && pkg.expiresAt < new Date()) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Package has expired' });
      }

      return { data: pkg.data };
    }),
});
