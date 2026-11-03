import { afterEach, expect, test } from 'vitest';
import {
  bootstrapSharedSession as openSharedSession,
  prepareSharedSessionGeneration,
  type SharedSessionEnvironment,
} from './shared-session';
import { createAuthStorage } from './storage';

const key = 'sb-test-auth-token';
const firstId = '00000000-0000-4000-8000-000000000001';
const nextId = '00000000-0000-4000-8000-000000000002';

test('a newer device generation erases missed inherited shared state before SDK bootstrap', () => {
  expect(prepareSharedSessionGeneration('previous')).toBe(false);
  sessionStorage.setItem('orbis:shared:tab', firstId);
  sessionStorage.setItem(`orbis:shared:auth:${firstId}:${key}`, 'old session');
  sessionStorage.setItem(`orbis:shared:input:${firstId}:draft`, 'old input');
  expect(prepareSharedSessionGeneration('previous')).toBe(true);
  expect(prepareSharedSessionGeneration('new')).toBe(false);
  expect(Object.keys(sessionStorage)).toEqual(['orbis:shared:device']);
});

function testLeases() {
  const held = new Set<string>();
  return async (name: string) => {
    if (held.has(name)) return null;
    held.add(name);
    return () => {
      held.delete(name);
    };
  };
}

function environment(overrides: Partial<SharedSessionEnvironment> = {}): SharedSessionEnvironment {
  return {
    sessionStorage: () => sessionStorage,
    navigationType: 'navigate',
    newId: () => firstId,
    acquireLease: testLeases(),
    ...overrides,
  };
}

const bootstrapSharedSession = (
  authKey: string,
  env: SharedSessionEnvironment,
  isCurrent = () => true,
) => openSharedSession(authKey, isCurrent, env);

afterEach(() => sessionStorage.clear());

test.each([
  'navigate',
  'back_forward',
  undefined,
] as const)('a %s document purges copied auth and input before opening its own namespace', async (navigationType) => {
  const acquireLease = testLeases();
  const first = await bootstrapSharedSession(key, environment({ acquireLease }));
  const raw = sessionStorage;
  raw.setItem(first.authKey, 'private session');
  raw.setItem(`${first.authKey}-code-verifier`, 'private verifier');
  raw.setItem(`${first.inputPrefix}draft:account`, 'private input');
  raw.setItem('unrelated', 'keep');

  const next = await bootstrapSharedSession(
    key,
    environment({
      acquireLease,
      navigationType,
      newId: () => nextId,
    }),
  );
  expect(next.authKey).not.toBe(first.authKey);
  expect(raw.getItem(first.authKey)).toBeNull();
  expect(raw.getItem(`${first.authKey}-code-verifier`)).toBeNull();
  expect(raw.getItem(`${first.inputPrefix}draft:account`)).toBeNull();
  expect(raw.getItem('unrelated')).toBe('keep');
  first.close();
  next.close();
});

test('reload reuses an existing session and input only after obtaining its lineage lease', async () => {
  const acquireLease = testLeases();
  const first = await bootstrapSharedSession(key, environment({ acquireLease }));
  first.storage?.setItem(first.authKey, 'signed in');
  first.storage?.setItem(`${first.inputPrefix}d2`, 'pending');
  first.close();
  const reloaded = await bootstrapSharedSession(
    key,
    environment({
      acquireLease,
      navigationType: 'reload',
      newId: () => nextId,
    }),
  );
  expect(reloaded.authKey).toBe(first.authKey);
  expect(reloaded.storage?.getItem(reloaded.authKey)).toBe('signed in');
  expect(reloaded.storage?.getItem(`${reloaded.inputPrefix}d2`)).toBe('pending');
  reloaded.close();
});

test('a copied reload cannot take a live lineage or receive its later auth writes', async () => {
  const acquireLease = testLeases();
  const first = await bootstrapSharedSession(key, environment({ acquireLease }));
  first.storage?.setItem(first.authKey, 'signed in');
  // LocalStorage stands in for a second, independent storage area populated by browser cloning.
  localStorage.clear();
  try {
    for (const key of Object.keys(sessionStorage)) {
      const value = sessionStorage.getItem(key);
      if (value !== null) localStorage.setItem(key, value);
    }
    const second = await bootstrapSharedSession(
      key,
      environment({
        sessionStorage: () => localStorage,
        acquireLease,
        navigationType: 'reload',
        newId: () => nextId,
      }),
    );
    expect(second.authKey).not.toBe(first.authKey);
    expect(localStorage.getItem(first.authKey)).toBeNull();
    first.storage?.setItem(first.authKey, 'new access token');
    expect(sessionStorage.getItem(first.authKey)).toBe('new access token');
    expect(second.storage?.getItem(second.authKey)).toBeNull();
    second.close();
  } finally {
    first.close();
    localStorage.clear();
  }
});

test('unavailable session storage keeps auth private in memory and never touches persistent storage', async () => {
  const shared = await bootstrapSharedSession(
    key,
    environment({
      sessionStorage: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    }),
  );
  const auth = createAuthStorage({
    key: shared.authKey,
    backend: shared.storage,
    isCurrent: shared.isCurrent,
  });
  auth.storage.setItem(shared.authKey, 'session');
  expect(shared.storage).toBeNull();
  expect(auth.storage.getItem(shared.authKey)).toBe('session');
  expect(localStorage.getItem(shared.authKey)).toBeNull();
  shared.close();
  expect(auth.storage.getItem(shared.authKey)).toBeNull();
});

test('without exclusive locks reload cannot read the previous session', async () => {
  const first = await bootstrapSharedSession(key, environment());
  first.storage?.setItem(first.authKey, 'previous');
  first.close();
  const next = await bootstrapSharedSession(
    key,
    environment({
      acquireLease: undefined,
      navigationType: 'reload',
      newId: () => nextId,
    }),
  );
  expect(next.authKey).not.toBe(first.authKey);
  expect(next.storage).toBeNull();
  expect(sessionStorage.getItem(first.authKey)).toBeNull();
  next.close();
});

test('a live BFCache document regains its own namespace after another document in the same tab', async () => {
  const acquireLease = testLeases();
  const firstEvents = new EventTarget();
  const first = await bootstrapSharedSession(
    key,
    environment({ acquireLease, lifecycle: firstEvents }),
  );
  first.storage?.setItem(first.authKey, 'first login');
  firstEvents.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  // The editor's later pagehide callback can still record its emergency snapshot.
  first.storage?.setItem(`${first.inputPrefix}emergency`, 'last typed');
  const next = await bootstrapSharedSession(
    key,
    environment({ acquireLease, newId: () => nextId }),
  );
  expect(sessionStorage.getItem(first.authKey)).toBeNull();
  expect(first.isCurrent()).toBe(false);
  expect(next.storage?.getItem(first.authKey)).toBeNull();

  const restore = new PageTransitionEvent('pageshow', { persisted: true });
  first.restoreFromPageCache(restore);
  expect(first.isCurrent()).toBe(true);
  firstEvents.dispatchEvent(restore);
  expect(first.isCurrent()).toBe(true);
  expect(first.storage?.getItem(first.authKey)).toBe('first login');
  expect(first.storage?.getItem(`${first.inputPrefix}emergency`)).toBe('last typed');
  expect(first.storage?.keys()).toEqual([first.authKey, `${first.inputPrefix}emergency`]);
  expect(next.isCurrent()).toBe(false);
  first.close();
  next.close();
});

test('BFCache cannot restore a snapshot across a device generation change', async () => {
  const events = new EventTarget();
  let generation = 1;
  const first = await bootstrapSharedSession(
    key,
    environment({ lifecycle: events }),
    () => generation === 1,
  );
  first.storage?.setItem(first.authKey, 'first login');
  events.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  sessionStorage.clear();
  generation = 2;
  events.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  first.storage?.setItem(first.authKey, 'late auth response');
  expect(first.isCurrent()).toBe(false);
  expect(sessionStorage.getItem(first.authKey)).toBeNull();
  first.close();
});
