// scripts/issue-pat.ts — выдача PAT внешнего агента (§9.3, решение 1 плана 1b).
// Печатает сырой токен РОВНО ОДИН РАЗ + его sha256 для env; на диск не пишет ничего.
// Hash-only: сервер хранит только хеш — потерянный токен не восстановим, выдай новый.
import { createHash } from 'node:crypto';

const bytes = crypto.getRandomValues(new Uint8Array(32));
const tokenHex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const token = `orbis_pat_${tokenHex}`;
const hash = createHash('sha256').update(token).digest('hex');

console.log('PAT выдан. Сырой токен показывается ОДИН раз — сохрани его в конфиге агента');
console.log('(агент шлёт заголовок Authorization: Bearer <токен>):');
console.log('');
console.log(`  ${token}`);
console.log('');
console.log('В env сервера (локально apps/server/.env, на Render — Environment) положи:');
console.log('');
console.log(`  ORBIS_PAT_HASH=${hash}`);
console.log('  ORBIS_PAT_OWNER_ID=<uuid владельца, от чьего имени действует агент>');
console.log('');
console.log('Отзыв токена = смена/удаление ORBIS_PAT_HASH и перезапуск сервера.');
