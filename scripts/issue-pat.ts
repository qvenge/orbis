// scripts/issue-pat.ts — выдача headless-токена внешнего агента (§9.3, Р4).
// С переездом на таблицу грантов (D34) скрипт пишет строку в базу сам: хеш в
// окружении больше не живёт, отзыв делается в настройках, а не передеплоем.
import { makeDb } from '../apps/server/src/db/client';
import { issuePatGrant } from '../apps/server/src/oauth/grants';
// Разбор аргументов — общий с прод-обёрткой (ops.ts issue-pat): `--scope worker` обязан
// значить на стенде ровно то же, что на проде.
import { PAT_USAGE, parsePatArgs } from '../apps/server/src/oauth/pat-args';

const args = parsePatArgs(process.argv.slice(2));
if ('error' in args) {
  console.error(`issue-pat: ${args.error}`);
  console.error(`Использование: bun scripts/issue-pat.ts ${PAT_USAGE}`);
  console.error('owner-uuid — из Supabase → Authentication → Users');
  console.error('--scope worker — фоновый исполнитель: чтения и глаголы задач, без прочей записи');
  process.exit(1);
}

const { ownerId, label, scope } = args;
const { db, client } = makeDb({ max: 1 });
try {
  const token = await issuePatGrant(db, { ownerId, label, scope });
  console.log(`Токен выдан («${label}», область ${scope}). Показывается ОДИН раз:`);
  console.log(`  ${token}`);
  console.log('');
  console.log('Подключение:');
  console.log(
    `  claude mcp add --transport http orbis <url>/mcp --header "Authorization: Bearer ${token}"`,
  );
  console.log('Отзыв — в Настройки → Агенты (или пометить revoked_at в agent_grants).');
} finally {
  await client.end();
}
