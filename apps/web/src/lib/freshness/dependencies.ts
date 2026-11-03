import { entityThreadId, type GraphId, type ReadDependencies } from '@orbis/shared';
import { MEMORY_RULES_QUERY } from '../../features/chat/memoryRules';

type Persistence = 'none' | 'response' | 'thread-tail';
type Rule = (input: Fields, data: unknown, graphId?: GraphId) => CacheDependency;
type Fields = Record<string, unknown>;

export type CacheDependency = {
  dependencies: ReadDependencies;
  persistence: Persistence;
  /** The runtime supplies the server deadline from this owner's confirmed settings. */
  ownerMidnight: boolean;
};

const empty: ReadDependencies = {
  entityIds: [],
  graph: false,
  bodyOrStamp: false,
  threadIds: [],
  settings: false,
  registry: false,
  expiresAt: null,
};
const graphReads: Partial<ReadDependencies> = { graph: true, settings: true, registry: true };

function rule(
  persistence: Persistence,
  reads: Partial<ReadDependencies> = {},
  ownerMidnight = false,
): CacheDependency {
  return { persistence, dependencies: { ...empty, ...reads }, ownerMidnight };
}

function fields(value: unknown): Fields {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {};
}

function ids(...values: unknown[]): string[] {
  return [
    ...new Set(values.flat().flatMap((v) => (typeof v === 'string' ? [v.toLowerCase()] : []))),
  ];
}

function deadline(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function serverReads(data: unknown): ReadDependencies | undefined {
  return fields(data).freshness as ReadDependencies | undefined;
}

function graphResponse(_input: Fields, data: unknown): CacheDependency {
  return rule('response', serverReads(data) ?? { ...graphReads, bodyOrStamp: true });
}

function registry(): CacheDependency {
  return rule('response', { registry: true, settings: true });
}

function transient(): CacheDependency {
  return rule('none');
}

function money(): CacheDependency {
  return rule('response', graphReads, true);
}

function pending(input: Fields, data: unknown, graphId?: GraphId): CacheDependency {
  const views = Array.isArray(data) ? data.map(fields) : [fields(data)];
  const anchors = ids(
    input.entityId,
    input.runId,
    ...views.flatMap((view) => [view.runId, view.routineId]),
  );
  return rule('none', {
    ...graphReads,
    bodyOrStamp: true,
    entityIds: anchors,
    threadIds: graphId ? anchors.map((id) => entityThreadId(graphId, id)) : [],
  });
}

const trpc: Readonly<Record<string, Rule>> = {
  'entity.get': (input, data) =>
    rule(
      'response',
      serverReads(data) ?? {
        ...graphReads,
        entityIds: ids(input.id),
        bodyOrStamp: true,
      },
    ),
  'entity.query': (input, data) => {
    const response = graphResponse(input, data);
    // Fast path uses the stamp to resolve competing rules after reading the list.
    return input.query === MEMORY_RULES_QUERY.query
      ? { ...response, dependencies: { ...response.dependencies, bodyOrStamp: true } }
      : response;
  },
  'entity.count': graphResponse,
  'entity.resolveRefs': (input) => rule('response', { entityIds: ids(input.ids), registry: true }),
  'entity.suggest': transient,
  'entity.blocks': graphResponse,
  'relation.listFor': (input, data) =>
    rule('response', {
      entityIds: ids(
        input.entityId,
        ...(Array.isArray(data)
          ? data.flatMap((row) => [fields(row).sourceId, fields(row).targetId])
          : []),
      ),
      registry: true,
    }),
  'chat.listMessages': (input) =>
    rule(input.before == null ? 'thread-tail' : 'none', { threadIds: ids(input.threadId) }),
  'chat.threadEntity': (input, data) =>
    rule('none', {
      threadIds: ids(input.threadId),
      entityIds: ids(fields(data).entityId),
    }),
  'registry.effective': registry,
  'user.getSettings': (_input, data) =>
    rule('response', {
      // graphEstablished reads the presence of a host shell, including an archived one.
      graph: true,
      settings: true,
      expiresAt: deadline(fields(data).nextMidnightAt),
    }),
  'user.exportData': transient,
  'supply.updates': () => rule('response', { ...graphReads, bodyOrStamp: true }),
  'budget.overview': money,
  'budget.alertCount': money,
  'budget.categoryTrend': money,
  'budget.envelopeForCategory': money,
  'budget.rolloverPreview': () => rule('none', graphReads, true),
  'routine.overview': (input, data, graphId) =>
    rule('response', {
      ...graphReads,
      entityIds: ids(input.routineId),
      threadIds:
        graphId && typeof input.routineId === 'string'
          ? [entityThreadId(graphId, input.routineId)]
          : [],
      expiresAt: deadline(fields(data).nextBucketAt),
    }),
  'routine.proposal': pending,
  'routine.proposalsForEntity': pending,
  'routine.runUnits': pending,
  'version.list': (input) => rule('none', { entityIds: ids(input.entityId) }),
  'changes.reconcile': transient,
  'oauth.describeRequest': transient,
  'oauth.listGrants': transient,
};

const custom: Readonly<
  Record<string, (key: readonly unknown[], data: unknown) => CacheDependency>
> = {
  registry,
  chatThread: (key) => rule('thread-tail', { threadIds: ids(key[1]) }),
  'query-block': (key, data) =>
    rule(
      'response',
      serverReads(data) ?? {
        ...graphReads,
        bodyOrStamp: true,
        entityIds: ids(key[1] === 'badge' ? key[2] : undefined),
      },
    ),
};

export function hasCacheDependency(family: string, kind: 'trpc' | 'custom'): boolean {
  return Object.hasOwn(kind === 'trpc' ? trpc : custom, family);
}

export function cacheDependencyOf(
  key: readonly unknown[],
  data?: unknown,
  ownerNextMidnight?: string | null,
  graphId?: GraphId,
): CacheDependency | undefined {
  const [prefix, options] = key;
  const family = Array.isArray(prefix) ? prefix.join('.') : prefix;
  const kind = Array.isArray(prefix) ? 'trpc' : 'custom';
  if (typeof family !== 'string' || !hasCacheDependency(family, kind)) return undefined;
  const result =
    kind === 'trpc'
      ? trpc[family]?.(fields(fields(options).input), data, graphId)
      : custom[family]?.(key, data);
  if (!result?.ownerMidnight || !ownerNextMidnight) return result;
  return { ...result, dependencies: { ...result.dependencies, expiresAt: ownerNextMidnight } };
}
