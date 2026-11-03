import { AuthClient } from '@supabase/auth-js';
import { afterEach, expect, test } from 'vitest';
import { createAuthStorage, removeStoredAuth } from './storage';

afterEach(() => localStorage.clear());

test('an adapter keeps its client fenced after revocation, including late removal of a new session', () => {
  const first = createAuthStorage({ key: 'test-auth', backend: localStorage });
  first.storage.setItem('test-auth', 'first');
  first.revoke();
  const second = createAuthStorage({ key: 'test-auth', backend: localStorage });
  second.storage.setItem('test-auth', 'second');
  first.storage.setItem('test-auth', 'late refresh');
  first.storage.removeItem('test-auth');
  expect(first.storage.getItem('test-auth')).toBeNull();
  expect(first.isCurrent()).toBe(false);
  expect(second.storage.getItem('test-auth')).toBe('second');
});

test('external generation changes fence an SDK password response already in flight', async () => {
  let generation = 1;
  const adapter = createAuthStorage({
    key: 'test-auth',
    backend: localStorage,
    isCurrent: () => generation === 1,
  });
  let acceptRequest!: () => void;
  const requested = new Promise<void>((resolve) => {
    acceptRequest = resolve;
  });
  let completeRequest!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    completeRequest = resolve;
  });
  const sdk = new AuthClient({
    url: 'https://auth.invalid',
    storageKey: 'test-auth',
    storage: adapter.storage,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    fetch: () => {
      acceptRequest();
      return response;
    },
  });
  try {
    await sdk.initialize();
    const pending = sdk.signInWithPassword({ email: 'a@example.invalid', password: 'password' });
    await requested;
    generation = 2;
    localStorage.setItem('test-auth', 'new-client');
    completeRequest(
      Response.json({
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        user: { id: 'account-a', aud: 'authenticated', role: 'authenticated' },
      }),
    );
    const result = await pending;
    expect(result.data.session?.user.id).toBe('account-a');
    expect(adapter.isCurrent()).toBe(false);
    expect(localStorage.getItem('test-auth')).toBe('new-client');
  } finally {
    await sdk.dispose();
  }
});

test('memory mode is instance-private and auth removal leaves unrelated storage intact', () => {
  const memory = createAuthStorage({ key: 'test-auth', backend: null });
  const persistent = createAuthStorage({ key: 'test-auth', backend: localStorage });
  memory.storage.setItem('test-auth', 'private');
  expect(memory.storage.getItem('test-auth')).toBe('private');
  expect(persistent.storage.getItem('test-auth')).toBeNull();
  persistent.storage.setItem('test-auth-code-verifier', 'verifier');
  persistent.storage.setItem('test-auth-user', 'user');
  persistent.storage.setItem('foreign', 'ignore');
  localStorage.setItem('foreign', 'keep');
  persistent.storage.removeItem('foreign');
  expect(persistent.storage.getItem('foreign')).toBeNull();
  expect(localStorage.getItem('foreign')).toBe('keep');
  removeStoredAuth(localStorage, 'test-auth');
  expect(localStorage.getItem('test-auth-code-verifier')).toBeNull();
  expect(localStorage.getItem('test-auth-user')).toBeNull();
  expect(localStorage.getItem('foreign')).toBe('keep');
});

test('a quota failure is observable and does not change an existing slot', () => {
  const adapter = createAuthStorage({
    key: 'test-auth',
    backend: {
      getItem: () => 'existing',
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {},
    },
  });
  expect(() => adapter.storage.setItem('test-auth', 'new')).toThrow('quota');
  expect(adapter.storage.getItem('test-auth')).toBe('existing');
});
