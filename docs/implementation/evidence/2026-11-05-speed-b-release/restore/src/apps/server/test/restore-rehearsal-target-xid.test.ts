import { afterAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { makeDb } from '../src/db/client';
import { withIdentity } from '../src/db/with-identity';
import { identityOfPerson, parseAccountId } from '../src/identity';
import { appRouter } from '../src/router';

for (const [key,user] of [['DATABASE_URL_ADMIN','supabase_admin'],['DATABASE_URL','orbis_app']]) {
  const url = new URL(process.env[key] ?? '');
  if (url.hostname !== '127.0.0.1' || url.port !== '54343' || url.username !== user ||
      url.pathname !== '/postgres') throw new Error('target witness must use dedicated target');
}
const archive = JSON.parse(await Bun.file('/private/tmp/orbis-b-restore.oE4t8P/log/source-witness.json').text());
const admin = postgres(process.env.DATABASE_URL_ADMIN!, { max: 1 });
const { db, client } = makeDb();
afterAll(async () => { await Promise.all([admin.end(), client.end()]); });

test('one committed target writer is hidden by the imported source floor', async () => {
  const [target] = await admin<{system_id:string; floor:string; xmin:string; n:number; max_id:string; title:string; rev:number}[]>`
    SELECT system_identifier::text AS system_id, floor::text, pg_snapshot_xmin(pg_current_snapshot())::text AS xmin,
      (SELECT count(*)::int FROM public.change_feed) AS n,
      (SELECT max(id)::text FROM public.change_feed) AS max_id,
      (SELECT title FROM public.entities WHERE id=${archive.record}::uuid) AS title,
      (SELECT body_revision FROM public.entities WHERE id=${archive.record}::uuid) AS rev
    FROM pg_control_system(), public.change_feed_floor WHERE change_feed_floor.id=1`;
  expect(target?.system_id).toBe('7704502933634711586');
  expect(target?.floor).toBe(archive.sourceFloor);
  expect(target?.n).toBe(84);
  expect(target?.title).toBe('Restore A');
  expect(target?.rev).toBe(archive.bodyRevision);
  expect(BigInt(target!.xmin)).toBeLessThan(BigInt(target!.floor));

  const identityA=identityOfPerson(parseAccountId(archive.a));
  const identityB=identityOfPerson(parseAccountId(archive.b));
  const reader = (who: typeof identityA) => withIdentity(db,who,async (tx) => {
    const [acl] = await tx.execute<{ actor_role:string; login_role:string; can_insert:boolean; can_update:boolean; can_delete:boolean; can_truncate:boolean; can_floor_update:boolean; can_helper:boolean; can_capture:boolean }>(sql`
      select current_user as actor_role,session_user as login_role,
        has_table_privilege(current_user,'public.change_feed','INSERT') as can_insert,
        has_table_privilege(current_user,'public.change_feed','UPDATE') as can_update,
        has_table_privilege(current_user,'public.change_feed','DELETE') as can_delete,
        has_table_privilege(current_user,'public.change_feed','TRUNCATE') as can_truncate,
        has_table_privilege(current_user,'public.change_feed_floor','UPDATE') as can_floor_update,
        has_function_privilege(current_user,'public.orbis_feed_entity_graph(uuid,xid8)','EXECUTE') as can_helper,
        has_function_privilege(current_user,'public.orbis_capture_change_feed()','EXECUTE') as can_capture`);
    expect(acl).toEqual({actor_role:'authenticated',login_role:'orbis_app',can_insert:false,can_update:false,
      can_delete:false,can_truncate:false,can_floor_update:false,can_helper:false,can_capture:false});
    const graphs = await tx.execute<{ id:string }>(sql`select distinct graph_id::text as id from public.change_feed order by 1`);
    const [visible] = await tx.execute<{ floor:string }>(sql`select floor::text from public.change_feed_floor`);
    expect(visible?.floor).toBe(target!.floor);
    return Array.from(graphs, ({id}) => id);
  });
  const graphA = await reader(identityA);
  const graphB = await reader(identityB);
  expect(graphA).toEqual([archive.a]);
  expect(graphB).toEqual([archive.b]);
  const noClaims = await client.begin(async (tx) => {
    await tx`set local role authenticated`;
    const [row] = await tx<{ n:number; f:number }[]>`select (select count(*)::int from public.change_feed) as n,
       (select count(*)::int from public.change_feed_floor) as f`;
    return row;
  });
  expect(noClaims).toEqual({n:0,f:0});
  console.log('RESTORE_RLS ' + JSON.stringify({graphA,graphB,noClaims}));

  const caller=appRouter.createCaller({identity:identityA,actorKind:'owner',db,clientVersion:'0.7.0'});
  const write=await caller.entity.update({id:archive.record, title:'Synthetic target low-XID witness', expectedTitle:'Restore A'});
  expect(write.title).toBe('Synthetic target low-XID witness');
  expect(write.bodyRevision).toBe(archive.bodyRevision);
  expect(BigInt(write.txId)).toBeGreaterThanOrEqual(BigInt(target!.xmin));
  expect(BigInt(write.txId)).toBeLessThan(BigInt(target!.floor));
  const events=await admin<{ id:string; tx:string; graph:string; kind:string; row_key:string; operation:string; scope:string }[]>`
    SELECT id::text,tx_id::text AS tx,graph_id::text AS graph,kind,row_key,operation,scope
    FROM public.change_feed WHERE id>${target!.max_id}::bigint ORDER BY id`;
  const exact=events.filter((event)=>event.kind==='entity' && event.row_key===archive.record);
  expect(exact).toHaveLength(1);
  expect(exact[0]).toMatchObject({tx:write.txId,graph:archive.a,operation:'update'});
  expect(events.every(({tx,graph})=>tx===write.txId && graph===archive.a)).toBe(true);
  expect(BigInt(exact[0]!.id)).toBeGreaterThan(BigInt(target!.max_id));
  console.log('RESTORE_TARGET_WRITE ' + JSON.stringify({tx:write.txId,actionId:write.actionId,record:archive.record,bodyRevision:write.bodyRevision,events}));

  const fresh=await caller.changes.reconcile({from:target!.xmin});
  expect(fresh).toMatchObject({floor:target!.floor,reset:{reason:'floor',phase:'provisional'},transactions:[]});
  expect(BigInt(fresh.watermark)).toBeGreaterThan(BigInt(write.txId));
  expect(BigInt(fresh.watermark)).toBeLessThan(BigInt(target!.floor));

  const stale=await caller.changes.reconcile({from:archive.sourceCursor});
  expect(stale).toMatchObject({floor:target!.floor,reset:{reason:'future-cursor',phase:'complete'},transactions:[]});
  expect(BigInt(archive.sourceCursor)).toBeGreaterThan(BigInt(stale.watermark));
  const continued=await caller.changes.reconcile({from:stale.watermark});
  expect(continued).toMatchObject({floor:target!.floor,reset:{reason:'floor',phase:'provisional'},transactions:[]});
  console.log('RESTORE_TARGET_RECONCILE ' + JSON.stringify({freshFrom:target!.xmin,oldSourceFrom:archive.sourceCursor,fresh,stale,continued}));
}, 30_000);
