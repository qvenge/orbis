// scripts/setup-db.ts — создание роли orbis_app (findings B7: NOINHERIT + членство
// в authenticated). Идемпотентен. НЕ глушит notices (findings грабля 1).
import postgres from 'postgres';

const admin = process.env.DATABASE_URL_ADMIN;
const password = process.env.ORBIS_APP_PASSWORD;
if (!admin || !password) throw new Error('setup-db: нужны DATABASE_URL_ADMIN и ORBIS_APP_PASSWORD');

const sql = postgres(admin, { max: 1 }); // без onnotice-глушилки — предупреждения должны быть видны
try {
  const [{ exists }] = await sql`
    SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'orbis_app') AS exists`;
  if (!exists) {
    await sql.unsafe(
      `CREATE ROLE orbis_app LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
       PASSWORD '${password.replaceAll("'", "''")}'`,
    );
  } else {
    await sql.unsafe(`ALTER ROLE orbis_app PASSWORD '${password.replaceAll("'", "''")}'`);
  }
  await sql`GRANT authenticated TO orbis_app`;
  // Верификация вместо тихого провала (findings грабля 1)
  const [check] = await sql`
    SELECT rolbypassrls, rolsuper,
           pg_has_role('orbis_app', 'authenticated', 'MEMBER') AS is_member
    FROM pg_roles WHERE rolname = 'orbis_app'`;
  if (!check || check.rolbypassrls || check.rolsuper || !check.is_member) {
    throw new Error(`setup-db: роль в неожиданном состоянии: ${JSON.stringify(check)}`);
  }
  console.log('setup-db: orbis_app готова (NOBYPASSRLS, NOINHERIT, member of authenticated)');
} finally {
  await sql.end();
}
