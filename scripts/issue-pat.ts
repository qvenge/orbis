// scripts/issue-pat.ts — выдача headless-токена внешнего агента (§9.3, Р4).
// С переездом на таблицу грантов (D34) скрипт пишет строку в базу сам: хеш в
// окружении больше не живёт, отзыв делается в настройках, а не передеплоем.
import { makeDb } from '../apps/server/src/db/client';
import { issuePatGrant } from '../apps/server/src/oauth/grants';

const ownerId = process.argv[2];
const label = process.argv[3] ?? 'headless-агент';
if (!ownerId) {
  console.error('Использование: bun scripts/issue-pat.ts <owner-uuid> [метка]');
  console.error('owner-uuid — из Supabase → Authentication → Users');
  process.exit(1);
}

const { db, client } = makeDb({ max: 1 });
try {
  const token = await issuePatGrant(db, { ownerId, label });
  console.log('Токен выдан. Показывается ОДИН раз — сохрани его в конфиге агента:');
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
