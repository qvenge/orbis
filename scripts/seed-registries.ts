// scripts/seed-registries.ts — сид встроенных строк трёх реестров (свойства, роли, аспекты)
// для локальной базы и CI. Шаг `bun run db:prepare` (package.json). Требует
// DATABASE_URL_ADMIN: system-строки (`owner_id IS NULL`) пишутся мимо RLS.
//
// Логика — в `apps/server/src/db/seed-registries.ts`, одна на этот скрипт и на прод-операцию
// `bun scripts/ops.ts seed-registries`: до реформы копий upsert'а было две, и расходились
// они бы молча.

import postgres from 'postgres';
import { seedRegistries, seedRegistriesReport } from '../apps/server/src/db/seed-registries';

const admin = process.env.DATABASE_URL_ADMIN;
if (!admin) throw new Error('seed-registries: DATABASE_URL_ADMIN не задан');
const sql = postgres(admin, { max: 1 });
try {
  console.log(seedRegistriesReport(await seedRegistries(sql)));
} finally {
  await sql.end();
}
