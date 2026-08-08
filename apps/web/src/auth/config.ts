// Три вещи supabase-js выводил из VITE_SUPABASE_URL сам; голый @supabase/auth-js не выводит
// ничего, а все его опции необязательны — забытая подставится МОЛЧА (url → localhost:9999,
// storageKey → 'supabase.auth.token'). Здесь воспроизведены две формулы супабейсовского
// клиента (SupabaseClient.ts:319 и :324) — третья, заголовки, задаётся в supabase.ts.

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

// supabase-js тримил вход ОДИН раз, до обеих формул (helpers.ts:108 `supabaseUrl?.trim()`),
// поэтому пробел по краям VITE_SUPABASE_URL ему прощался. Без trim ломается ровно authUrl
// и ровно на ХВОСТОВОМ пробеле: ensureTrailingSlash дописывает слэш и уводит пробел в
// СЕРЕДИНУ строки, а URL-парсер срезает пробелы только по краям (переводы строки он
// выкусывает откуда угодно — поэтому '\n' безобиден, а ' ' нет). Бросок пришёлся бы на
// импорт auth/supabase.ts, то есть на белый экран всего приложения, а не на экран входа.
function normalize(base: string): string {
  return base.trim();
}

/** `https://ref.supabase.co` → `https://ref.supabase.co/auth/v1`, без двойного слэша. */
export function authUrl(base: string): string {
  return new URL('auth/v1', ensureTrailingSlash(normalize(base))).href;
}

/** Ключ localStorage живой сессии: `https://ref.supabase.co` → `sb-ref-auth-token`. */
export function storageKeyFor(base: string): string {
  return `sb-${new URL(normalize(base)).hostname.split('.')[0]}-auth-token`;
}
