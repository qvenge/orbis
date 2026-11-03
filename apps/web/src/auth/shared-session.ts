import type { StorageAccess } from './storage';

const TAB_KEY = 'orbis:shared:tab';
const AUTH_PREFIX = 'orbis:shared:auth:';
const INPUT_PREFIX = 'orbis:shared:input:';
const DEVICE_KEY = 'orbis:shared:device';
const TAB_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
type Release = () => void;
type AcquireLease = (name: string) => Promise<Release | null>;

export type SharedSessionEnvironment = {
  sessionStorage: () => Storage;
  navigationType: PerformanceNavigationTiming['type'] | undefined;
  newId: () => string;
  acquireLease: AcquireLease | undefined;
  lifecycle?: EventTarget;
};

type SharedStorage = StorageAccess & { keys: () => string[] };

export type SharedSession = {
  authKey: string;
  inputPrefix: string;
  /** null means sessionStorage could not be used safely. A client may opt into memory. */
  storage: SharedStorage | null;
  /** Guard auth publication with the same lifetime as the scoped storage. */
  isCurrent: () => boolean;
  restoreFromPageCache(event: PageTransitionEvent): void;
  close: () => void;
};

function webLockLease(locks: LockManager): AcquireLease {
  return (name) =>
    new Promise((resolve, reject) => {
      let release = () => {};
      const lifetime = new Promise<void>((done) => {
        release = done;
      });
      void locks
        .request(name, { ifAvailable: true }, (lock) => {
          resolve(lock ? release : null);
          if (lock) return lifetime;
        })
        .catch(reject);
    });
}

function browserEnvironment(): SharedSessionEnvironment {
  const navigation = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  return {
    sessionStorage: () => window.sessionStorage,
    navigationType: navigation?.type,
    newId: () => crypto.randomUUID(),
    acquireLease: navigator.locks ? webLockLease(navigator.locks) : undefined,
    lifecycle: window,
  };
}

function storageKeys(storage: Storage): string[] {
  const keys = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function clearInherited(storage: Storage): void {
  for (const key of storageKeys(storage)) {
    if (key === TAB_KEY || key.startsWith(AUTH_PREFIX) || key.startsWith(INPUT_PREFIX)) {
      storage.removeItem(key);
    }
  }
}

export function clearSharedSessionStorage(): void {
  clearInherited(window.sessionStorage);
}

/** A device-wide wipe revokes older namespaces, even if this tab missed the notification. */
export function prepareSharedSessionGeneration(generation: string): boolean {
  try {
    const storage = window.sessionStorage;
    if (storage.getItem(DEVICE_KEY) !== generation) {
      clearInherited(storage);
      storage.setItem(DEVICE_KEY, generation);
    }
    return storage.getItem(TAB_KEY) !== null;
  } catch {
    return false;
  }
}

function sharedSession(
  baseAuthKey: string,
  id: string,
  backend: Storage | null,
  release: Release | undefined,
  lifecycle: EventTarget | undefined,
  isDeviceCurrent: () => boolean,
): SharedSession {
  const authKey = `${AUTH_PREFIX}${id}:${baseAuthKey}`;
  const inputPrefix = `${INPUT_PREFIX}${id}:`;
  const belongs = (key: string) =>
    key === authKey || key.startsWith(`${authKey}-`) || key.startsWith(inputPrefix);
  let open = true;
  let parked: Map<string, string> | undefined;
  const isCurrent = () =>
    open && isDeviceCurrent() && (backend === null || backend.getItem(TAB_KEY) === id);

  function park(event: Event) {
    if (!(event as PageTransitionEvent).persisted || !backend || !isCurrent()) return;
    const snapshot = new Map<string, string>();
    for (const key of storageKeys(backend).filter(belongs)) {
      const value = backend.getItem(key);
      if (value !== null) snapshot.set(key, value);
    }
    parked = snapshot;
  }

  function resume(event: Event) {
    if (!(event as PageTransitionEvent).persisted || !backend || !parked) return;
    const snapshot = parked;
    parked = undefined;
    // A fresh same-tab document can purge sessionStorage while this document is in BFCache.
    // The original document alone holds this snapshot and lease. A device wipe revokes both.
    if (!open || !isDeviceCurrent() || backend.getItem(TAB_KEY) === id) return;
    clearInherited(backend);
    for (const [key, value] of snapshot) backend.setItem(key, value);
    backend.setItem(TAB_KEY, id);
  }

  if (backend) {
    lifecycle?.addEventListener('pagehide', park);
    lifecycle?.addEventListener('pageshow', resume);
  }

  return {
    authKey,
    inputPrefix,
    isCurrent,
    restoreFromPageCache: resume,
    storage: backend
      ? {
          keys: () => (isCurrent() ? storageKeys(backend).filter(belongs) : []),
          getItem: (key) => (isCurrent() && belongs(key) ? backend.getItem(key) : null),
          setItem(key, value) {
            if (!isCurrent() || !belongs(key)) return;
            backend.setItem(key, value);
            parked?.set(key, value);
          },
          removeItem(key) {
            if (!isCurrent() || !belongs(key)) return;
            backend.removeItem(key);
            parked?.delete(key);
          },
        }
      : null,
    close() {
      if (!open) return;
      open = false;
      parked = undefined;
      lifecycle?.removeEventListener('pagehide', park);
      lifecycle?.removeEventListener('pageshow', resume);
      release?.();
    },
  };
}

/**
 * Call before constructing AuthClient. sessionStorage can be copied by the browser.
 * Only a reload may reuse a lineage, and it must first own that lineage's Web Lock.
 * A live BFCache document retains its lease and never re-enters bootstrap.
 */
export async function bootstrapSharedSession(
  baseAuthKey: string,
  isDeviceCurrent: () => boolean,
  env: SharedSessionEnvironment = browserEnvironment(),
): Promise<SharedSession> {
  const id = env.newId();
  let release: Release | undefined;
  try {
    const storage = env.sessionStorage();
    const previous = env.navigationType === 'reload' ? storage.getItem(TAB_KEY) : null;
    if (previous && TAB_ID.test(previous)) {
      release = (await env.acquireLease?.(`orbis:shared:${previous}`)) ?? undefined;
      if (release && isDeviceCurrent()) {
        return sharedSession(
          baseAuthKey,
          previous,
          storage,
          release,
          env.lifecycle,
          isDeviceCurrent,
        );
      }
    }

    if (isDeviceCurrent()) {
      clearInherited(storage);
      release = (await env.acquireLease?.(`orbis:shared:${id}`)) ?? undefined;
      if (release && isDeviceCurrent()) {
        storage.setItem(TAB_KEY, id);
        return sharedSession(baseAuthKey, id, storage, release, env.lifecycle, isDeviceCurrent);
      }
    }
  } catch {
    // Session storage may be blocked. In that case no inherited data may be used.
  }
  release?.();

  return sharedSession(baseAuthKey, id, null, undefined, undefined, isDeviceCurrent);
}
