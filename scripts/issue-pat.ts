// scripts/issue-pat.ts — выдача headless-токена внешнего агента (§9.3, Р4).
// С переездом на таблицу грантов (D34) скрипт пишет строку в базу сам: хеш в
// окружении больше не живёт, отзыв делается в настройках, а не передеплоем.
import { makeDb } from '../apps/server/src/db/client';
import { identityOfPerson, parseAccountId } from '../apps/server/src/identity';
import { issuePatGrant, NotGraphOwnerError } from '../apps/server/src/oauth/grants';
// Разбор аргументов — общий с прод-обёрткой (ops.ts issue-pat): `--scope worker` обязан
// значить на стенде ровно то же, что на проде.
import { PAT_USAGE, parsePatArgs } from '../apps/server/src/oauth/pat-args';

const args = parsePatArgs(process.argv.slice(2));
if ('error' in args) {
  console.error(`issue-pat: ${args.error}`);
  console.error(`Использование: bun scripts/issue-pat.ts ${PAT_USAGE}`);
  console.error('account-uuid — uuid аккаунта из Supabase → Authentication → Users;');
  console.error('  грант выдаётся на ЕГО ЛИЧНЫЙ граф (D44)');
  console.error('--scope worker — фоновый исполнитель: чтения и глаголы задач, без прочей записи');
  process.exit(1);
}

const { accountId, label, scope } = args;
const { db, client } = makeDb({ max: 1 });
// Код возврата выставляется ПОСЛЕ `finally`, а не `process.exit` прямо в `catch`: выход из
// catch-ветки ПРОПУСТИЛ бы `finally`, и пул остался бы незакрытым (прежняя редакция звала
// `client.end()` в catch руками — работало, но два места закрытия расходятся при первой правке).
let failed = false;
try {
  // Резолвер 1 (D44): аргумент CLI — граница внешнего мира, пара рождается здесь.
  const token = await issuePatGrant(db, {
    identity: identityOfPerson(parseAccountId(accountId)),
    label,
    scope,
  });
  console.log(`Токен выдан («${label}», область ${scope}). Показывается ОДИН раз:`);
  console.log(`  ${token}`);
  console.log('');
  console.log('Подключение:');
  console.log(
    `  claude mcp add --transport http orbis <url>/mcp --header "Authorization: Bearer ${token}"`,
  );
  console.log('Отзыв — в Настройки → Агенты (или пометить revoked_at в agent_grants).');
} catch (e) {
  // Аккаунт, который ещё ни разу не заходил, личного графа не имеет — и это отказ
  // с текстом, а не сырой 23503 от FK `agent_grants.graph_id` (Р-ИГ-7).
  if (!(e instanceof NotGraphOwnerError)) throw e;
  console.error(`issue-pat: ${e.message}`);
  failed = true;
} finally {
  await client.end();
}
if (failed) process.exit(1);
