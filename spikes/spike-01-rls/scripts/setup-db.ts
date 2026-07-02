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

const sqlAdmin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });

try {
  for (const file of files) {
    const raw = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
    const text = raw.replaceAll('__APP_PASSWORD__', appPassword.replaceAll("'", "''"));
    await sqlAdmin.unsafe(text);
    console.log(`applied: ${file}`);
  }
} finally {
  await sqlAdmin.end();
}
console.log(`setup-db: done (${fallback ? 'fallback app_setting' : 'основная механика claims'})`);
