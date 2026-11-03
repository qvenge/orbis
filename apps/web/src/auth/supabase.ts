import {
  AuthClient,
  AuthRetryableFetchError,
  isAuthRetryableFetchError,
  type Session,
} from '@supabase/auth-js';
import { useSyncExternalStore } from 'react';
import { authFetch } from './auth-fetch';
import { authUrl, storageKeyFor } from './config';
import { createAuthStorage, removeStoredAuth, type StorageAccess } from './storage';

const url = import.meta.env.VITE_SUPABASE_URL ?? 'http://localhost:54321';
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? 'anon';
const endpoint = authUrl(url);
export const normalAuthStorageKey = storageKeyFor(url);

export type SessionState =
  | { status: 'loading'; token: null; userId: null }
  | { status: 'anon'; token: null; userId: null; reason?: 'signed-out' }
  | { status: 'cache-only'; token: null; userId: string }
  | { status: 'authed'; token: string; userId: string; expiresAt?: number };

type AuthSnapshot =
  | Exclude<SessionState, { status: 'authed' }>
  | { status: 'authed'; token: string; userId: string; expiresAt: number };

type Client = InstanceType<typeof AuthClient>;

type ClientScope = {
  storageKey: string;
  backend: StorageAccess | null;
  isCurrent?: () => boolean;
  detectSessionInUrl?: boolean;
};

type Binding = {
  scope: ClientScope;
  adapter: ReturnType<typeof createAuthStorage>;
  client: Client;
  unsubscribe?: () => void;
  recheck?: () => void;
};
type Revision = { raw: string | null; revision: string | null; attempt?: number };

const loading = { status: 'loading', token: null, userId: null } as const;
const anonymous = { status: 'anon', token: null, userId: null } as const;
const signedOut = { ...anonymous, reason: 'signed-out' } as const;
const accountId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
let snapshot: AuthSnapshot = loading;
let publishedRaw: string | undefined;
let current: Binding | undefined;
let selectedScope: ClientScope | undefined;
let disposing: Promise<void> | undefined;
let suspended = false;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function publish(state: AuthSnapshot, raw?: string) {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  snapshot = state;
  publishedRaw = raw;
  if (state.status === 'authed') {
    expiryTimer = setTimeout(
      () => {
        if (snapshot === state)
          publish({ status: 'cache-only', userId: state.userId, token: null });
      },
      Math.max(0, state.expiresAt - Date.now()),
    );
  }
  for (const listener of listeners) listener();
}

function defaultScope(): ClientScope {
  let backend: StorageAccess | null;
  try {
    backend = window.localStorage;
    backend.getItem(normalAuthStorageKey);
  } catch {
    backend = null;
  }
  return { storageKey: normalAuthStorageKey, backend };
}

/** The SDK-owned storage can establish a cache identity only. A valid JWT is required for HTTP. */
function inspectStoredSession(storage: StorageAccess, key: string) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return;
    const stored = JSON.parse(raw) as Partial<Session>;
    const token = stored?.access_token;
    const owner = stored?.user?.id;
    if (
      typeof token !== 'string' ||
      typeof owner !== 'string' ||
      !accountId.test(owner) ||
      typeof stored.refresh_token !== 'string' ||
      !stored.refresh_token
    )
      return;
    const segments = token.split('.');
    const payload = segments[1];
    if (segments.length !== 3 || !payload || !segments[2]) return;
    const { sub, exp } = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (
      typeof sub !== 'string' ||
      sub.toLowerCase() !== owner.toLowerCase() ||
      typeof exp !== 'number' ||
      !Number.isFinite(exp) ||
      exp <= 0
    )
      return;
    return { raw, userId: owner.toLowerCase(), token, expiresAt: exp * 1000 };
  } catch {
    // A malformed or unreadable auth slot must not open any cached account.
  }
}

function storedSession(binding: Binding) {
  return inspectStoredSession(binding.adapter.storage, binding.scope.storageKey);
}

export function storedAuthOwner(storage: StorageAccess, key: string): string | undefined {
  return inspectStoredSession(storage, key)?.userId;
}

function knownScope(userId: string) {
  return { status: 'cache-only', token: null, userId } as const;
}

export function lockAuthCommit<T>(key: string, commit: () => T): Promise<T> {
  return navigator.locks
    ? navigator.locks.request(`orbis:auth-commit:${key}`, commit)
    : Promise.resolve(commit());
}

/** The SDK may await both fetch and storage before writing. Only the original
 * credential revision can authorize a token commit or a terminal removal. */
function guardedSdk(scope: ClientScope, adapter: Binding['adapter']) {
  const key = scope.storageKey;
  const revisionKey = `${key}-revision`;
  const base = adapter.storage;
  const read = (): Revision => ({ raw: base.getItem(key), revision: base.getItem(revisionKey) });
  let lastRead = read();
  let password = 0;
  let terminal: Revision | undefined;
  const permits = new Map<string, Revision>();
  const credential = (value: Partial<Session>) =>
    typeof value.access_token === 'string' && typeof value.refresh_token === 'string'
      ? JSON.stringify([value.access_token, value.refresh_token])
      : undefined;
  const tokenUrl = new URL(`${endpoint}/token`);
  const fetchAuth = authFetch(endpoint);

  function currentRevision(expected: Revision): boolean {
    if (!adapter.isCurrent() || (expected.attempt !== undefined && expected.attempt !== password))
      return false;
    const now = read();
    return now.raw === expected.raw && now.revision === expected.revision;
  }

  function commit(expected: Revision, action: () => void, ignoreStale = false) {
    return lockAuthCommit(key, () => {
      if (!currentRevision(expected)) {
        if (ignoreStale) return;
        throw new AuthRetryableFetchError('Auth storage changed', 503);
      }
      // Move the revision before the credential, so a partial storage failure
      // cannot authorize a previously issued response.
      base.setItem(revisionKey, crypto.randomUUID());
      action();
      lastRead = read();
    });
  }

  return {
    storage: {
      getItem(slot: string) {
        if (slot === key) {
          lastRead = read();
          return lastRead.raw;
        }
        return base.getItem(slot);
      },
      setItem(slot: string, value: string) {
        if (slot !== key) return base.setItem(slot, value);
        const token = credential(JSON.parse(value));
        const expected = (token && permits.get(token)) || lastRead;
        if (token) permits.delete(token);
        return commit(expected, () => base.setItem(slot, value));
      },
      removeItem(slot: string) {
        if (slot !== key) return base.removeItem(slot);
        const expected = terminal ?? lastRead;
        terminal = undefined;
        // A stale terminal refusal can arrive while auth-js is already handling
        // an error. Throwing from its cleanup path would strand its refresh promise.
        return commit(expected, () => base.removeItem(slot), true);
      },
    },
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const url = new URL(request?.url ?? String(input), tokenUrl);
      const grant = url.searchParams.get('grant_type');
      if (
        (init?.method ?? request?.method)?.toUpperCase() !== 'POST' ||
        url.origin !== tokenUrl.origin ||
        url.pathname !== tokenUrl.pathname ||
        (grant !== 'password' && grant !== 'refresh_token')
      )
        return fetchAuth(input, init);
      const expected = read();
      if (grant === 'password') expected.attempt = ++password;
      else {
        // auth-js retries the same request after a 503. That retry must not
        // capture a newer owner's storage revision for the old refresh token.
        const body = init?.body;
        const token = typeof body === 'string' && JSON.parse(body).refresh_token;
        if (!token || !expected.raw || JSON.parse(expected.raw).refresh_token !== token)
          return new Response(null, { status: 503 });
        terminal = undefined;
      }
      const response = await fetchAuth(input, init);
      const payload = response.ok
        ? await response
            .clone()
            .json()
            .catch(() => undefined)
        : undefined;
      if (!currentRevision(expected)) {
        void response.body?.cancel().catch(() => {});
        return new Response(null, { status: 503 });
      }
      const token = payload && credential(payload);
      if (token) {
        if (permits.size >= 8) permits.clear();
        permits.set(token, expected);
      } else if (grant === 'refresh_token' && response.status !== 503) terminal = expected;
      return response;
    }) satisfies typeof fetch,
  };
}

function watch(binding: Binding) {
  if (binding.unsubscribe || !binding.adapter.isCurrent()) return;
  // The SDK may retry an expired credential for up to a refresh cycle.
  // With the browser offline, its known local cache can open immediately.
  if (!navigator.onLine) {
    const stored = storedSession(binding);
    if (stored && stored.expiresAt <= Date.now()) publish(knownScope(stored.userId), stored.raw);
  }
  let version = 0;
  function accept(token?: string): boolean {
    const stored = storedSession(binding);
    if (!stored || (token && stored.token !== token)) return false;
    publish(
      stored.expiresAt > Date.now()
        ? {
            status: 'authed',
            token: stored.token,
            userId: stored.userId,
            expiresAt: stored.expiresAt,
          }
        : knownScope(stored.userId),
      stored.raw,
    );
    return true;
  }
  const {
    data: { subscription },
  } = binding.client.onAuthStateChange((event, session) => {
    if (!binding.adapter.isCurrent()) return;
    if (event === 'SIGNED_OUT') {
      // A delayed cross-tab event cannot discard a newer stored credential.
      if (storedSession(binding)) return;
      version += 1;
      publish(signedOut);
    } else if (session && accept(session.access_token)) {
      version += 1;
    }
    // INITIAL_SESSION(null) also represents a temporary refresh failure.
    // Let getSession classify its error before discarding the local identity.
  });
  function storageChanged(event: StorageEvent) {
    if (event.key !== binding.scope.storageKey || !binding.adapter.isCurrent()) return;
    version += 1;
    if (!accept()) publish(signedOut);
  }
  binding.recheck = () => {
    if (!binding.adapter.isCurrent() || snapshot.status === 'loading') return;
    const raw = binding.adapter.storage.getItem(binding.scope.storageKey);
    if (raw === publishedRaw || (raw === null && snapshot.status === 'anon')) return;
    version += 1;
    if (!accept()) publish(signedOut);
  };
  if (binding.scope.storageKey === normalAuthStorageKey)
    window.addEventListener('storage', storageChanged);
  binding.unsubscribe = () => {
    subscription.unsubscribe();
    window.removeEventListener('storage', storageChanged);
  };
  const requested = version;
  void binding.client.getSession().then(
    ({ data, error }) => {
      if (!binding.adapter.isCurrent() || requested !== version) return;
      if (data.session && accept(data.session.access_token)) return;
      const stored = isAuthRetryableFetchError(error) && storedSession(binding);
      publish(stored ? knownScope(stored.userId) : anonymous, stored ? stored.raw : undefined);
    },
    () => {
      if (binding.adapter.isCurrent() && requested === version) publish(anonymous);
    },
  );
}

function openClient(scope: ClientScope): Binding {
  const adapter = createAuthStorage({
    key: scope.storageKey,
    backend: scope.backend,
    isCurrent: scope.isCurrent,
  });
  const guarded = guardedSdk(scope, adapter);
  // Keep the supabase-js-compatible endpoint, project storage key and gateway headers.
  // Implicit link sign-in is still accepted on a fresh document.
  const client = new AuthClient({
    url: endpoint,
    fetch: guarded.fetch,
    storageKey: scope.storageKey,
    storage: guarded.storage,
    headers: { apikey: anon, Authorization: `Bearer ${anon}` },
    persistSession: true,
    autoRefreshToken: true,
    flowType: 'implicit',
    detectSessionInUrl: scope.detectSessionInUrl ?? true,
  });
  const binding = { scope, adapter, client };
  current = binding;
  return binding;
}

function binding(): Binding {
  selectedScope ??= defaultScope();
  return current ?? openClient(selectedScope);
}

/** Low-level SDK access for integration and the real SDK tests. */
export async function getAuthClient(): Promise<Client> {
  while (disposing) await disposing;
  if (suspended) throw new Error('Auth client is suspended');
  const active = binding();
  if (listeners.size) watch(active);
  return active.client;
}

function detach(): Binding | undefined {
  const previous = current;
  current = undefined;
  previous?.adapter.revoke();
  previous?.unsubscribe?.();
  return previous;
}

function finishDisposal(previous: Binding | undefined) {
  if (!previous) return disposing;
  const finished = Promise.all([disposing, previous.client.dispose()]).then(() => {});
  disposing = finished;
  const settled = () => {
    if (disposing === finished) disposing = undefined;
  };
  void finished.then(settled, settled);
  return finished;
}

export async function retireAuthClient(): Promise<void> {
  suspended = true;
  const finished = finishDisposal(detach());
  publish(anonymous);
  await finished;
}

/** Call after device bootstrap and before mounting the authenticated tree. */
export async function setAuthClientScope(scope: ClientScope): Promise<void> {
  const finished = finishDisposal(detach());
  selectedScope = scope;
  suspended = false;
  publish(loading);
  await finished;
  if (selectedScope === scope && !suspended) await getAuthClient();
}

export function readAuthSession(): SessionState {
  if (!current) return snapshot;
  if (!current.adapter.isCurrent()) return anonymous;
  if (snapshot.status === 'authed') {
    try {
      if (current.adapter.storage.getItem(current.scope.storageKey) !== publishedRaw)
        return anonymous;
    } catch {
      return anonymous;
    }
  }
  return snapshot;
}

/** A BFCache resume cannot depend on when a buffered storage event is delivered. */
export function recheckStoredAuth(): void {
  try {
    current?.recheck?.();
  } catch {
    // The suspended tree stays hidden until its controller can verify storage.
  }
}

export function subscribeAuthSession(listener: () => void): () => void {
  listeners.add(listener);
  if (!suspended)
    void getAuthClient().catch(() => {
      if (!current && !suspended) publish(anonymous);
    });
  return () => {
    listeners.delete(listener);
  };
}

export function useSession(): SessionState {
  return useSyncExternalStore(subscribeAuthSession, readAuthSession);
}

/**
 * The shared-off transition captures this before freezing. Only its authorized
 * destination may persist the captured session, and a different session blocks
 * the handoff. Source cleanup belongs to the coordinator after durable input.
 */
export function captureAuthHandoff(storage?: StorageAccess, key?: string) {
  const stored =
    storage && key ? inspectStoredSession(storage, key) : current && storedSession(current);
  if (!stored) return;
  return {
    userId: stored.userId,
    persistTo(backend: StorageAccess, key: string, isCurrent: () => boolean): boolean {
      if (!isCurrent()) return false;
      const previous = backend.getItem(key);
      if (previous !== null && previous !== stored.raw) return false;
      backend.setItem(key, stored.raw);
      return true;
    },
  };
}

async function operationBinding() {
  const client = await getAuthClient();
  const active = current;
  if (!active || active.client !== client || !active.adapter.isCurrent()) {
    throw new AuthRetryableFetchError('Auth scope changed', 503);
  }
  return active;
}

export function captureAuthRevoker(): (() => Promise<void>) | undefined {
  const binding = current;
  const stored = binding && storedSession(binding);
  if (!binding || !stored || stored.expiresAt <= Date.now()) return;
  return async () => {
    const { error } = await binding.client.admin.signOut(stored.token, 'local');
    if (error) throw error;
  };
}

export const auth = {
  async signInWithPassword(...args: Parameters<Client['signInWithPassword']>) {
    return (await operationBinding()).client.signInWithPassword(...args);
  },
  async refreshSession(...args: Parameters<Client['refreshSession']>) {
    const active = await operationBinding();
    const before = storedSession(active);
    const result = await active.client.refreshSession(...args);
    if (active.adapter.isCurrent()) {
      const stored = storedSession(active);
      if (!result.data.session && (!stored || stored.token === before?.token)) return result;
      if (
        result.data.session &&
        stored &&
        stored.token === result.data.session.access_token &&
        stored.expiresAt > Date.now()
      ) {
        return result;
      }
    }
    return {
      data: { session: null, user: null },
      error: new AuthRetryableFetchError('No current bearer after refresh', 503),
    };
  },
  async signOut() {
    const previous = current;
    if (!previous) return { error: null };
    const credentials = storedSession(previous);
    const disposed = finishDisposal(detach());
    const scope = { ...previous.scope, detectSessionInUrl: false };
    // A failing removal must not reopen the original storage.
    selectedScope = { ...scope, backend: null };
    publish(signedOut);
    try {
      if (scope.backend) removeStoredAuth(scope.backend, scope.storageKey);
      selectedScope = scope;
    } finally {
      await disposed;
    }
    // The SDK signOut helper keeps local state on network failure. Local privacy
    // is already enforced above, so remote revocation can fail independently.
    if (credentials && credentials.expiresAt > Date.now()) {
      const { error } = await previous.client.admin.signOut(credentials.token, 'local');
      return { error };
    }
    return { error: null };
  },
};
