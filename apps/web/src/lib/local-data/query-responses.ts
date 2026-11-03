import {
  CancelledError,
  type DefaultOptions,
  type Query,
  type QueryClient,
  type QueryPersister,
} from '@tanstack/react-query';
import { finishDraftSlot } from '../../features/entity-editor/draft-storage';
import { markBodyPending } from '../../features/undo/body-provenance';
import { cacheDependencyOf } from '../freshness/dependencies';
import {
  type BodyPublication,
  diskAwareStaleTime,
  freshnessRuntimeOf,
  sameFreshnessScope,
  stageDiskRead,
} from '../freshness/provenance';
import type { openResponseCache } from './response-cache';

type Cache = ReturnType<typeof openResponseCache>;
type Session = {
  enabled: boolean;
  ready: Promise<Cache | undefined>;
  cache?: Cache;
  restoring: Map<Query, object>;
};
const caches = new WeakMap<QueryClient, Session>();
export const networkOnlyResponse = { responseRestore: 'network-only' } as const;

export const restoreResponse: QueryPersister = async (queryFn, context, query) => {
  const session = caches.get(context.client);
  const persistence = cacheDependencyOf(query.queryKey)?.persistence;
  if (
    !session?.enabled ||
    context.meta?.responseRestore === networkOnlyResponse.responseRestore ||
    query.state.data !== undefined ||
    !query.isActive() ||
    !persistence ||
    persistence === 'none'
  )
    return queryFn(context);

  const { restoring } = session;
  const runtime = freshnessRuntimeOf(context.client);
  const currentOperation = runtime?.captureOperation();
  const signal = context.signal;
  const attempt = {};
  restoring.set(query, attempt);
  const forgetAttempt = () => {
    if (restoring.get(query) === attempt) restoring.delete(query);
  };
  let staged = false;
  try {
    const cache = session.cache ?? (await session.ready);
    const ticket = cache?.capture();
    const disk = await cache?.read({ key: query.queryKey, queryHash: query.queryHash }, ticket);
    if (
      signal.aborted ||
      restoring.get(query) !== attempt ||
      caches.get(context.client) !== session ||
      !currentOperation?.() ||
      context.client.getQueryCache().get(query.queryHash) !== query
    )
      throw new CancelledError({ revert: true });
    if (
      query.state.data !== undefined ||
      runtime?.publicationOf(query.queryHash)?.source === 'network'
    )
      throw new CancelledError({ revert: true });
    if (disk && cache?.isCurrent(ticket)) {
      const { data: raw, ...age } = disk;
      const body = runtime?.projectRestoredBody(query.queryKey, raw);
      const data = body?.data ?? raw;
      if (body) age.fragmentTimes = { ...age.fragmentTimes, body: body.receivedAt };
      const [prefix] = query.queryKey;
      if (Array.isArray(prefix) && prefix.join('.') === 'entity.get')
        markBodyPending((data as { entity?: { bodyDoc?: unknown } })?.entity?.bodyDoc);
      stageDiskRead(query, data, { ...age, source: 'disk', scope: cache.scope }, signal);
      staged = true;
      // Keep the cancellation barrier through TanStack's success microtasks.
      setTimeout(forgetAttempt, 0);
      return data;
    }
  } finally {
    if (!staged) forgetAttempt();
  }
  return queryFn(context);
};

export const responseQueryOptions: NonNullable<DefaultOptions['queries']> = {
  persister: restoreResponse,
  staleTime: diskAwareStaleTime(30_000),
};

/** A later confirmed GET can finish a retained slot once its exact body is on disk. */
export function finishStoredDraft(
  client: QueryClient,
  entityId: string,
  draftToken: string,
  bodyRevision: number,
  bodyDoc: unknown,
): void {
  const session = caches.get(client);
  const cache = session?.cache;
  if (!cache) return;
  const ticket = cache.capture();
  void cache.hasDurableBody(entityId, bodyRevision, bodyDoc, ticket).then((durable) => {
    if (durable && cache.isCurrent(ticket) && caches.get(client) === session)
      finishDraftSlot(cache.scope.accountId, entityId, draftToken);
  });
}

export function bindQueryResponses(
  client: QueryClient,
  runtime: NonNullable<ReturnType<typeof freshnessRuntimeOf>>,
  options: { enabled?: boolean; buster?: string } = {},
) {
  const { scope } = runtime;
  const enabled = options.enabled ?? import.meta.env.VITE_RESPONSE_PERSISTENCE !== 'off';
  const restoring = new Map<Query, object>();
  let closed = false;
  let cutoff = 0;
  // Start the native storage chunk at auth setup. It is available in the existing PWA precache.
  const ready = enabled
    ? import('./response-cache')
        .then((module) => {
          if (!closed) {
            session.cache = module.openResponseCache(
              scope,
              options.buster ?? module.responseBuster,
            );
            return session.cache;
          }
        })
        .catch(() => undefined)
    : Promise.resolve(undefined);
  const session: Session = { enabled, ready, restoring };
  caches.set(client, session);

  const cancelRestores = () => {
    for (const query of restoring.keys()) void query.cancel({ revert: true });
  };
  async function acceptBody(cache: Cache, receipt: BodyPublication) {
    if (closed || receipt.startedSequence <= cutoff) return;
    const ticket = cache.capture();
    const durable = await cache.acceptBodyResult(receipt);
    if (durable && receipt.draftToken && cache.isCurrent(ticket) && caches.get(client) === session)
      finishDraftSlot(scope.accountId, receipt.entityId, receipt.draftToken);
  }

  runtime.setSinks({
    writeNetwork: (read) => {
      if (!enabled || closed || !sameFreshnessScope(scope, read.scope)) return;
      if (session.cache) {
        void session.cache.writeServerResponse(read, read.raw, read.receipt);
        return;
      }
      try {
        const raw = structuredClone(read.raw);
        void ready.then((cache) => {
          if (!closed && read.receipt.startedSequence > cutoff)
            void cache?.writeServerResponse(read, raw, read.receipt);
        });
      } catch {
        // An uncloneable result can still be shown in memory.
      }
    },
    acceptBody: (receipt) => {
      if (!enabled || closed) return;
      if (session.cache) {
        void acceptBody(session.cache, receipt);
        return;
      }
      try {
        const snapshot = structuredClone(receipt);
        void ready.then((cache) => cache && acceptBody(cache, snapshot));
      } catch {
        // Without a durable copy the submitted draft remains recoverable.
      }
    },
    resetResponses: (owner, sequence, token) => {
      if (!sameFreshnessScope(scope, owner)) return;
      cutoff = Math.max(cutoff, sequence);
      cancelRestores();
      if (session.cache) void session.cache.invalidateGeneration(sequence, token);
      else void ready.then((cache) => !closed && cache?.invalidateGeneration(sequence, token));
    },
    removeEntity: (owner, id) => {
      if (!sameFreshnessScope(scope, owner)) return;
      if (session.cache) void session.cache.removeEntity(id);
      else {
        void ready.then((cache) => {
          if (!closed) void cache?.removeEntity(id);
        });
      }
    },
  });
  return {
    ready,
    close() {
      closed = true;
      if (caches.get(client) === session) caches.delete(client);
      cancelRestores();
      session.cache?.close();
    },
  };
}
