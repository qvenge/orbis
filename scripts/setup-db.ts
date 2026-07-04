// scripts/setup-db.ts — создание роли orbis_app (findings B7: NOINHERIT + членство
// в authenticated). Идемпотентен. НЕ глушит notices (findings грабля 1).
import postgres from 'postgres';

const admin = process.env.DATABASE_URL_ADMIN;
const password = process.env.ORBIS_APP_PASSWORD;
if (!admin || !password) throw new Error('setup-db: нужны DATABASE_URL_ADMIN и ORBIS_APP_PASSWORD');

// Каноническая дефиниция auth.uid() — дословно из локального стека Supabase CLI
// (совпадает с hosted): coalesce по ОБОИМ GUC — старому одиночному request.jwt.claim.sub
// и новому JSON request.jwt.claims.
const CANONICAL_AUTH_UID = `CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$`;

// Канонизация auth.uid(). Зачем: standalone-образ supabase/postgres (CI service-контейнер)
// несёт из initdb СТАРУЮ дефиницию, читающую только request.jwt.claim.sub; hosted и локальный
// стек (CLI докатывает миграции поверх) — новую, с request.jwt.claims (JSON). Наш код и pgTAP
// ставят только JSON-GUC → в CI auth.uid() возвращал NULL и все owner-политики RLS пустели.
// Выравниваем CI на канон. Идемпотентно: если дефиниция уже читает request.jwt.claims — no-op.
async function canonicalizeAuthUid(sql: postgres.Sql, adminDsn: string): Promise<void> {
  const [uid] = await sql`
    SELECT p.prosrc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'`;
  if (!uid) throw new Error('setup-db: auth.uid() не найдена — это не Supabase-база?');
  if (uid.prosrc.includes('request.jwt.claims')) return; // уже канон (hosted/локальный стек)

  try {
    await sql.unsafe(CANONICAL_AUTH_UID);
  } catch {
    // В standalone-образе роль postgres НЕ superuser, не владеет auth.uid()
    // (владелец — supabase_auth_admin) и не имеет CREATE на схему auth →
    // CREATE OR REPLACE падает. Но supabase_admin (superuser образа) получает
    // тот же POSTGRES_PASSWORD — подключаемся им по тому же DSN. CREATE OR REPLACE
    // от superuser сохраняет владельца функции (supabase_auth_admin) — проверено.
    const suUrl = new URL(adminDsn);
    suUrl.username = 'supabase_admin';
    const su = postgres(suUrl.toString(), { max: 1 });
    try {
      await su.unsafe(CANONICAL_AUTH_UID);
    } finally {
      await su.end();
    }
  }
  // Верификация вместо тихого провала (findings грабля 1).
  const [after] = await sql`
    SELECT p.prosrc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'`;
  if (!after?.prosrc.includes('request.jwt.claims')) {
    throw new Error('setup-db: канонизация auth.uid() не применилась');
  }
  console.log('setup-db: auth.uid() канонизирована (читает request.jwt.claims)');
}

const sql = postgres(admin, { max: 1 }); // без onnotice-глушилки — предупреждения должны быть видны
try {
  await canonicalizeAuthUid(sql, admin);
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
  // Верификация вместо тихого провала (findings грабля 1).
  // rolinherit обязан быть false: INHERIT + членство в authenticated активировало бы
  // table-гранты БЕЗ SET ROLE — deny-by-default вне транзакций молча исчез бы
  // (существующая роль, созданная где-то ещё с INHERIT, иначе прошла бы верификацию).
  const [check] = await sql`
    SELECT rolbypassrls, rolsuper, rolinherit, rolcanlogin,
           pg_has_role('orbis_app', 'authenticated', 'MEMBER') AS is_member
    FROM pg_roles WHERE rolname = 'orbis_app'`;
  if (
    !check ||
    check.rolbypassrls ||
    check.rolsuper ||
    check.rolinherit ||
    !check.rolcanlogin ||
    !check.is_member
  ) {
    throw new Error(`setup-db: роль в неожиданном состоянии: ${JSON.stringify(check)}`);
  }
  console.log('setup-db: orbis_app готова (NOBYPASSRLS, NOINHERIT, member of authenticated)');
} finally {
  await sql.end();
}
