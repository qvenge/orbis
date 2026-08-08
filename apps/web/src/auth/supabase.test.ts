import { expect, test } from 'vitest';
import { auth } from './supabase';

// Этот файл НАМЕРЕННО читает protected-поля построенного клиента. Причина, а не грязь:
// config.test.ts пиннит формулы, но не их ПРИМЕНЕНИЕ, а применение — самое хрупкое место
// всей миграции. Все поля GoTrueClientOptions необязательны, поэтому удалённая строка
// `storageKey: storageKeyFor(url)` не даёт ни ошибки типов, ни ошибки рантайма: сборка,
// линт, typecheck и остальные 630 тестов остаются зелёными, а прод начинает читать сессию
// из ключа 'supabase.auth.token' вместо 'sb-<ref>-auth-token' — то есть молча разлогинивает
// всех живых пользователей. Публичного геттера у клиента нет вовсе (GoTrueClient.d.ts:34,
// 47, 48, 96, 99, 100 — всё protected), так что заметить пропажу больше нечем.
//
// Значения ниже — литералы, а не вызовы authUrl()/storageKeyFor(): будь тут вызовы, тест
// повторил бы любую ошибку самих формул и прошёл бы вхолостую.
//
// В тестовом окружении VITE_SUPABASE_* не заданы (.env в apps/web нет), поэтому работают
// фолбэки модуля: 'http://localhost:54321' и 'anon'.
const built = auth as unknown as {
  url: string;
  storageKey: string;
  headers: Record<string, string>;
  flowType: string;
  persistSession: boolean;
  autoRefreshToken: boolean;
  detectSessionInUrl: boolean;
};

test('storageKey — ключ supabase-js, а не молчаливый дефолт auth-js', () => {
  expect(built.storageKey).toBe('sb-localhost-auth-token');
  expect(built.storageKey).not.toBe('supabase.auth.token');
});

test('url — адрес проекта, а не молчаливый дефолт localhost:9999', () => {
  expect(built.url).toBe('http://localhost:54321/auth/v1');
});

test('заголовки несут apikey и Authorization', () => {
  expect(built.headers.apikey).toBe('anon');
  expect(built.headers.Authorization).toBe('Bearer anon');
});

// Честная оговорка про этот тест (проверено мутацией, а не предположено): у persistSession,
// autoRefreshToken, detectSessionInUrl и flowType дефолты auth-js СОВПАДАЮТ с нашими
// значениями, поэтому удаление любой из этих строк из supabase.ts тест НЕ поймает — в
// отличие от storageKey, url и apikey выше, где мутация роняет тесты. Пинится здесь не
// наличие строки, а итоговое поведение: тест выстрелит, если auth-js на апгрейде сменит
// дефолт (например, flowType на 'pkce' — тогда magic link поедет через `?code`, а не через
// hash, и приёмочный смоук сломается) или если кто-то поменяет значения осознанно.
test('поток входа — implicit с разбором ссылки, сессия переживает перезагрузку', () => {
  expect(built.persistSession).toBe(true);
  expect(built.autoRefreshToken).toBe(true);
  expect(built.detectSessionInUrl).toBe(true);
  expect(built.flowType).toBe('implicit');
});
