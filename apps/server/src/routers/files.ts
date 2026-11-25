import {
  fileDescribeInput,
  fileFieldEditInput,
  uploadBeginInput,
  uploadIdInput,
} from '@orbis/shared/files';
import { ExecError, execErrorToTRPC } from '../errors';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import { journalRef } from '../executor/journal-ref';
import { withFileAccess } from '../files/access';
import { fileLimits } from '../files/file-limits';
import { describeFiles } from '../files/read';
import { beginUpload, finishUpload, uploadStatus } from '../files/uploads';
import { ownerOnlyProcedure, router, supportsFileWrites } from '../trpc';

const sink = makeJournalSink();
async function fileResult<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (error) {
    if (error instanceof ExecError) throw execErrorToTRPC(error);
    throw error;
  }
}
export const filesRouter = router({
  limits: ownerOnlyProcedure.query(({ ctx }) =>
    fileResult(() => withFileAccess(ctx, 'read', async () => fileLimits())),
  ),
  begin: ownerOnlyProcedure
    .input(uploadBeginInput)
    .mutation(({ ctx, input }) => fileResult(() => beginUpload(ctx, input, 'web'))),
  status: ownerOnlyProcedure
    .input(uploadIdInput)
    .query(({ ctx, input }) => fileResult(() => uploadStatus(ctx, input.uploadId))),
  finish: ownerOnlyProcedure.input(uploadIdInput).mutation(({ ctx, input }) => {
    ctx.onFileFinishWait?.();
    return fileResult(() => finishUpload(ctx, input.uploadId));
  }),
  describe: ownerOnlyProcedure
    .input(fileDescribeInput)
    .query(({ ctx, input }) => fileResult(() => describeFiles(ctx, input.ids))),
  editField: ownerOnlyProcedure.input(fileFieldEditInput).mutation(async ({ ctx, input }) => {
    const result = await execute(
      ctx.db,
      {
        identity: ctx.identity,
        actorKind: 'owner',
        source: 'ui',
        fileCapability: supportsFileWrites(ctx.clientVersion),
        operations: [{ tool: 'file_field_edit', input }],
      },
      { sink },
    );
    if (!result.ok) throw execErrorToTRPC(result.error);
    return {
      ...(result.results[0] as {
        entityId: string;
        propertyId: string;
        value: string | string[] | null;
      }),
      ...(result.noGraphChange ? { actionId: null, consequences: false } : journalRef(result)),
    };
  }),
});
