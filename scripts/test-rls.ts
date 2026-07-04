// scripts/test-rls.ts — прогон pgTAP через psql; падаем на любом "not ok"
import { $ } from 'bun';

const admin = process.env.DATABASE_URL_ADMIN;
if (!admin) throw new Error('test-rls: DATABASE_URL_ADMIN не задан');
const out = await $`psql ${admin} -v ON_ERROR_STOP=1 -f apps/server/test/rls/rls.pgtap.sql`.text();
console.log(out);
// \s* — psql выравнивает таблицу ведущим пробелом, голый ^not ok не матчится
if (/^\s*not ok/m.test(out)) {
  console.error('pgTAP: есть проваленные проверки');
  process.exit(1);
}
