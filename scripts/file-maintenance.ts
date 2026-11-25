// Offline operator entrypoint. The server scheduler uses the same graph-scoped pass.
import { makeDb } from '../apps/server/src/db/client';
import { fileGcMode, maintainFiles } from '../apps/server/src/files/gc';
import { identitiesForScheduler, parseGraphId } from '../apps/server/src/identity';

const [mode, id] = Bun.argv.slice(2);
if (!id || !['audit', 'repair', 'delete'].includes(mode ?? '')) {
  throw Error('Использование: bun scripts/file-maintenance.ts audit|repair|delete <graph-id>');
}
if (mode === 'delete' && fileGcMode() !== 'delete')
  throw Error('Для удаления требуется ORBIS_FILE_GC=delete.');
const graph = parseGraphId(id);
const { db, client } = makeDb();
try {
  const identity = (await identitiesForScheduler(db)).find((row) => row.graph === graph);
  if (!identity) throw Error('Граф с действующим владельцем не найден.');
  const ctx = { db, identity };
  if (mode !== 'audit' && mode !== 'repair' && mode !== 'delete') throw Error('Неизвестный режим.');
  const report = await maintainFiles(ctx, mode);
  console.log(JSON.stringify(report, null, 2));
  const after = mode === 'repair' ? await maintainFiles(ctx, 'audit') : report;
  if (mode === 'repair') console.log('Сверка после ремонта', JSON.stringify(after, null, 2));
  if (after.unowned.length || after.blocked.length || after.missing.length || after.surplus.length)
    process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
