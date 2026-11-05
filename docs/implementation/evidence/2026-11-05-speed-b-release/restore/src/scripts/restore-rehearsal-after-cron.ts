import postgres from 'postgres';
import { makeDb } from '../apps/server/src/db/client';
import { identityOfPerson,parseAccountId } from '../apps/server/src/identity';
import { appRouter } from '../apps/server/src/router';

const scratch='/private/tmp/orbis-b-restore.oE4t8P';
for(const [key,user] of [['DATABASE_URL_ADMIN','supabase_admin'],['DATABASE_URL','orbis_app']]){
  const url=new URL(process.env[key]??'');
  if(url.hostname!=='127.0.0.1'||url.port!=='54343'||url.username!==user||url.pathname!=='/postgres')
    throw new Error('cron readback must use dedicated target');
}
const {eventA,eventB}=JSON.parse(await Bun.file(scratch+'/log/post-rebase-delivery.json').text());
const admin=postgres(process.env.DATABASE_URL_ADMIN!,{max:1});
const {db,client}=makeDb();
try{
  const [state]=await admin<{id:string;floor:string}[]>`select system_identifier::text as id, floor::text from pg_control_system(),public.change_feed_floor where change_feed_floor.id=1`;
  if(state?.id!=='7704502933634711586'||BigInt(state.floor)!==BigInt(eventA.tx)+1n)
    throw new Error('expected the target scheduler floor');
  const b=appRouter.createCaller({identity:identityOfPerson(parseAccountId(eventB.graph)),actorKind:'owner',db,clientVersion:'0.7.0'});
  const old=await b.changes.reconcile({from:eventA.tx});
  const fresh=await b.changes.reconcile({from:state.floor});
  if(old.floor!==state.floor||old.reset?.reason!=='floor'||old.reset.phase!=='complete'||old.transactions.length!==0||
      fresh.reset!==null||fresh.transactions.length!==1||fresh.transactions[0]?.txId!==eventB.tx)
    throw new Error('unexpected reconcile after target scheduler');
  console.log('RESTORE_CRON_RECONCILE '+JSON.stringify({old,fresh}));
} finally {
  await Promise.all([admin.end(),client.end()]);
}
