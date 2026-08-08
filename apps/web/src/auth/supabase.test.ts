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
  const { auth } = await import('./supabase');
  return auth as unknown as BuiltClient;
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
