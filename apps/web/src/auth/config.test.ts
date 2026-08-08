import { expect, test } from 'vitest';
import { authUrl, storageKeyFor } from './config';

// Ключ хранилища ОБЯЗАН совпасть с тем, что supabase-js уже записал в localStorage живым
// пользователям (SupabaseClient.ts:319: `sb-${hostname.split('.')[0]}-auth-token`), иначе
// релиз читает пустой ключ и разлогинивает всех.
test('storageKeyFor воспроизводит формулу supabase-js', () => {
  expect(storageKeyFor('https://ceovqtdibalxnqkgedrl.supabase.co')).toBe(
    'sb-ceovqtdibalxnqkgedrl-auth-token',
  );
  expect(storageKeyFor('http://localhost:54321')).toBe('sb-localhost-auth-token');
  // 127.0.0.1 даёт 'sb-127-auth-token' — выглядит странно, но это ровно то, что писал
  // supabase-js на локальном стенде, и совпасть мы обязаны именно с ним.
  expect(storageKeyFor('http://127.0.0.1:54321')).toBe('sb-127-auth-token');
});

test('storageKeyFor не зависит от хвостового слэша', () => {
  expect(storageKeyFor('https://ceovqtdibalxnqkgedrl.supabase.co/')).toBe(
    'sb-ceovqtdibalxnqkgedrl-auth-token',
  );
});

// supabase-js тримил вход (helpers.ts:108), и терять это нельзя: без trim хвостовой пробел
// в VITE_SUPABASE_URL роняет authUrl прямо на импорте auth/supabase.ts — белым экраном
// всего приложения. Пробел с КРАЯ URL-парсер прощает сам, но ensureTrailingSlash успевает
// увести его в середину строки, где он уже фатален.
test('пробелы по краям базового URL не роняют формулы', () => {
  expect(authUrl('http://localhost:54321 ')).toBe('http://localhost:54321/auth/v1');
  expect(authUrl(' http://localhost:54321')).toBe('http://localhost:54321/auth/v1');
  expect(authUrl(' https://ceovqtdibalxnqkgedrl.supabase.co ')).toBe(
    'https://ceovqtdibalxnqkgedrl.supabase.co/auth/v1',
  );
  expect(storageKeyFor(' https://ceovqtdibalxnqkgedrl.supabase.co ')).toBe(
    'sb-ceovqtdibalxnqkgedrl-auth-token',
  );
});

test('authUrl склеивает без двойного слэша', () => {
  expect(authUrl('https://ceovqtdibalxnqkgedrl.supabase.co')).toBe(
    'https://ceovqtdibalxnqkgedrl.supabase.co/auth/v1',
  );
  expect(authUrl('https://ceovqtdibalxnqkgedrl.supabase.co/')).toBe(
    'https://ceovqtdibalxnqkgedrl.supabase.co/auth/v1',
  );
  expect(authUrl('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321/auth/v1');
});
