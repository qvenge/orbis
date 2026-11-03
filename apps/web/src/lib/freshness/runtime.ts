import {
  type Change,
  type ChangePage,
  changeXidInput,
  entityThreadId,
  type GraphId,
} from '@orbis/shared';
import {
  hashKey,
  isCancelledError,
  notifyManager,
  type Query,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { confirmBody } from '../../features/undo/body-provenance';
import type { EntityPatch } from '../optimistic/adapters';
import {
  createOptimisticStore,
  type OptimisticOutcome,
  type OptimisticToken,
} from '../optimistic/store';
import { cacheDependencyOf } from './dependencies';
import {
  type BodyPublication,
  type BodyResult,
  diskReadOf,
  type FreshnessSinks,
  networkObservationOf,
  nextNetworkOrder,
  observeNetworkRead,
  type ReadPublication,
  readErrorReceiptOf,
  recordDiskRead,
  sameFreshnessScope,
  shareProjectedData,
} from './provenance';
import type { createFreshnessTransport, FreshnessScope } from './transport';

const COALESCE_MS = 100;
const KEY_INTERVAL_MS = 500;
const FALLBACK_MS = 5000;
const EARLY_BODY_MS = 2000;
const BODY_TIMEOUT_MS = 30_000;
export const OLD_SCREEN_MS = 4 * 60 * 60 * 1000;

type Timer = ReturnType<typeof setTimeout>;
const defaultClock = {
  now: () => Date.now(),
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (timer: Timer) => clearTimeout(timer),
};
type BodySave = {
  entityId: string;
  expectedBodyRevision: number;
  draftToken?: string;
};
type BodyToken = Readonly<BodySave & { startedSequence: number }>;
type Entry = { txId: string; change: Change; due: number };
type Screen = {
  online: boolean;
  updating: boolean;
  receivedAt: number | null;
  hasVisible: boolean;
  hasCopy: boolean;
  old: boolean;
  finance: boolean;
};
const family = (key: QueryKey) => (Array.isArray(key[0]) ? key[0].join('.') : key[0]);
const queryInput = (key: QueryKey) => (key[1] as { input?: { id?: string } } | undefined)?.input;
const changeKinds = new Set<Change['kind']>([
  'entity',
  'relation',
  'version',
  'message',
  'thread',
  'journal',
  'settings',
  'registry',
]);
function validChange(change: Change): boolean {
  return (
    !!change &&
    changeKinds.has(change.kind) &&
    typeof change.rowKey === 'string' &&
    Array.isArray(change.entityIds) &&
    change.entityIds.every((id) => typeof id === 'string') &&
    (change.threadId === null || typeof change.threadId === 'string') &&
    ['insert', 'update', 'delete'].includes(change.operation) &&
    (change.scope === 'body' || change.scope === 'other') &&
    typeof change.at === 'string' &&
    typeof change.graphWide === 'boolean'
  );
}
const cmp = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a === b ? 0 : 1);

function placeholderTime(query: Query, scope: FreshnessScope): number | null {
  const times = query.observers.flatMap((observer) => {
    const result = observer.getCurrentResult();
    if (observer.options.enabled === false || !result.isPlaceholderData) return [];
    const net = networkObservationOf(result.data);
    if (net?.epoch === scope.epoch) return [net.receivedAt];
    const disk = diskReadOf(result.data);
    return disk && sameFreshnessScope(disk.scope, scope)
      ? [disk.receivedAt, ...Object.values(disk.fragmentTimes ?? {})]
      : [];
  });
  return times.length ? Math.min(...times) : null;
}

function ownCandidate(change: Change, id: string): boolean {
  return (
    (change.kind === 'entity' && change.scope === 'body' && change.rowKey === id) ||
    (change.kind === 'journal' &&
      !change.graphWide &&
      change.threadId === null &&
      change.entityIds.includes(id))
  );
}

export function createFreshnessRuntime({
  queryClient,
  transport,
  scope,
  clock = defaultClock,
  isCurrent = () => true,
}: {
  queryClient: QueryClient;
  transport: Pick<ReturnType<typeof createFreshnessTransport>, 'start' | 'stop' | 'reconcile'>;
  scope: FreshnessScope;
  clock?: typeof defaultClock;
  isCurrent?: () => boolean;
}) {
  const cache = queryClient.getQueryCache();
  const publications = new Map<string, ReadPublication>();
  const publicationListeners = new Map<string, Set<() => void>>();
  const acceptedReads = new WeakSet<ReadPublication>();
  const optimistic = createOptimisticStore(scope);
  const displayRepairAttempts = new Map<string, Promise<unknown> | null>();
  const refresh = new Set<string>();
  const staleKeys = new Set<string>();
  const lastRefresh = new Map<string, number>();
  const expired = new Map<string, string>();
  const pendingSaves = new Map<BodyToken, Timer>();
  const startedSaves = new WeakSet<BodyToken>();
  const own = new Map<string, string>();
  const bodies = new Map<string, Pick<BodyPublication, 'result' | 'receivedAt'>>();
  const resetTokens = new Set<string>();
  const deleted = new Set<string>();
  const screenListeners = new Set<() => void>();
  let sinks: FreshnessSinks = {};
  let entries: Entry[] = [];
  let queued: Entry[] = [];
  let coalesce: Timer | undefined;
  let early: Timer | undefined;
  let wake: Timer | undefined;
  let fallback: Timer | undefined;
  let cursor: string | undefined;
  let minimum: string | undefined;
  let floor: string | undefined;
  let completedFloor: string | undefined;
  let resetSequence = 0;
  let marking: Query | undefined;
  let startingRefreshes = false;
  let ownerMidnight: string | null = null;
  let graphEstablished = false;
  let disposed = false;
  let running = false;
  let connected = false;
  let online = typeof navigator === 'undefined' || navigator.onLine;
  let visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  let snapshot: Screen = {
    online,
    updating: false,
    receivedAt: null,
    hasVisible: false,
    hasCopy: false,
    old: false,
    finance: false,
  };

  const current = () => !disposed && isCurrent();
  const isCurrentOperation = (startedSequence: number) =>
    current() && startedSequence > resetSequence;
  function isCurrentReadError(error: unknown): boolean {
    const receipt = readErrorReceiptOf(error);
    return receipt?.epoch === scope.epoch && isCurrentOperation(receipt.startedSequence);
  }
  function captureOperation() {
    const startedSequence = nextNetworkOrder();
    return () => isCurrentOperation(startedSequence);
  }
  const policy = (query: Query) => {
    const read = publications.get(query.queryHash);
    return cacheDependencyOf(
      query.queryKey,
      read ? read.raw : query.state.data,
      ownerMidnight,
      scope.graphId as GraphId,
    );
  };
  const showing = (query: Query) => query.isActive();
  const relevant = (query: Query) => {
    const d = policy(query)?.dependencies;
    return d && (d.graph || d.settings || d.registry || d.entityIds.length || d.threadIds.length);
  };

  function publishScreen(now = clock.now()): number {
    let oldest: number | null = null;
    let hasVisible = false;
    let hasCopy = true;
    let updating = false;
    let finance = false;
    for (const query of cache.getAll()) {
      if (!showing(query) || !relevant(query)) continue;
      hasVisible = true;
      finance ||= String(family(query.queryKey)).startsWith('budget.');
      const publication = publications.get(query.queryHash);
      const at =
        publication?.source === 'network'
          ? publication.receipt.receivedAt
          : publication?.source === 'disk'
            ? Math.min(publication.receivedAt, ...Object.values(publication.fragmentTimes ?? {}))
            : placeholderTime(query, scope);
      if (at === null) hasCopy = false;
      else {
        const body = family(query.queryKey) === 'entity.get' && queryInput(query.queryKey)?.id;
        const ack = body ? bodies.get(body) : undefined;
        const blended =
          ack && publication && projectBody(query.queryKey, publication.raw) !== publication.raw
            ? Math.min(at, ack.receivedAt)
            : at;
        oldest = oldest === null ? blended : Math.min(oldest, blended);
      }
      updating ||=
        staleKeys.has(query.queryHash) ||
        query.state.isInvalidated ||
        query.state.fetchStatus !== 'idle' ||
        publication?.source !== 'network';
    }
    const next = {
      online,
      updating,
      finance,
      receivedAt: oldest,
      hasVisible,
      hasCopy: hasVisible && hasCopy,
      old: oldest !== null && now - oldest >= OLD_SCREEN_MS,
    };
    if (Object.keys(next).some((k) => next[k as keyof Screen] !== snapshot[k as keyof Screen])) {
      snapshot = next;
      for (const notify of screenListeners) notify();
    }
    return oldest !== null && !next.old ? oldest + OLD_SCREEN_MS : Infinity;
  }

  function schedule() {
    if (!current()) return;
    if (wake !== undefined) clock.clearTimeout(wake);
    wake = undefined;
    const now = clock.now();
    let next = publishScreen(now);
    if (!visible) return;
    for (const query of cache.getAll()) {
      const expiry = policy(query)?.dependencies.expiresAt;
      if (expiry && expired.get(query.queryHash) !== expiry) {
        const at = Date.parse(expiry);
        if (Number.isFinite(at)) next = Math.min(next, at);
      }
      if (
        online &&
        refresh.has(query.queryHash) &&
        showing(query) &&
        !query.isStatic() &&
        query.state.fetchStatus === 'idle'
      ) {
        next = Math.min(
          next,
          (lastRefresh.get(query.queryHash) ?? now - KEY_INTERVAL_MS) + KEY_INTERVAL_MS,
        );
      }
    }
    if (Number.isFinite(next))
      wake = clock.setTimeout(runScheduled, Math.max(0, Math.min(next - now, 2_147_483_647)));
  }

  function mark(query: Query, fetch: boolean) {
    staleKeys.add(query.queryHash);
    if (fetch && showing(query)) refresh.add(query.queryHash);
    const previous = marking;
    marking = query;
    try {
      query.invalidate();
    } finally {
      marking = previous;
    }
  }

  function watchRefreshAttempt(query: Query) {
    const attempt = query.promise;
    const hash = query.queryHash;
    // Query.fetch() resolves with old cache data after revert. The attempt's
    // promise retains the cancellation, even across a silent replacement.
    void attempt?.catch((error) => {
      if (!current() || !isCancelledError(error) || cache.get(hash) !== query) return;
      if (error.silent && query.promise && query.promise !== attempt) {
        watchRefreshAttempt(query);
        return;
      }
      refresh.add(hash);
      schedule();
    });
  }

  function runScheduled() {
    if (wake !== undefined) clock.clearTimeout(wake);
    wake = undefined;
    if (!current() || !visible) return;
    const now = clock.now();
    startingRefreshes = true;
    try {
      for (const query of cache.getAll()) {
        const hash = query.queryHash;
        const expiry = policy(query)?.dependencies.expiresAt;
        if (expiry && Date.parse(expiry) <= now && expired.get(hash) !== expiry) {
          expired.set(hash, expiry);
          mark(query, true);
        }
        if (
          !online ||
          !refresh.has(hash) ||
          !showing(query) ||
          query.isStatic() ||
          query.state.fetchStatus !== 'idle'
        )
          continue;
        if (now - (lastRefresh.get(hash) ?? -Infinity) < KEY_INTERVAL_MS) continue;
        refresh.delete(hash);
        lastRefresh.set(hash, now);
        void query.fetch(undefined, { cancelRefetch: false }).catch(() => {});
        watchRefreshAttempt(query);
      }
    } finally {
      startingRefreshes = false;
    }
    schedule();
  }

  function refreshVisible() {
    for (const query of cache.getAll()) {
      // TanStack already resumes a paused retry. Keep any pending event/reset obligation
      // in refresh, but do not create a second one merely because connectivity returned.
      if (query.state.fetchStatus === 'idle' && showing(query) && relevant(query))
        mark(query, true);
    }
    schedule();
  }

  function resetAll(token: string) {
    resetSequence = nextNetworkOrder();
    bodies.clear();
    deleted.clear();
    // The store retires ACK obligations, but a pending fetch can still revert
    // to the display it captured before this reset.
    const reprojected = optimistic.reset(resetSequence, true);
    for (const hash of reprojected) reproject(hash);
    sinks.resetResponses?.(scope, resetSequence, token);
    for (const query of cache.getAll()) mark(query, true);
    schedule();
  }

  function apply(batch: Entry[]) {
    if (batch.length > 200) {
      for (const query of cache.getAll()) mark(query, true);
      schedule();
      return;
    }
    for (const { change } of batch) {
      if (change.kind !== 'entity') continue;
      if (change.operation === 'delete') {
        deleted.add(change.rowKey);
        bodies.delete(change.rowKey);
      }
      if (change.operation === 'insert') deleted.delete(change.rowKey);
    }
    for (const query of cache.getAll()) {
      const d = policy(query)?.dependencies;
      if (!d) continue;
      let fetch = false;
      let stale = false;
      for (const { txId, change } of batch) {
        const id = own.get(txId);
        const body = change.kind === 'entity' && change.scope === 'body';
        const direct = change.entityIds.some((id) => d.entityIds.includes(id));
        if (id && ownCandidate(change, id)) {
          if (!body) continue;
          const isOwnDetail =
            family(query.queryKey) === 'entity.get' && queryInput(query.queryKey)?.id === id;
          const otherRef = change.entityIds.some((ref) => ref !== id && d.entityIds.includes(ref));
          stale ||= !isOwnDetail && (otherRef || (d.graph && d.bodyOrStamp));
          continue;
        }
        const thread =
          (change.threadId !== null && d.threadIds.includes(change.threadId)) ||
          (!body &&
            change.kind === 'entity' &&
            d.threadIds.length > 0 &&
            change.entityIds.some((id) =>
              d.threadIds.includes(entityThreadId(scope.graphId as GraphId, id)),
            ));
        const isRegistry = change.kind === 'registry';
        const isSettings = change.kind === 'settings';
        fetch ||=
          (change.graphWide && Boolean(relevant(query))) ||
          direct ||
          thread ||
          (d.settings && isSettings) ||
          (d.registry && isRegistry) ||
          (d.graph &&
            ((!body &&
              (change.kind === 'entity' ||
                change.kind === 'relation' ||
                isRegistry ||
                isSettings)) ||
              (body && d.bodyOrStamp)));
      }
      if (fetch || stale) mark(query, fetch);
    }
    runScheduled();
  }

  function releaseEarly() {
    if (early !== undefined) clock.clearTimeout(early);
    early = undefined;
    const ready: Entry[] = [];
    const now = clock.now();
    entries = entries.filter((entry) => {
      if (
        entry.due > now &&
        !own.has(entry.txId) &&
        [...pendingSaves.keys()].some(
          (save) =>
            isCurrentOperation(save.startedSequence) && ownCandidate(entry.change, save.entityId),
        )
      )
        return true;
      ready.push(entry);
      return false;
    });
    if (ready.length) apply(ready);
    if (entries.length) {
      early = clock.setTimeout(
        releaseEarly,
        Math.max(0, Math.min(...entries.map(({ due }) => due)) - now),
      );
    }
    for (const tx of own.keys()) {
      if (
        cursor !== undefined &&
        cmp(cursor, tx) > 0 &&
        !entries.some((item) => item.txId === tx) &&
        !queued.some((item) => item.txId === tx)
      )
        own.delete(tx);
    }
  }

  function flush() {
    coalesce = undefined;
    const batch = queued;
    queued = [];
    if (batch.length > 200) apply(batch);
    else entries.push(...batch);
    releaseEarly();
  }

  function acceptChanges(
    inputScope: FreshnessScope,
    page: ChangePage,
    requestedFrom: string,
  ): boolean {
    if (
      !current() ||
      !sameFreshnessScope(scope, inputScope) ||
      !changeXidInput.safeParse(requestedFrom).success ||
      !changeXidInput.safeParse(page?.watermark).success ||
      !changeXidInput.safeParse(page?.floor).success ||
      !Array.isArray(page.transactions)
    )
      return false;
    const from = cursor ?? requestedFrom;
    if (cmp(requestedFrom, from) > 0) return false;
    if (page.reset) {
      const { reason, token, phase } = page.reset;
      if (
        page.transactions.length ||
        !token ||
        !['floor', 'overflow', 'future-cursor'].includes(reason) ||
        (phase !== 'complete' && (phase !== 'provisional' || reason !== 'floor'))
      )
        return false;
      const lowering = reason === 'future-cursor' && requestedFrom === from;
      if ((cmp(page.watermark, from) < 0 && !lowering) || resetTokens.has(token)) return true;
      if (reason === 'floor') {
        if ((phase === 'provisional') !== cmp(page.watermark, page.floor) < 0) return false;
        if (
          (floor !== undefined && cmp(page.floor, floor) < 0) ||
          (phase === 'provisional' &&
            completedFloor !== undefined &&
            cmp(page.floor, completedFloor) <= 0)
        )
          return true;
        floor = page.floor;
        if (phase === 'complete') completedFloor = floor;
      }
      if (lowering && cmp(page.watermark, from) < 0) {
        // A restored server may reuse xid and body revision numbers.
        floor = page.floor;
        completedFloor = cmp(page.watermark, floor) >= 0 ? floor : undefined;
        own.clear();
        queued = [];
        entries = [];
      }
      resetTokens.add(token);
      cursor = page.watermark;
      resetAll(token);
      return true;
    }
    if (
      cmp(page.watermark, requestedFrom) < 0 ||
      cmp(requestedFrom, page.floor) < 0 ||
      page.transactions.some(
        (tx) =>
          !tx ||
          !changeXidInput.safeParse(tx.txId).success ||
          cmp(tx.txId, requestedFrom) < 0 ||
          cmp(tx.txId, page.watermark) >= 0 ||
          !Array.isArray(tx.changes) ||
          !tx.changes.every(validChange),
      )
    )
      return false;
    if (
      floor !== undefined &&
      (completedFloor === undefined || cmp(floor, completedFloor) > 0) &&
      cmp(page.watermark, floor) >= 0
    )
      return false;
    if (cmp(page.watermark, from) < 0) return true;
    const due = clock.now() + EARLY_BODY_MS;
    for (const tx of page.transactions) {
      if (cmp(tx.txId, from) < 0) continue;
      for (const change of tx.changes) queued.push({ txId: tx.txId, change, due });
    }
    cursor = page.watermark;
    if (queued.length && coalesce === undefined) coalesce = clock.setTimeout(flush, COALESCE_MS);
    return true;
  }

  function updateTransport() {
    const from = cursor;
    const shouldRun = current() && visible && online && graphEstablished && from !== undefined;
    if (shouldRun && !running) {
      running = true;
      transport.start({
        scope,
        isCurrent: current,
        acceptChanges,
        getCursor: () => cursor ?? from,
        onConnectionStateChange: (available) => {
          connected = available;
          scheduleFallback();
        },
      });
    } else if (!shouldRun && running) {
      running = connected = false;
      transport.stop();
    }
    scheduleFallback();
  }

  function scheduleFallback() {
    if (!running || connected) {
      if (fallback !== undefined) clock.clearTimeout(fallback);
      fallback = undefined;
    } else if (fallback === undefined) {
      fallback = clock.setTimeout(() => {
        fallback = undefined;
        void transport.reconcile();
        scheduleFallback();
      }, FALLBACK_MS);
    }
  }

  function resume() {
    if (!current()) return;
    const before = visible && online;
    visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    online = typeof navigator === 'undefined' || navigator.onLine;
    updateTransport();
    if (visible && online) {
      refreshVisible();
      if (running) void transport.reconcile();
    } else if (before || visible) schedule();
  }

  function notifyPublication(hash: string): void {
    for (const listener of publicationListeners.get(hash) ?? []) listener();
  }

  function acceptRead(read: ReadPublication): boolean {
    if (!current() || !sameFreshnessScope(scope, read.scope) || read.source === 'optimistic')
      return false;
    const query = cache.get(read.queryHash);
    if (!query) return false;
    const prior = publications.get(read.queryHash);
    if (read.source === 'disk') {
      if (prior?.source === 'network') return false;
      publications.set(read.queryHash, read);
      optimistic.acceptResponse(read);
      finishOptimisticRead(read.queryHash);
      notifyPublication(read.queryHash);
      mark(query, true);
      schedule();
      return false;
    }
    const { receipt } = read;
    if (
      receipt.epoch !== scope.epoch ||
      (prior?.source === 'network' && receipt.startedSequence < prior.receipt.startedSequence)
    )
      return false;
    if (receipt.startedSequence <= resetSequence) {
      mark(query, true);
      schedule();
      return false;
    }
    const { watermark } = receipt;
    if (watermark !== null && (minimum === undefined || cmp(watermark, minimum) < 0))
      minimum = watermark;
    const stale = cursor !== undefined && (watermark === null || cmp(watermark, cursor) < 0);
    publications.set(read.queryHash, read);
    optimistic.acceptResponse(read, !stale);
    finishOptimisticRead(read.queryHash);
    if (stale) mark(query, watermark !== null);
    else {
      acceptedReads.add(read);
      staleKeys.delete(query.queryHash);
      if (family(read.key) === 'user.getSettings') {
        const raw = read.raw as { graphEstablished?: boolean; nextMidnightAt?: string };
        ownerMidnight = raw.nextMidnightAt ?? null;
        graphEstablished = raw.graphEstablished === true;
        if (graphEstablished && cursor === undefined) cursor = minimum;
        updateTransport();
      }
      const p = policy(query)?.persistence;
      if (p && p !== 'none' && projectBody(read.key, read.raw) === read.raw)
        sinks.writeNetwork?.(read);
    }
    if (!stale && optimistic.needsRebase(read.queryHash)) mark(query, true);
    notifyPublication(read.queryHash);
    schedule();
    return !stale;
  }

  function isAcceptedRead(read: ReadPublication): boolean {
    return (
      read.source === 'network' &&
      acceptedReads.has(read) &&
      isCurrentOperation(read.receipt.startedSequence)
    );
  }

  function projectMetadata(read: ReadPublication): unknown {
    const shown = sinks.project ? sinks.project(read) : read.raw;
    return optimistic.projectResponse(read, shown);
  }

  function project(read: ReadPublication): unknown {
    return projectBody(read.key, projectMetadata(read));
  }

  function reproject(queryHash: string): void {
    if (!current()) return;
    const read = publications.get(queryHash);
    const query = cache.get(queryHash);
    if (!read || !query) return;
    const previous = query.state.data;
    let shown = project(read);
    if (shown === previous) return;
    if (family(read.key) === 'entity.get') {
      // Only a read or the specialized body writer replaces the editor's current body.
      const before = previous as
        | { entity?: Record<string, unknown>; bodyAction?: unknown }
        | undefined;
      const after = shown as typeof before;
      if (before?.entity && after?.entity && before.entity.id === after.entity.id) {
        const entity = { ...after.entity };
        for (const key of [
          'body',
          'bodyDoc',
          'bodyRevision',
          'bodyChangedAt',
          'bodyRefs',
          'bodyStart',
        ]) {
          if (Object.hasOwn(before.entity, key)) entity[key] = before.entity[key];
          else delete entity[key];
        }
        shown = {
          ...after,
          entity,
          ...(Object.hasOwn(before, 'bodyAction') && { bodyAction: before.bodyAction }),
        };
      }
    }
    const data = shareProjectedData(query, shown);
    if (data === previous) return;
    const network = networkObservationOf(previous);
    const disk = diskReadOf(previous);
    if (network) observeNetworkRead(data, network);
    if (disk && data && typeof data === 'object') recordDiskRead(data, disk);
    query.setState({ data });
  }

  function reprojectEntities(ids: readonly string[]) {
    notifyManager.batch(() => {
      for (const hash of optimistic.affectedResponses(ids).keys()) reproject(hash);
    });
  }

  function projectBody(key: QueryKey, data: unknown, includeEqual = false): unknown {
    if (family(key) !== 'entity.get') return data;
    if (!current()) return data;
    const id = queryInput(key)?.id;
    const ack = id && bodies.get(id);
    const detail = data as
      | {
          entity?: { bodyRevision: number; body?: string; bodyDoc?: unknown };
          bodyAction?: unknown;
        }
      | undefined;
    if (
      !ack ||
      !detail?.entity ||
      detail.entity.bodyRevision > ack.result.bodyRevision ||
      (!includeEqual && detail.entity.bodyRevision === ack.result.bodyRevision)
    )
      return data;
    const { body, bodyDoc, bodyRevision, bodyAction, bodyChangedAt } = ack.result;
    const entity = detail.entity;
    return {
      ...detail,
      ...(bodyAction !== undefined && 'bodyAction' in detail && { bodyAction }),
      entity: {
        ...entity,
        bodyRevision,
        ...(bodyChangedAt !== undefined && { bodyChangedAt }),
        ...(body !== undefined && 'body' in entity && { body }),
        ...(bodyDoc !== undefined && 'bodyDoc' in entity && { bodyDoc }),
      },
    };
  }

  function mutationSettled() {
    if (current() && running && !connected) void transport.reconcile();
  }

  function rememberBody(entityId: string, result: BodyResult, receivedAt = clock.now()): boolean {
    if (!current() || !Number.isInteger(result.bodyRevision)) return false;
    const previous = bodies.get(entityId);
    if (previous && previous.result.bodyRevision > result.bodyRevision) return false;
    bodies.set(entityId, { result, receivedAt });
    return true;
  }

  function beginBodySave(save: BodySave): BodyToken {
    const token = { ...save, startedSequence: nextNetworkOrder() };
    if (current()) {
      startedSaves.add(token);
      pendingSaves.set(
        token,
        clock.setTimeout(() => {
          pendingSaves.delete(token);
          releaseEarly();
          mutationSettled();
        }, BODY_TIMEOUT_MS),
      );
    }
    return token;
  }

  function settleBodySave(
    token: BodyToken,
    settlement: { txId?: string; result?: BodyResult; error?: unknown },
  ): boolean {
    if (!current() || !startedSaves.delete(token)) return false;
    const timer = pendingSaves.get(token);
    pendingSaves.delete(token);
    if (timer !== undefined) clock.clearTimeout(timer);
    const valid = isCurrentOperation(token.startedSequence);
    const { txId, result, error } = settlement;
    if (valid && !error && txId && result && changeXidInput.safeParse(txId).success) {
      if (timer !== undefined && result.bodyRevision > token.expectedBodyRevision)
        own.set(txId, token.entityId);
      const receivedAt = clock.now();
      if (rememberBody(token.entityId, result, receivedAt)) {
        sinks.acceptBody?.({
          ...token,
          scope,
          txId,
          result,
          receivedAt,
          ackSequence: nextNetworkOrder(),
        });
      }
    }
    releaseEarly();
    return valid && (!!result || error !== undefined);
  }

  function finishOptimisticRead(hash: string) {
    displayRepairAttempts.delete(hash);
    optimistic.finishRead(hash);
  }

  function watchDisplayRepairAttempt(query: Query) {
    const attempt = query.promise;
    const hash = query.queryHash;
    if (
      !current() ||
      !attempt ||
      cache.get(hash) !== query ||
      !displayRepairAttempts.has(hash) ||
      displayRepairAttempts.get(hash) === attempt
    )
      return;
    displayRepairAttempts.set(hash, attempt);
    void attempt.catch((error) => {
      if (!current() || !isCancelledError(error) || displayRepairAttempts.get(hash) !== attempt)
        return;
      if (query.promise && query.promise !== attempt) watchDisplayRepairAttempt(query);
      else finishOptimisticRead(hash);
    });
  }

  const unsubscribe = cache.subscribe((event) => {
    if (event.type === 'removed') {
      const hash = event.query.queryHash;
      if (publications.delete(hash)) notifyPublication(hash);
      displayRepairAttempts.delete(hash);
      optimistic.forgetResponse(hash);
      lastRefresh.delete(hash);
      refresh.delete(hash);
      staleKeys.delete(hash);
      expired.delete(hash);
    }
    if (event.type === 'updated') {
      const { action, query } = event;
      if (
        action.type === 'fetch' &&
        current() &&
        optimistic.watchResponse(query.queryHash, query.queryKey)
      ) {
        // Cancellation may arrive in this turn. The retryer is installed only
        // after the fetch action, so attach its promise separately.
        displayRepairAttempts.set(query.queryHash, null);
        queueMicrotask(() => watchDisplayRepairAttempt(query));
      }
      if (action.type === 'error') finishOptimisticRead(query.queryHash);
      if (
        action.type === 'setState' &&
        action.state.fetchStatus === 'idle' &&
        action.state.data !== undefined &&
        displayRepairAttempts.has(query.queryHash) &&
        current()
      ) {
        // TanStack revert restores the state from fetch start. Reapply today's view
        // without making the cancellation look like a successful read.
        finishOptimisticRead(query.queryHash);
        if (staleKeys.has(query.queryHash)) query.invalidate();
        reproject(query.queryHash);
      }
    }
    if (
      event.type === 'updated' &&
      event.action.type === 'success' &&
      event.action.manual &&
      staleKeys.has(event.query.queryHash)
    )
      event.query.invalidate();
    if (
      !startingRefreshes &&
      event.type !== 'observerResultsUpdated' &&
      !(event.type === 'updated' && event.action.type === 'invalidate' && event.query === marking)
    )
      schedule();
  });

  const events = ['focus', 'online', 'offline', 'pageshow'] as const;
  if (typeof window !== 'undefined') {
    for (const name of events) window.addEventListener(name, resume);
    document.addEventListener('visibilitychange', resume);
  }

  return {
    scope,
    acceptRead,
    acceptChanges,
    captureOperation,
    isCurrentOperation,
    isCurrentScope: current,
    beginBodySave,
    settleBodySave,
    mutationSettled,
    requestRead(key: QueryKey) {
      if (!current()) return;
      const query = cache.get(hashKey(key));
      if (query) {
        mark(query, true);
        schedule();
      }
    },
    subscribeScreen(listener: () => void) {
      screenListeners.add(listener);
      return () => {
        screenListeners.delete(listener);
      };
    },
    getScreen: () => snapshot,
    publicationOf: (hash: string) => publications.get(hash),
    subscribePublication(hash: string, listener: () => void): () => void {
      const listeners = publicationListeners.get(hash) ?? new Set<() => void>();
      listeners.add(listener);
      publicationListeners.set(hash, listeners);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) publicationListeners.delete(hash);
      };
    },
    isAcceptedRead,
    hasAcceptedResult(key: QueryKey, raw: unknown, afterSequence: number): boolean {
      const read = publications.get(hashKey(key));
      return (
        read?.source === 'network' &&
        read.raw === raw &&
        read.receipt.startedSequence > afterSequence &&
        isAcceptedRead(read)
      );
    },
    acceptOptimisticTitle(id: string, beforeSequence: number) {
      if (!current()) return;
      optimistic.acceptTitle(id, beforeSequence);
      reprojectEntities([id]);
    },
    finishOptimisticRead,
    beginOptimistic(patches: readonly EntityPatch[]) {
      if (!current()) return;
      const sequence = nextNetworkOrder();
      const token = optimistic.beginOptimistic(scope, String(sequence), patches, sequence);
      if (token) reprojectEntities(token.entityIds);
      return token;
    },
    settleOptimistic(token: OptimisticToken | undefined, outcome: OptimisticOutcome) {
      if (!current() || !token) return;
      const keys = optimistic.settleOptimistic(token, outcome);
      reprojectEntities(token.entityIds);
      for (const key of keys) {
        const query = cache.get(hashKey(key));
        if (query) mark(query, true);
      }
      if (keys.length) schedule();
    },
    projectCard: optimistic.projectCard,
    subscribeCard: optimistic.subscribeCard,
    cardRevision: optimistic.cardRevision,
    setSinks(next: FreshnessSinks) {
      sinks = { ...sinks, ...next };
    },
    project,
    projectMetadata,
    projectBody,
    projectRestoredBody(key: QueryKey, raw: unknown) {
      const id = queryInput(key)?.id;
      const ack = id && bodies.get(id);
      if (!ack) return undefined;
      const projected = projectBody(key, raw);
      if (projected === raw) return undefined;
      const detail = projected as { entity: { bodyDoc?: unknown } };
      const { bodyDoc } = detail.entity;
      // The disk marker belongs to this publication, not to another view sharing the ACK object.
      const data =
        bodyDoc && typeof bodyDoc === 'object'
          ? { ...detail, entity: { ...detail.entity, bodyDoc: { ...bodyDoc } } }
          : detail;
      return { data, receivedAt: ack.receivedAt };
    },
    publishBody(entityId: string) {
      if (!current()) return;
      for (const query of cache.getAll()) {
        if (family(query.queryKey) !== 'entity.get' || queryInput(query.queryKey)?.id !== entityId)
          continue;
        const projected = projectBody(query.queryKey, query.state.data, true);
        if (projected !== query.state.data) {
          query.setData(projected, {
            updatedAt: query.state.dataUpdatedAt,
            manual: true,
          });
          confirmBody((query.state.data as { entity?: { bodyDoc?: unknown } })?.entity?.bodyDoc);
        }
      }
    },
    rememberBody,
    hasNewerBodySave: (token: BodyToken) =>
      [...pendingSaves.keys()].some(
        (save) => save.entityId === token.entityId && save.startedSequence > token.startedSequence,
      ),
    requiresDurableDraft: () => sinks.acceptBody !== undefined,
    reproject,
    wasDeleted: (id: string) => deleted.has(id),
    isCurrentReadError,
    confirmedMissing(id: string, error: unknown) {
      if (isCurrentReadError(error)) {
        bodies.delete(id);
        sinks.removeEntity?.(scope, id);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      transport.stop();
      unsubscribe();
      if (typeof window !== 'undefined') {
        for (const name of events) window.removeEventListener(name, resume);
        document.removeEventListener('visibilitychange', resume);
      }
      for (const timer of [coalesce, early, wake, fallback, ...pendingSaves.values()]) {
        if (timer !== undefined) clock.clearTimeout(timer);
      }
      pendingSaves.clear();
      displayRepairAttempts.clear();
      optimistic.reset();
      publications.clear();
      publicationListeners.clear();
      bodies.clear();
      own.clear();
      resetTokens.clear();
      deleted.clear();
      refresh.clear();
      staleKeys.clear();
      lastRefresh.clear();
      expired.clear();
      entries = [];
      queued = [];
      sinks = {};
      screenListeners.clear();
    },
  };
}
