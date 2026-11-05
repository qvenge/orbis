import { appRouter } from '../apps/server/src/router';
import { makeDb } from '../apps/server/src/db/client';
import { identityOfPerson, parseAccountId } from '../apps/server/src/identity';
import postgres from 'postgres';

for (const [key,user] of [['DATABASE_URL_ADMIN','supabase_admin'],['DATABASE_URL','orbis_app']]) {
  const url = new URL(process.env[key] ?? '');
  if (url.hostname !== '127.0.0.1' || url.port !== '54343' || url.username !== user ||
      url.pathname !== '/postgres') throw new Error('stock-read must use dedicated target');
}
const witness = JSON.parse(await Bun.file('/private/tmp/orbis-b-restore.oE4t8P/log/source-witness.json').text());
const admin = postgres(process.env.DATABASE_URL_ADMIN!, { max: 1 });
const { db, client } = makeDb();
try {
  const [identity] = await admin<{ id:string; floor:string; xmin:string; direct_insert:boolean; helper_execute:boolean; capture_execute:boolean }[]>`
    select system_identifier::text as id, floor::text, pg_snapshot_xmin(pg_current_snapshot())::text as xmin,
      has_table_privilege('authenticated','public.change_feed','INSERT') as direct_insert,
      has_function_privilege('authenticated','public.orbis_feed_entity_graph(uuid,xid8)','EXECUTE') as helper_execute,
      has_function_privilege('authenticated','public.orbis_capture_change_feed()','EXECUTE') as capture_execute
    from pg_control_system(),public.change_feed_floor where change_feed_floor.id=1`;
  if (identity?.id !== '7704502933634711586' || BigInt(identity.floor) <= BigInt(identity.xmin)) throw new Error('wrong stock target or absent XID gap');
  console.log(JSON.stringify({ stockCatalog: identity }));
  const caller = appRouter.createCaller({
    identity: identityOfPerson(parseAccountId(witness.a)), actorKind: 'owner', db, clientVersion: '0.7.0',
  });
  try {
    const page = await caller.changes.reconcile({ from: identity.xmin });
    console.log(JSON.stringify({ outcome: 'stock-read-returned', reset: page.reset, count: page.transactions.length }));
    if (page.reset?.reason !== 'floor' || page.reset.phase !== 'provisional' || page.transactions.length !== 0) {
      throw new Error('stock read unexpectedly escaped both catalog and old-floor controls');
    }
  } catch (error) {
    const diagnostics = [];
    let current = error;
    while (current && typeof current === 'object') {
      const item = current as {name?:string;code?:string;message?:string;cause?:unknown};
      diagnostics.push({ name:item.name, code:item.code, denied:item.message?.match(/permission denied for (?:schema|table|function) [\w.]+/)?.[0] });
      if (item.cause === current) break;
      current=item.cause;
    }
    console.log(JSON.stringify({ outcome: 'stock-read-rejected', diagnostics }));
    if (!diagnostics.some(({code}) => code==='42501')) throw error;
  }
} finally {
  await Promise.all([admin.end(),client.end()]);
}
