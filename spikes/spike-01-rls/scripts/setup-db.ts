// Идемпотентный сетап БД спайка: роль + таблица + политика.
// Гоняется через ADMIN DSN; работает и с локальным стеком, и с hosted (через Supavisor).
// Использование: bun scripts/setup-db.ts [--fallback]
import postgres from 'postgres';

const adminUrl = process.env.DATABASE_URL_ADMIN;
const appPassword = process.env.ORBIS_APP_PASSWORD;
if (!adminUrl || !appPassword) {
  console.error('Нужны DATABASE_URL_ADMIN и ORBIS_APP_PASSWORD в env (.env)');
  process.exit(1);
}

const fallback = process.argv.includes('--fallback');
const files = fallback
  ? ['sql/01-role.sql', 'sql/02-table.sql', 'sql/02b-table-fallback.sql']
  : ['sql/01-role.sql', 'sql/02-table.sql'];

// Notices НЕ глушим: GRANT на чужую схему может пройти тихим WARNING «no privileges were granted»
const sqlAdmin = postgres(adminUrl, {
  max: 1,
  prepare: false,
  onnotice: (n) => console.warn(`[pg ${n.severity}] ${n.message}`),
});

try {
  for (const file of files) {
    const raw = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
    const text = raw.replaceAll('__APP_PASSWORD__', appPassword.replaceAll("'", "''"));
    await sqlAdmin.unsafe(text);
    console.log(`applied: ${file}`);
  }

  // Верификация фактических привилегий (grant мог тихо не выдаться)
  const checks = await sqlAdmin`
    select has_schema_privilege('orbis_app', 'auth', 'USAGE') as auth_usage,
           has_function_privilege('orbis_app', 'auth.uid()', 'EXECUTE') as uid_execute,
           has_table_privilege('orbis_app', 'spike_items', 'SELECT') as items_select`;
  console.log('привилегии orbis_app:', checks[0]);
  if (!checks[0]!.items_select) {
    console.error('FAIL: нет SELECT на spike_items');
    process.exit(1);
  }
  if (!checks[0]!.auth_usage || !checks[0]!.uid_execute) {
    console.warn(
      'WARN: прямой вызов auth.uid() под orbis_app недоступен (grants на схему auth не выданы). ' +
        'В политиках auth.uid() инлайнится и работает — см. findings, рекомендация для Вехи 0.',
    );
  }
} finally {
  await sqlAdmin.end();
}
console.log(`setup-db: done (${fallback ? 'fallback app_setting' : 'основная механика claims'})`);
