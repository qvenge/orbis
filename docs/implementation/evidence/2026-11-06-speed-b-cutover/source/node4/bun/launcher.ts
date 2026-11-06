import assert from 'node:assert/strict';
import { join } from 'node:path';
import { checkActualDb, checkContainer, checkDsn, loadHandoff } from './identity';

const [tree, dist, readyFile, handoffPath, digest, lane] = Bun.argv.slice(2);
assert(tree?.startsWith('/private/tmp/orbis-') && dist?.startsWith('/private/tmp/orbis-'));
assert.equal(process.env.ORBIS_CUTOVER_DISPOSABLE, '1');
assert(!process.env.DATABASE_URL_ADMIN, 'Server child must not have an admin DSN');
assert(process.env.SUPABASE_JWT_SECRET);
assert(readyFile?.startsWith('/private/tmp/orbis-cutover-'));
assert(handoffPath && digest && (lane === 'N' || lane === 'P'));
const handoff = await loadHandoff(handoffPath, digest, lane);
checkDsn(process.env.DATABASE_URL ?? '', handoff, 'runtime');
await checkContainer(handoff);
const { createApp } = await import(join(tree, 'apps/server/src/app.ts'));
const { makeDb } = await import(join(tree, 'apps/server/src/db/client.ts'));
const { makeAiDeps } = await import(join(tree, 'apps/server/src/ai/send-message.ts'));
const { db, client } = makeDb();
await checkActualDb(client, handoff, 'runtime');
const app = createApp({ db, ai: makeAiDeps({}), webDistDir: dist });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
await Bun.write(readyFile, JSON.stringify({ upstream: server.url.origin }));
process.once('SIGTERM', async () => {
  await server.stop();
  await client.end();
  process.exit(0);
});
