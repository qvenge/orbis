import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc.ts';
import { aiChatInput } from '@orbis/shared';
import { handleChat } from '../services/ai/index.ts';

export const aiRouter = router({
  chat: protectedProcedure.input(aiChatInput).mutation(async ({ input, ctx }) => {
    try {
      return await handleChat(input, ctx.userId, ctx.db);
    } catch (error) {
      console.error('AI chat error:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: error instanceof Error ? error.message : 'AI service error',
      });
    }
  }),
});
