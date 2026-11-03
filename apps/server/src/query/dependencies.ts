import type { ReadDependencies } from '@orbis/shared';
import type { CompileCtx } from './compile-ast';

export type QueryRead = 'bodyOrStamp' | 'date';

/** Collect reads from the same compilation used to execute the query. */
export function observeQuery(base: CompileCtx, entityIds: string[] = []) {
  const reads = new Set<QueryRead>();
  return {
    ctx: {
      ...base,
      observeRead(read: QueryRead) {
        reads.add(read);
      },
    },
    freshness: (): ReadDependencies => ({
      entityIds,
      graph: true,
      bodyOrStamp: reads.has('bodyOrStamp'),
      threadIds: [],
      settings: true,
      registry: true,
      expiresAt: reads.has('date') ? (base.nextMidnightAt?.() ?? null) : null,
    }),
  };
}
