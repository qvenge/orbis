import type { ChangePage } from '@orbis/shared';
import { isAuthApiError, isAuthSessionMissingError } from '@supabase/auth-js';
import { isRefreshRefusalCode } from '../../auth/auth-fetch';
import { emitUnauthorized } from '../../auth/events';
import { auth } from '../../auth/supabase';
import { type FreshnessStreamRequest, makeVanillaClient, trpcErrorCode } from '../../trpc';

export type FreshnessScope = { accountId: string; graphId: string; epoch: number };
export type RefreshResult =
  | { kind: 'refreshed'; token: string }
  | { kind: 'unauthorized' }
  | { kind: 'retry' };

type SessionOptions = {
  scope: FreshnessScope;
  getCursor: () => string;
  getHistory: () => number;
  isCurrent: (scope: FreshnessScope) => boolean;
  acceptChanges: (scope: FreshnessScope, page: ChangePage, requestedFrom: string) => boolean;
  onConnectionStateChange?: (available: boolean) => void;
};

async function refreshAuth(scope: FreshnessScope): Promise<RefreshResult> {
  const { data, error } = await auth.refreshSession();
  if (data.session?.user.id.toLowerCase() === scope.accountId.toLowerCase()) {
    return { kind: 'refreshed', token: data.session.access_token };
  }
  if (
    isAuthSessionMissingError(error) ||
    (isAuthApiError(error) && isRefreshRefusalCode(error.code))
  ) {
    return { kind: 'unauthorized' };
  }
  return { kind: 'retry' };
}

const MIN_RETRY = 100;
const MAX_RETRY = 5_000;
const CONNECT_TIMEOUT = 15_000;

/** Owns connections only. The active runtime owns accepted pages, cursor and pending work. */
export function createFreshnessTransport({
  getToken,
  refreshToken = refreshAuth,
  onUnauthorized = emitUnauthorized,
}: {
  getToken: () => string | null;
  refreshToken?: (scope: FreshnessScope) => Promise<RefreshResult>;
  onUnauthorized?: () => void;
}) {
  // Supabase notifies React asynchronously. Use the returned token immediately;
  // a later independent auth update supersedes it.
  let refreshed: { previous: string | null; token: string; scope: FreshnessScope } | undefined;
  const currentToken = () => {
    const token = getToken();
    if (refreshed && token === refreshed.previous) return refreshed.token;
    refreshed = undefined;
    return token;
  };
  const client = makeVanillaClient(currentToken);
  let current: ReturnType<typeof openSession> | undefined;
  let refreshInFlight: { scope: FreshnessScope; result: Promise<RefreshResult> } | undefined;

  function openSession(options: SessionOptions) {
    const { scope, getCursor, getHistory, acceptChanges, isCurrent, onConnectionStateChange } =
      options;
    const lifetime = new AbortController();
    const alive = () => !lifetime.signal.aborted && isCurrent(scope);
    let closeStream: (() => void) | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let reconcileTask: Promise<void> | undefined;
    let needsRefresh = false;
    let ready = false;
    let delay = MIN_RETRY;

    function availability(value: boolean) {
      if (ready === value) return;
      ready = value;
      onConnectionStateChange?.(value);
    }

    function schedule() {
      if (!alive() || reconnect !== undefined) return;
      reconnect = setTimeout(() => {
        reconnect = undefined;
        if (!alive()) return;
        if (needsRefresh) void refresh();
        else connect();
      }, delay);
      delay = Math.min(delay * 2, MAX_RETRY);
    }

    function stopStream() {
      const close = closeStream;
      closeStream = undefined;
      close?.();
      availability(false);
    }

    async function refresh() {
      if (!alive()) return;
      needsRefresh = true;
      stopStream();
      if (reconnect !== undefined) clearTimeout(reconnect);
      reconnect = undefined;
      const previous = getToken();
      const rejectedToken = currentToken();
      if (!refreshInFlight || !sameScope(refreshInFlight.scope, scope)) {
        const result = Promise.resolve()
          .then((): Promise<RefreshResult> | RefreshResult =>
            alive() ? refreshToken(scope) : { kind: 'retry' },
          )
          .catch((): RefreshResult => ({ kind: 'retry' }));
        refreshInFlight = { scope, result };
        void result.then(() => {
          if (refreshInFlight?.result === result) refreshInFlight = undefined;
        });
      }
      const result = await refreshInFlight.result;
      if (!alive() || !needsRefresh) return;
      if (result.kind === 'refreshed' && result.token !== rejectedToken) {
        refreshed = { previous, token: result.token, scope };
        needsRefresh = false;
        delay = MIN_RETRY;
        connect();
      } else if (result.kind === 'unauthorized') {
        stop();
        onUnauthorized();
      } else {
        schedule();
      }
    }

    function connect() {
      if (!alive() || closeStream) return;
      const token = currentToken();
      if (!token) {
        schedule();
        return;
      }
      const stream = new AbortController();
      const valid = () => alive() && !stream.signal.aborted;
      let pendingFrom = getCursor();
      let pendingHistory = getHistory();
      let requestedFrom = pendingFrom;
      let requestHistory = pendingHistory;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      const retry = () => {
        if (!valid()) return;
        stopStream();
        schedule();
      };
      const watchConnection = () => {
        watchdog ??= setTimeout(retry, CONNECT_TIMEOUT);
      };

      closeStream = () => {
        clearTimeout(watchdog);
        stream.abort();
        unsubscribe?.();
      };
      const freshnessStream: FreshnessStreamRequest = {
        token,
        beforeFetch: () => {
          pendingFrom = getCursor();
          pendingHistory = getHistory();
          return pendingFrom;
        },
      };
      watchConnection();
      const subscription = client.changes.watch.subscribe(
        { from: requestedFrom },
        {
          signal: stream.signal,
          context: { freshnessStream },
          onStarted() {
            if (!valid()) return;
            requestedFrom = pendingFrom;
            requestHistory = pendingHistory;
          },
          onConnectionStateChange(state) {
            if (!valid()) return;
            if (state.state === 'pending') {
              clearTimeout(watchdog);
              watchdog = undefined;
              availability(true);
            } else {
              availability(false);
              watchConnection();
            }
          },
          onData(item) {
            if (!valid()) return;
            if (requestHistory !== getHistory()) {
              retry();
              return;
            }
            if (
              item &&
              typeof item === 'object' &&
              'kind' in item &&
              item.kind === 'refresh-token'
            ) {
              void refresh();
            } else if (
              item &&
              typeof item === 'object' &&
              'data' in item &&
              item.data?.watermark === item.id &&
              acceptChanges(scope, item.data, requestedFrom)
            ) {
              if (BigInt(item.data.watermark) > BigInt(getCursor())) {
                // An ignored complete reset can advance the server stream, but
                // must not skip ordinary changes beyond our accepted boundary.
                retry();
                return;
              }
              requestedFrom = item.data.watermark;
              // A rewind accepted from this stream also moved its server cursor.
              requestHistory = getHistory();
              delay = MIN_RETRY;
            } else {
              retry();
            }
          },
          onError(error) {
            if (!valid()) return;
            if (requestHistory !== getHistory()) {
              retry();
              return;
            }
            const code = trpcErrorCode(error);
            if (code === 'UNAUTHORIZED') void refresh();
            else if (code === 'PRECONDITION_FAILED') stop();
            else retry();
          },
          onStopped: retry,
          onComplete: retry,
        },
      );
      unsubscribe = () => subscription.unsubscribe();
      if (!valid()) unsubscribe();
    }

    function reconcile() {
      if (!alive()) return Promise.resolve();
      reconcileTask ??= (async () => {
        const from = getCursor();
        const history = getHistory();
        const requestedToken = currentToken();
        const currentAttempt = () => alive() && history === getHistory();
        try {
          const page = await client.changes.reconcile.query({ from }, { signal: lifetime.signal });
          if (!currentAttempt()) return;
          if (!acceptChanges(scope, page, from) || history !== getHistory()) {
            // A rewind from reconcile invalidates the older stream's cursor too.
            stopStream();
            schedule();
          }
        } catch (error) {
          if (!currentAttempt()) return;
          const code = trpcErrorCode(error);
          if (code === 'UNAUTHORIZED' && requestedToken === currentToken()) await refresh();
          else if (code === 'PRECONDITION_FAILED') stop();
        }
      })().finally(() => {
        reconcileTask = undefined;
      });
      return reconcileTask;
    }

    function stop() {
      lifetime.abort();
      if (reconnect !== undefined) clearTimeout(reconnect);
      stopStream();
    }

    connect();
    return { stop, reconcile };
  }

  return {
    start(options: SessionOptions) {
      current?.stop();
      if (refreshed && !sameScope(refreshed.scope, options.scope)) refreshed = undefined;
      current = openSession(options);
    },
    stop() {
      current?.stop();
      current = undefined;
    },
    reconcile() {
      return current?.reconcile() ?? Promise.resolve();
    },
  };
}

function sameScope(left: FreshnessScope, right: FreshnessScope): boolean {
  return (
    left.accountId === right.accountId &&
    left.graphId === right.graphId &&
    left.epoch === right.epoch
  );
}
