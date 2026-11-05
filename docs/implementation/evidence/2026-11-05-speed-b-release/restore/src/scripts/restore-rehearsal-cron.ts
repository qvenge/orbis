import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';

const scratch='/private/tmp/orbis-b-restore.oE4t8P';
const url=new URL(process.env.DATABASE_URL_ADMIN??'');
if(url.hostname!=='127.0.0.1'||url.port!=='54343'||url.username!=='supabase_admin'||url.pathname!=='/postgres')
  throw new Error('cron probe must use only the dedicated target');
const {eventA,eventB}=JSON.parse(await Bun.file(scratch+'/log/post-rebase-delivery.json').text());
if(!/^\d+$/.test(eventA.tx)||!/^\d+$/.test(eventB.tx)||BigInt(eventA.tx)>=BigInt(eventB.tx))
  throw new Error('two ordered committed feed events required');
const sql=postgres(url.toString(),{max:1});
const check=(ok:unknown,message:string)=>{if(!ok)throw new Error(message);};
const log=(name:string,value:unknown)=>console.log(name+' '+JSON.stringify(value));
const jobs=()=>sql<{jobid:string;jobname:string;schedule:string;database:string;username:string;active:boolean;command_md5:string}[]>`
  select jobid::text,jobname,schedule,database,username,active,md5(command) as command_md5 from cron.job
  where jobname in ('orbis_perf_samples_cleanup','orbis_change_feed_cleanup') order by jobname`;
try{
  const [identity]=await sql<{id:string;role:string;user_name:string;dbname:string;alter_signature:string|null}[]>`
    select system_identifier::text as id,current_user as role,session_user as user_name,current_database() as dbname,
      to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)')::text as alter_signature from pg_control_system()`;
  check(identity?.id==='7704502933634711586'&&identity.role==='supabase_admin'&&
    identity.user_name==='supabase_admin'&&identity.dbname==='postgres'&&identity.alter_signature,'target identity/cron signature mismatch');
  const beforeJobs=await jobs();
  const [before]=beforeJobs;
  check(beforeJobs.length===2&&before?.jobname==='orbis_change_feed_cleanup'&&before.jobid==='2'&&
    before.active&&before.username==='supabase_admin'&&before.database==='postgres'&&
    before.schedule==='27 3 * * *'&&before.command_md5==='44eef3fd87b85bcb91673ffd42313d08','unexpected feed cleanup job');
  check(beforeJobs[1]?.jobname==='orbis_perf_samples_cleanup'&&beforeJobs[1]?.jobid==='1'&&
    beforeJobs[1]?.schedule==='17 3 * * *'&&beforeJobs[1]?.command_md5==='e3e6e9ebd7f86a044de232703e6d5264','unexpected perf cleanup job');
  const jid=before!.jobid;
  const [initial]=await sql<{floor:string;old_n:number;fresh_n:number;old_already:number;feed_n:number}[]>`
    select floor::text,(select count(*)::int from public.change_feed where id=${eventA.id}::bigint and
      tx_id=${eventA.tx}::xid8 and graph_id=${eventA.graph}::uuid and kind='entity' and row_key=${eventA.row_key}) as old_n,
      (select count(*)::int from public.change_feed where id=${eventB.id}::bigint and
      tx_id=${eventB.tx}::xid8 and graph_id=${eventB.graph}::uuid and kind='entity' and row_key=${eventB.row_key}) as fresh_n,
      (select count(*)::int from public.change_feed where at < now()-interval '7 days') as old_already,
      (select count(*)::int from public.change_feed) as feed_n
    from public.change_feed_floor where id=1`;
  check(initial?.floor==='1004'&&initial.old_n===1&&initial.fresh_n===1&&initial.old_already===0,'unexpected target feed before ageing');
  log('RESTORE_CRON_BEFORE',{beforeJobs,initial});
  let restoreJob=false;
  try{
    restoreJob=true;
    await sql`select cron.alter_job(${jid}::bigint,active=>false)`;
    const disableBy=Date.now()+10_000;
    for(;;){
      const [running]=await sql<{n:number}[]>`select count(*)::int as n from cron.job_run_details
        where jobid=${jid}::bigint and end_time is null and status not in ('succeeded','failed')`;
      if(running?.n===0) break;
      if(Date.now()>disableBy) throw new Error('pre-existing cleanup run did not finish');
      await Bun.sleep(250);
    }
    const aged=await sql.begin(async(tx)=>tx<{id:string}[]>`
      update public.change_feed set at=clock_timestamp()-interval '8 days'
      where id=${eventA.id}::bigint and tx_id=${eventA.tx}::xid8 and graph_id=${eventA.graph}::uuid and kind='entity'
      returning id::text`);
    check(aged.length===1&&aged[0]?.id===eventA.id,'did not age exactly the expected old entity event');
    const [fence]=await sql<{time:string;max_run:string}[]>`select clock_timestamp()::text as time,
      coalesce((select max(runid) from cron.job_run_details where jobid=${jid}::bigint),0)::text as max_run`;
    check(fence?.time&&/^\d+$/.test(fence.max_run),'missing post-commit cron fence');
    log('RESTORE_CRON_FENCE',{jid,aged,fence});
    await sql`select cron.alter_job(${jid}::bigint,schedule=>'* * * * *',active=>true)`;
    const [enabled]=await jobs();
    check(enabled?.jobid===jid&&enabled.command_md5===before!.command_md5&&
      enabled.username===before!.username&&enabled.schedule==='* * * * *'&&enabled.active,'temporary schedule changed job identity');
    const timeout=Date.now()+125_000;
    type Run={jobid:string;runid:string;username:string;status:string;start_time:string;end_time:string|null;command_md5:string;after_fence:boolean};
    let run:Run|undefined;
    while(Date.now()<timeout){
      [run]=await sql<Run[]>`select jobid::text,runid::text,username,status,start_time::text,end_time::text,
        md5(command) as command_md5,(start_time>${fence!.time}::timestamptz) as after_fence
        from cron.job_run_details where jobid=${jid}::bigint
        and runid>${fence!.max_run}::bigint and start_time>${fence!.time}::timestamptz order by runid limit 1`;
      if(run?.status==='failed') throw new Error('first post-fence cron run failed');
      if(run?.status==='succeeded'&&run.end_time) break;
      await Bun.sleep(500);
    }
    check(run?.status==='succeeded'&&run.end_time&&run.jobid===jid&&run.after_fence&&
      run.username===before!.username&&run.command_md5===before!.command_md5,'no successful actual cron run within two intervals');
    const [after]=await sql<{floor:string;old_n:number;fresh_n:number;feed_n:number}[]>`
      select floor::text,(select count(*)::int from public.change_feed where id=${eventA.id}::bigint) as old_n,
        (select count(*)::int from public.change_feed where id=${eventB.id}::bigint and tx_id=${eventB.tx}::xid8) as fresh_n,
        (select count(*)::int from public.change_feed) as feed_n
      from public.change_feed_floor where id=1`;
    check(after?.floor===(BigInt(eventA.tx)+1n).toString()&&after.old_n===0&&after.fresh_n===1&&
      after.feed_n===initial!.feed_n-1,'actual cron did not remove just the aged event and advance floor');
    log('RESTORE_CRON_ACTUAL',{run,after,eventA,eventB});
  } finally{
    if(restoreJob){
      await sql`select cron.alter_job(${jid}::bigint,schedule=>${before!.schedule},active=>${before!.active})`;
      const restored=await jobs();
      log('RESTORE_CRON_RESTORED',restored);
      check(isDeepStrictEqual(restored,beforeJobs),'original scheduler state was not restored exactly');
    }
  }
}finally{
  await sql.end();
}
