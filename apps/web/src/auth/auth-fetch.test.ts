import { isAuthRetryableFetchError } from '@supabase/auth-js';
import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

async function refreshExpiredSession(label: string, response: () => Response) {
  const host = `refresh-${label}`;
  const origin = `https://${host}.supabase.co`;
  const key = `sb-${host}-auth-token`;
  vi.stubEnv('VITE_SUPABASE_URL', origin);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'fixture-anon');
  const fetch = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetch);
  vi.resetModules();
  const { auth } = await import('./supabase');
  await auth.initialize();
  await auth.stopAutoRefresh();
  const events: string[] = [];
  let initialized!: () => void;
  const initial = new Promise<void>((resolve) => {
    initialized = resolve;
  });
  const {
    data: { subscription },
  } = auth.onAuthStateChange((event) => {
    events.push(event);
    if (event === 'INITIAL_SESSION') initialized();
  });
  try {
    await initial;
    const stored = JSON.stringify({
      access_token: 'fixture-old-access',
      refresh_token: 'fixture-refresh',
      expires_at: Math.floor(Date.now() / 1000) - 1,
      user: { id: 'fixture-owner' },
    });
    localStorage.setItem(key, stored);
    vi.useFakeTimers();
    const refreshing = auth.refreshSession();
    await vi.advanceTimersByTimeAsync(32_000);
    const { data, error } = await refreshing;
    expect(fetch.mock.calls.length).toBeGreaterThan(0);
    return {
      session: data.session,
      error,
      sessionPreserved: localStorage.getItem(key) === stored,
      events,
    };
  } finally {
    subscription.unsubscribe();
  }
}

test.each([
  ['rate-limit', () => Response.json({ error_code: 'over_request_rate_limit' }, { status: 429 })],
  ['gateway', () => new Response('upstream unavailable', { status: 507 })],
  ['unavailable', () => new Response('service unavailable', { status: 503 })],
  ['unknown-refusal', () => new Response('gateway authorization page', { status: 401 })],
  [
    'modern-precedence',
    () =>
      Response.json(
        { code: 'over_request_rate_limit', error_code: 'refresh_token_not_found' },
        { status: 400, headers: { 'X-Supabase-Api-Version': '2024-01-01' } },
      ),
  ],
  ['malformed-success', () => Response.json({ message: 'upstream proxy' })],
] as const)('real auth SDK preserves an expired session on %s', async (label, response) => {
  const result = await refreshExpiredSession(label, response);
  expect(isAuthRetryableFetchError(result.error)).toBe(true);
  expect(result.sessionPreserved).toBe(true);
  expect(result.events).not.toContain('SIGNED_OUT');
});

test.each([
  ['terminal-legacy', { error: 'invalid_grant' }, 'invalid_grant', null],
  ['terminal-modern', { code: 'refresh_token_not_found' }, 'refresh_token_not_found', '2024-01-01'],
  [
    'terminal-numeric-legacy',
    { code: 400, error_code: 'refresh_token_not_found', msg: 'Refresh token not found' },
    'refresh_token_not_found',
    '2024-01-01',
  ],
  [
    'terminal-legacy-precedence',
    { code: 'unrecognized', error_code: 'refresh_token_not_found' },
    'refresh_token_not_found',
    null,
  ],
] as const)('real auth SDK clears an expired session on %s', async (label, body, code, version) => {
  const headers: Record<string, string> = version ? { 'X-Supabase-Api-Version': version } : {};
  const result = await refreshExpiredSession(label, () =>
    Response.json(body, { status: 400, headers }),
  );
  expect(result.error?.code).toBe(code);
  expect(result.sessionPreserved).toBe(false);
  expect(result.events).toContain('SIGNED_OUT');
});

test('real auth SDK stores a valid replacement session', async () => {
  const result = await refreshExpiredSession('success', () =>
    Response.json({
      access_token: 'fixture-next-access',
      refresh_token: 'fixture-next-refresh',
      expires_in: 3600,
      user: { id: 'fixture-owner' },
    }),
  );
  expect(result.error).toBeNull();
  expect(result.session?.access_token).toBe('fixture-next-access');
  expect(result.events).toContain('TOKEN_REFRESHED');
});

test('real auth SDK retains the stored session during bootstrap rate limiting', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://refresh-bootstrap.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'fixture-anon');
  const storageKey = 'sb-refresh-bootstrap-auth-token';
  const stored = JSON.stringify({
    access_token: 'fixture-old-access',
    refresh_token: 'fixture-refresh',
    expires_at: Math.floor(Date.now() / 1000) - 1,
    user: { id: 'fixture-owner' },
  });
  localStorage.setItem(storageKey, stored);
  const fetch = vi.fn(async () =>
    Response.json({ error_code: 'over_request_rate_limit' }, { status: 429 }),
  );
  vi.stubGlobal('fetch', fetch);
  vi.resetModules();
  vi.useFakeTimers();
  const { auth } = await import('./supabase');
  const events: string[] = [];
  let initialized!: () => void;
  const initial = new Promise<void>((resolve) => {
    initialized = resolve;
  });
  const {
    data: { subscription },
  } = auth.onAuthStateChange((event) => {
    events.push(event);
    if (event === 'INITIAL_SESSION') initialized();
  });
  try {
    await vi.advanceTimersByTimeAsync(32_000);
    await initial;
    expect(fetch.mock.calls.length).toBeGreaterThan(0);
    expect(localStorage.getItem(storageKey)).toBe(stored);
    expect(events).not.toContain('SIGNED_OUT');
  } finally {
    subscription.unsubscribe();
    await auth.stopAutoRefresh();
  }
});
