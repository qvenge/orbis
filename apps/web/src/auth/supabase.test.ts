import { afterAll, expect, test, vi } from 'vitest';

// Этот файл НАМЕРЕННО читает protected-поля построенного клиента. Причина, а не грязь:
// config.test.ts пиннит формулы, но не их ПРИМЕНЕНИЕ, а применение — самое хрупкое место
// всей миграции. Все поля GoTrueClientOptions необязательны, поэтому удалённая строка
// `storageKey: storageKeyFor(url)` не даёт ни ошибки типов, ни ошибки рантайма: сборка,
// линт, typecheck и весь остальной сьют остаются зелёными, а прод начинает читать сессию
// из ключа 'supabase.auth.token' вместо 'sb-<ref>-auth-token' — то есть молча разлогинивает
// всех живых пользователей. Публичного геттера у клиента нет вовсе (GoTrueClient.d.ts:34,
// 47, 48, 96, 99, 100 — всё protected), так что заметить пропажу больше нечем.
//
// Окружение тест задаёт САМ и не полагается на его отсутствие. Прежняя версия читала
// фолбэки модуля и «работала» ровно до первого `apps/web/.env` у разработчика: с заданными
// VITE_SUPABASE_* падали три теста из четырёх, причём сообщение говорило про несовпавший
// ключ, а не про окружение — и естественной реакцией было ослабить единственного стража
// главного риска работы. Значения ниже подставляются через vi.stubEnv до импорта модуля
// (он читает import.meta.env один раз, на верхнем уровне), поэтому результат одинаков на
// голой машине, на машине с .env и в CI.
const URL_ENV = 'https://testproj.supabase.co';
const KEY_ENV = 'test-anon-key-42';

type BuiltClient = {
  url: string;
  storageKey: string;
  headers: Record<string, string>;
  flowType: string;
  persistSession: boolean;
  autoRefreshToken: boolean;
  detectSessionInUrl: boolean;
};

// Ожидания ниже — РУЧНЫЕ литералы, а не вызовы authUrl()/storageKeyFor(): будь тут вызовы,
// тест повторил бы любую ошибку самих формул и прошёл бы вхолостую. Их правильность
// проверяется глазами по формуле supabase-js, а сами формулы пиннятся config.test.ts.
async function build(env: { url?: string; anon?: string }): Promise<BuiltClient> {
  // undefined удаляет переменную — так проверяются фолбэки модуля.
  vi.stubEnv('VITE_SUPABASE_URL', env.url);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', env.anon);
  vi.resetModules(); // клиент строится на импорте — без сброса вернётся кэш прошлого env
  const { getAuthClient, retireAuthClient } = await import('./supabase');
  const client = (await getAuthClient()) as unknown as BuiltClient;
  await retireAuthClient();
  return client;
}

afterAll(() => vi.unstubAllEnvs());

test('storageKey — ключ supabase-js, а не молчаливый дефолт auth-js', async () => {
  const built = await build({ url: URL_ENV, anon: KEY_ENV });
  expect(built.storageKey).toBe('sb-testproj-auth-token');
  expect(built.storageKey).not.toBe('supabase.auth.token');
});

test('url — адрес проекта, а не молчаливый дефолт localhost:9999', async () => {
  const built = await build({ url: URL_ENV, anon: KEY_ENV });
  expect(built.url).toBe('https://testproj.supabase.co/auth/v1');
});

// У apikey формулы нет — значение уходит в заголовок как есть, и «вычисляемое ожидание»
// (`toBe(import.meta.env.VITE_SUPABASE_ANON_KEY)`) выродилось бы в тавтологию: сравнение
// переменной с самой собой зелено и с пустым заголовком тоже. Поэтому честная проверка
// здесь другая: ключ подставляется РАЗЛИЧИМЫМ сентинелом, непохожим ни на URL, ни на
// storageKey, и тест утверждает, что в apikey уехал именно он. Так ловится и пропажа
// строки headers целиком, и путаница «не то значение в не тот заголовок».
test('заголовки несут apikey и Authorization — ровно anon-ключ окружения', async () => {
  const built = await build({ url: URL_ENV, anon: KEY_ENV });
  expect(built.headers.apikey).toBe('test-anon-key-42');
  expect(built.headers.Authorization).toBe('Bearer test-anon-key-42');
});

// Фолбэки модуля тоже под тестом: прежняя версия проверяла их случайно (тестовое окружение
// было пустым), и вместе с переездом на stubEnv это покрытие потерялось бы молча. Локальный
// стенд — единственное, во что имеет право упереться сборка без переменных окружения.
test('без VITE_SUPABASE_* — фолбэки локального стенда, а не дефолты auth-js', async () => {
  const built = await build({});
  expect(built.url).toBe('http://localhost:54321/auth/v1');
  expect(built.storageKey).toBe('sb-localhost-auth-token');
  expect(built.headers.apikey).toBe('anon');
});

// Честная оговорка про этот тест (проверено мутацией, а не предположено): у persistSession,
// autoRefreshToken, detectSessionInUrl и flowType дефолты auth-js СОВПАДАЮТ с нашими
// значениями, поэтому удаление любой из этих строк из supabase.ts тест НЕ поймает — в
// отличие от storageKey, url и apikey выше, где мутация роняет тесты. Пинится здесь не
// наличие строки, а итоговое поведение: тест выстрелит, если auth-js на апгрейде сменит
// дефолт (например, flowType на 'pkce' — тогда magic link поедет через `?code`, а не через
// hash, и приёмочный смоук сломается) или если кто-то поменяет значения осознанно.
test('поток входа — implicit с разбором ссылки, сессия переживает перезагрузку', async () => {
  const built = await build({ url: URL_ENV, anon: KEY_ENV });
  expect(built.persistSession).toBe(true);
  expect(built.autoRefreshToken).toBe(true);
  expect(built.detectSessionInUrl).toBe(true);
  expect(built.flowType).toBe('implicit');
});

const OWNER = '19a9f940-258f-4abe-b092-1e227304a372';
const storageKey = 'sb-testproj-auth-token';

function accessToken(owner: string, exp: number) {
  return `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: owner, exp }))}.synthetic`;
}

test('a real SDK transient failure opens only the validated expired account scope', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', URL_ENV);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({}, { status: 429 })),
  );
  vi.resetModules();
  vi.useFakeTimers();
  const exp = Math.floor(Date.now() / 1000) - 1;
  const raw = JSON.stringify({
    user: { id: OWNER },
    access_token: accessToken(OWNER, exp),
    refresh_token: 'fixture',
    expires_at: exp,
    expires_in: 3600,
  });
  localStorage.setItem(storageKey, raw);
  const { readAuthSession, subscribeAuthSession, retireAuthClient } = await import('./supabase');
  const unsubscribe = subscribeAuthSession(() => {});
  try {
    await vi.advanceTimersByTimeAsync(32_000);
    expect(readAuthSession()).toMatchObject({ status: 'cache-only', userId: OWNER, token: null });
    expect(localStorage.getItem(storageKey)).toBe(raw);
  } finally {
    unsubscribe();
    await retireAuthClient();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  }
});

test('a real SDK terminal refusal removes the local identity instead of opening its cache', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', URL_ENV);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error_code: 'refresh_token_not_found' }, { status: 400 })),
  );
  vi.resetModules();
  const exp = Math.floor(Date.now() / 1000) - 1;
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      user: { id: OWNER },
      access_token: accessToken(OWNER, exp),
      refresh_token: 'fixture',
      expires_at: exp,
      expires_in: 3600,
    }),
  );
  const { readAuthSession, subscribeAuthSession, retireAuthClient } = await import('./supabase');
  const unsubscribe = subscribeAuthSession(() => {});
  try {
    await vi.waitFor(() =>
      expect(readAuthSession()).toMatchObject({ status: 'anon', userId: null }),
    );
    expect(localStorage.getItem(storageKey)).toBeNull();
  } finally {
    unsubscribe();
    await retireAuthClient();
    vi.unstubAllGlobals();
    localStorage.clear();
  }
});

test('a late password grant from a retired SDK cannot restore its storage or the app owner', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', URL_ENV);
  let receiveRequest!: () => void;
  const requested = new Promise<void>((resolve) => {
    receiveRequest = resolve;
  });
  let releaseResponse!: (value: Response) => void;
  const held = new Promise<Response>((resolve) => {
    releaseResponse = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      receiveRequest();
      return held;
    }),
  );
  vi.resetModules();
  const { auth, readAuthSession, subscribeAuthSession, retireAuthClient } = await import(
    './supabase'
  );
  const unsubscribe = subscribeAuthSession(() => {});
  try {
    const pending = auth.signInWithPassword({ email: 'a@example.invalid', password: 'password' });
    await requested;
    await auth.signOut();
    releaseResponse(
      Response.json({
        access_token: accessToken(OWNER, Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'fixture-refresh',
        expires_in: 3600,
        user: { id: OWNER },
      }),
    );
    await pending;
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(readAuthSession()).toMatchObject({ status: 'anon', userId: null, token: null });
  } finally {
    unsubscribe();
    await retireAuthClient();
    vi.unstubAllGlobals();
    localStorage.clear();
  }
});

test('offline shared handoff preserves only its captured same-owner session after authorization', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', URL_ENV);
  const request = vi.fn(() => Promise.reject(new Error('offline')));
  vi.stubGlobal('fetch', request);
  vi.resetModules();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const raw = JSON.stringify({
    user: { id: OWNER },
    access_token: accessToken(OWNER, exp),
    refresh_token: 'fixture',
    expires_at: exp,
    expires_in: 3600,
  });
  sessionStorage.setItem('shared-source', raw);
  const { setAuthClientScope, captureAuthHandoff, retireAuthClient } = await import('./supabase');
  try {
    await setAuthClientScope({ storageKey: 'shared-source', backend: sessionStorage });
    const handoff = captureAuthHandoff();
    expect(handoff?.userId).toBe(OWNER);
    await retireAuthClient();
    expect(handoff?.persistTo(localStorage, storageKey, () => false)).toBe(false);
    localStorage.setItem(storageKey, 'other session');
    expect(handoff?.persistTo(localStorage, storageKey, () => true)).toBe(false);
    expect(localStorage.getItem(storageKey)).toBe('other session');
    localStorage.removeItem(storageKey);
    expect(handoff?.persistTo(localStorage, storageKey, () => true)).toBe(true);
    expect(localStorage.getItem(storageKey)).toBe(raw);
    expect(sessionStorage.getItem('shared-source')).toBe(raw);
    expect(request).not.toHaveBeenCalled();
  } finally {
    await retireAuthClient();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  }
});

test('switching scope waits for the retiring SDK channel before publishing a new client', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', URL_ENV);
  vi.resetModules();
  const { getAuthClient, setAuthClientScope, retireAuthClient } = await import('./supabase');
  const old = await getAuthClient();
  let finishDispose!: () => void;
  const held = new Promise<void>((resolve) => {
    finishDispose = resolve;
  });
  const dispose = old.dispose.bind(old);
  const spy = vi.spyOn(old, 'dispose').mockImplementation(async () => {
    await held;
    await dispose();
  });
  try {
    const switching = setAuthClientScope({ storageKey: 'next-scope', backend: sessionStorage });
    let acquired = false;
    const next = Promise.resolve(getAuthClient()).then((client) => {
      acquired = true;
      return client;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    finishDispose();
    await switching;
    expect(await next).not.toBe(old);
  } finally {
    finishDispose();
    await retireAuthClient();
    spy.mockRestore();
  }
});

test('retired auth cannot reopen its retained credential before explicit scope admission', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', URL_ENV);
  vi.resetModules();
  const { getAuthClient, setAuthClientScope, retireAuthClient } = await import('./supabase');
  await getAuthClient();
  await retireAuthClient();
  await expect(getAuthClient()).rejects.toThrow();
  await setAuthClientScope({ storageKey: 'fresh', backend: null });
  await expect(getAuthClient()).resolves.toBeDefined();
  await retireAuthClient();
});

test('freshness refresh cannot receive an expired bearer even if the SDK returned a Session', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', URL_ENV);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const raw = JSON.stringify({
    user: { id: OWNER },
    access_token: accessToken(OWNER, exp),
    refresh_token: 'fixture',
    expires_at: exp,
    expires_in: 3600,
  });
  localStorage.setItem(storageKey, raw);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        user: { id: OWNER },
        access_token: accessToken(OWNER, exp - 7200),
        refresh_token: 'next',
        expires_in: 3600,
      }),
    ),
  );
  vi.resetModules();
  const { auth, retireAuthClient } = await import('./supabase');
  try {
    const result = await auth.refreshSession();
    expect(result.data.session).toBeNull();
    expect(result.error?.name).toBe('AuthRetryableFetchError');
  } finally {
    await retireAuthClient();
    vi.unstubAllGlobals();
    localStorage.clear();
  }
});

test('offline cold bootstrap can open its expired cache without waiting for SDK retry', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', URL_ENV);
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const exp = Math.floor(Date.now() / 1000) - 1;
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      user: { id: OWNER },
      access_token: accessToken(OWNER, exp),
      refresh_token: 'fixture',
      expires_at: exp,
      expires_in: 3600,
    }),
  );
  let releaseResponse!: (value: Response) => void;
  const held = new Promise<Response>((resolve) => {
    releaseResponse = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => held),
  );
  vi.resetModules();
  const { readAuthSession, subscribeAuthSession, retireAuthClient } = await import('./supabase');
  const unsubscribe = subscribeAuthSession(() => {});
  try {
    expect(readAuthSession()).toMatchObject({ status: 'cache-only', userId: OWNER, token: null });
  } finally {
    unsubscribe();
    await retireAuthClient();
    releaseResponse(Response.json({ error_code: 'refresh_token_not_found' }, { status: 400 }));
    online.mockRestore();
    vi.unstubAllGlobals();
    localStorage.clear();
  }
});

test.each([
  'positive',
  'terminal',
])('a late %s refresh cannot mutate a normal session adopted via storage', async (reply) => {
  vi.stubEnv('VITE_SUPABASE_URL', URL_ENV);
  const nextOwner = '12345678-1234-1234-1234-123456789abc';
  const now = Math.floor(Date.now() / 1000);
  const makeSession = (owner: string, expiresAt: number) => ({
    user: { id: owner },
    access_token: accessToken(owner, expiresAt),
    refresh_token: 'refresh-' + owner,
    expires_at: expiresAt,
    expires_in: 3600,
  });
  const original = makeSession(OWNER, now + 3600);
  const replacement = makeSession(nextOwner, now - 60);
  const key = 'sb-testproj-auth-token';
  localStorage.setItem(key, JSON.stringify(original));
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      started();
      return held;
    }),
  );
  vi.resetModules();
  const { auth, getAuthClient, readAuthSession, subscribeAuthSession, retireAuthClient } =
    await import('./supabase');
  const unsubscribe = subscribeAuthSession(() => {});
  try {
    await vi.waitFor(() => expect(readAuthSession().userId).toBe(OWNER));
    await (await getAuthClient()).stopAutoRefresh();
    vi.useFakeTimers();
    const refresh = auth.refreshSession();
    await requested;
    const raw = JSON.stringify(replacement);
    localStorage.setItem(key, raw);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: raw }));
    expect(readAuthSession()).toMatchObject({ status: 'cache-only', userId: nextOwner });
    release(
      reply === 'positive'
        ? Response.json(original)
        : Response.json({ error_code: 'refresh_token_not_found' }, { status: 400 }),
    );
    await vi.advanceTimersByTimeAsync(32_000);
    expect((await refresh).data.session).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key)).toBe(raw);
    expect(readAuthSession()).toMatchObject({ status: 'cache-only', userId: nextOwner });
  } finally {
    unsubscribe();
    await retireAuthClient();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  }
});
