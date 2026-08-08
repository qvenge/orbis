// Три вещи supabase-js выводил из VITE_SUPABASE_URL сам; голый @supabase/auth-js не выводит
// ничего, а все его опции необязательны — забытая подставится МОЛЧА (url → localhost:9999,
// storageKey → 'supabase.auth.token'). Здесь воспроизведены две формулы супабейсовского
// клиента (SupabaseClient.ts:319 и :324) — третья, заголовки, задаётся в supabase.ts.

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** `https://ref.supabase.co` → `https://ref.supabase.co/auth/v1`, без двойного слэша. */
export function authUrl(base: string): string {
  return new URL('auth/v1', ensureTrailingSlash(base)).href;
}

/** Ключ localStorage живой сессии: `https://ref.supabase.co` → `sb-ref-auth-token`. */
export function storageKeyFor(base: string): string {
  return `sb-${new URL(base).hostname.split('.')[0]}-auth-token`;
}
