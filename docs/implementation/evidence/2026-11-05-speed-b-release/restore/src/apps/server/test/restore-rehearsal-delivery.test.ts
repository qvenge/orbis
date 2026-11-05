import { afterAll, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CLIENT_VERSION_HEADER, type ChangePage } from '@orbis/shared';
import { SignJWT } from 'jose';
import postgres from 'postgres';
import type { AiDeps } from '../src/ai/send-message';
import { createApp } from '../src/app';
import { makeDb } from '../src/db/client';
import { startChangeListener } from '../src/freshness/listener';
import { identityOfPerson, parseAccountId } from '../src/identity';
import { issuePatGrant } from '../src/oauth/grants';
import { appRouter } from '../src/router';

const scratch='/private/tmp/orbis-b-restore.oE4t8P';
for (const [key,user] of [['DATABASE_URL_ADMIN','supabase_admin'],['DATABASE_URL','orbis_app']]) {
  const url = new URL(process.env[key] ?? '');
  if (url.hostname !== '127.0.0.1' || url.port !== '54343' || url.username !== user ||
      url.pathname !== '/postgres') throw new Error('delivery probe must use dedicated target');
}
if (process.env.ORBIS_ROUTINE_SCHEDULER !== '0' || process.env.ORBIS_CHANGE_STREAM === '0' ||
    process.env.SUPABASE_URL || process.env.SUPABASE_JWKS_URL) throw new Error('unexpected local runtime environment');
const secret=process.env.SUPABASE_JWT_SECRET;
if (!secret) throw new Error('missing disposable local JWT secret');
const witness=JSON.parse(await Bun.file(scratch+'/log/source-witness.json').text());
const admin=postgres(process.env.DATABASE_URL_ADMIN!,{max:1});
const {db,client,makeListenerClient}=makeDb();
afterAll(async()=>{await Promise.all([admin.end(),client.end()]);});

function log(name:string,value:unknown){console.log(name+' '+JSON.stringify(value));}
function waitFor<T>(promise:Promise<T>,label:string,ms=12_000):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  return Promise.race([promise,new Promise<T>((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+' functional deadline')),ms);
  })]).finally(()=>clearTimeout(timer));
}
function pageOf(value:unknown):ChangePage|undefined{
  if (!value || typeof value!=='object') return;
  if ('watermark' in value && 'floor' in value && 'transactions' in value) return value as ChangePage;
  for (const child of Object.values(value)) {
    const found=pageOf(child);
    if(found) return found;
  }
}
async function jwt(id:string) {
  return new SignJWT({role:'authenticated'}).setProtectedHeader({alg:'HS256'}).setSubject(id)
    .setAudience('authenticated').setExpirationTime('10m').sign(new TextEncoder().encode(secret));
}
type Entry={ id:string|null; page:ChangePage };
const aborts:AbortController[]=[];
function connect(origin:string,token:string,from:string,lastId?:string) {
  const abort=new AbortController();
  aborts.push(abort);
  const seen:Entry[]=[];
  let reader:ReadableStreamDefaultReader<Uint8Array>;
  let buffer='';
  const decoder=new TextDecoder();
  async function open(){
    const url=new URL('/trpc/changes.watch',origin);
    url.searchParams.set('input',JSON.stringify({from}));
    const response=await waitFor(fetch(url,{
      headers:{Authorization:'Bearer '+token,[CLIENT_VERSION_HEADER]:'0.7.0',...(lastId?{'Last-Event-ID':lastId}:{})},
      signal:abort.signal,
    }),'SSE handshake');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    reader=response.body!.getReader();
  }
  async function readUntil(predicate:(entry:Entry)=>boolean){
    for(;;){
      const boundary=buffer.indexOf('\n\n');
      if(boundary<0){
        const chunk=await reader.read();
        if(chunk.done) throw new Error('SSE ended before expected page');
        buffer+=decoder.decode(chunk.value,{stream:true}).replaceAll('\r\n','\n');
        continue;
      }
      const frame=buffer.slice(0,boundary);
      buffer=buffer.slice(boundary+2);
      const data=frame.split('\n').filter((line)=>line.startsWith('data:')).map((line)=>line.slice(5).trimStart()).join('\n');
      if(!data) continue;
      const page=pageOf(JSON.parse(data));
      if(!page) continue;
      const id=frame.split('\n').find((line)=>line.startsWith('id:'))?.slice(3).trim()??null;
      const entry={id,page};
      seen.push(entry);
      if(predicate(entry)) return entry;
    }
  }
  return {open,seen,next:(predicate:(entry:Entry)=>boolean)=>waitFor(readUntil(predicate),'SSE page'),close:()=>abort.abort()};
}
async function reconcile(origin:string,token:string,from:string){
  const url=new URL('/trpc/changes.reconcile',origin);
  url.searchParams.set('input',JSON.stringify({from}));
  const response=await waitFor(fetch(url,{headers:{Authorization:'Bearer '+token,[CLIENT_VERSION_HEADER]:'0.7.0'}}),'HTTP reconcile');
  expect(response.status).toBe(200);
  const page=pageOf(await response.json());
  if(!page) throw new Error('HTTP response did not contain a change page');
  return page;
}

test('rebased target delivers actual MCP edit over Hono SSE and reconcile with scoped A/B history', async()=>{
  const [state]=await admin<{system_id:string; floor:string; n:number; title_a:string; title_b:string}[]>`
    select system_identifier::text as system_id,floor::text,
      (select count(*)::int from public.change_feed) as n,
      (select title from public.entities where id=${witness.record}::uuid) as title_a,
      (select title from public.entities where id=${witness.foreign}::uuid) as title_b
    from pg_control_system(),public.change_feed_floor where id=1`;
  expect(state).toEqual({system_id:'7704502933634711586',floor:'1004',n:0,
    title_a:'Synthetic target low-XID witness',title_b:'Restore B'});
  let listening!:()=>void;
  const listenReady=new Promise<void>((resolve)=>{listening=resolve;});
  const notices:{graphId?:string;txId:string}[]=[];
  const listener=startChangeListener(()=>{
    const real=makeListenerClient();
    return {
      end:real.end,
      listen:async (...args:Parameters<typeof real.listen>)=>{
        const result=await real.listen(args[0],(payload)=>{notices.push(JSON.parse(payload));args[1](payload);},args[2]);
        listening();
        return result;
      },
    };
  });
  const app=createApp({db,ai:{} as AiDeps,changeListener:listener});
  const requests:{path:string;header:boolean;tokenInQuery:boolean}[]=[];
  const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch(request){
    const url=new URL(request.url);
    if(url.pathname.startsWith('/trpc/changes.')){
      server.timeout(request,24);
      requests.push({path:url.pathname,header:request.headers.get('authorization')?.startsWith('Bearer ')??false,
        tokenInQuery:/bearer|access.token|authorization/i.test(url.search)});
    }
    return app.fetch(request);
  }});
  const agent=new Client({name:'orbis-local-logical-restore',version:'0.7.0'});
  try{
    await waitFor(listenReady,'PostgreSQL LISTEN startup');
    const identityA=identityOfPerson(parseAccountId(witness.a));
    const identityB=identityOfPerson(parseAccountId(witness.b));
    const [tokenA,tokenB]=await Promise.all([jwt(witness.a),jwt(witness.b)]);
    const origin=server.url.origin;
    const prior=await reconcile(origin,tokenA,witness.sourceCursor);
    const zero=await reconcile(origin,tokenA,'0');
    expect(prior).toMatchObject({floor:state!.floor,reset:{reason:'future-cursor',phase:'complete'},transactions:[]});
    expect(zero).toMatchObject({floor:state!.floor,reset:{reason:'floor',phase:'complete'},transactions:[]});
    expect(BigInt(prior.watermark)).toBeGreaterThanOrEqual(BigInt(state!.floor));
    expect(BigInt(prior.watermark)).toBeLessThan(BigInt(witness.sourceCursor));
    const a=connect(origin,tokenA,'0',witness.sourceCursor);
    const b=connect(origin,tokenB,witness.sourceCursor);
    await Promise.all([a.open(),b.open()]);
    const [oldA,oldB]=await Promise.all([a.next(({page})=>page.reset!==null),b.next(({page})=>page.reset!==null)]);
    for(const entry of [oldA,oldB]){
      expect(entry.page.reset).toMatchObject({reason:'future-cursor',phase:'complete'});
      expect(entry.id).toBe(entry.page.watermark);
    }
    log('RESTORE_POSTREBASE_RESET',{prior,zero,oldA,oldB});

    const pat=await issuePatGrant(db,{identity:identityA,label:'Synthetic local restore delivery'});
    await waitFor(agent.connect(new StreamableHTTPClientTransport(new URL('/mcp',server.url),{
      requestInit:{headers:{Authorization:'Bearer '+pat}},
    })),'MCP connect');
    const result=await waitFor(agent.callTool({name:'entity_update',arguments:{id:witness.record,title:'Restored target post-rebase SSE'}}),'actual MCP edit');
    expect(result.isError??false).toBe(false);
    const [eventA]=await admin<{tx:string;id:string;graph:string;row_key:string}[]>`
      select tx_id::text as tx,id::text,graph_id::text as graph,row_key
      from public.change_feed where kind='entity' and row_key=${witness.record} and operation='update'`;
    if(!eventA) throw new Error('actual MCP write has no exact target feed row');
    log('RESTORE_MCP_COMMITTED',eventA);
    expect(eventA.graph).toBe(witness.a);
    expect(BigInt(eventA.tx)).toBeGreaterThanOrEqual(BigInt(state!.floor));
    expect(BigInt(eventA.tx)).toBeLessThan(BigInt(witness.sourceFloor));
    expect(BigInt(eventA.id)).toBeGreaterThan(87n);
    const seenA=await a.next(({page})=>page.transactions.some(({txId})=>txId===eventA.tx));
    expect(seenA.id).toBe(seenA.page.watermark);
    expect(seenA.page.transactions.find(({txId})=>txId===eventA.tx)?.changes)
      .toContainEqual(expect.objectContaining({kind:'entity',rowKey:witness.record,operation:'update'}));
    expect(notices.some((item)=>item.txId===eventA.tx&&item.graphId===witness.a)).toBe(true);

    // Causal barrier for graph B: observe its own later edit over the same SSE connection.
    const cb=appRouter.createCaller({identity:identityB,actorKind:'owner',db,clientVersion:'0.7.0'});
    const writeB=await cb.entity.update({id:witness.foreign,title:'Restored target graph B fresh',expectedTitle:'Restore B'});
    const [eventB]=await admin<{tx:string;id:string;graph:string;row_key:string}[]>`
      select tx_id::text as tx,id::text,graph_id::text as graph,row_key
      from public.change_feed where kind='entity' and row_key=${witness.foreign} and operation='update'`;
    if(!eventB) throw new Error('graph B write has no exact feed row');
    expect(eventB).toMatchObject({tx:writeB.txId,graph:witness.b,row_key:witness.foreign});
    expect(BigInt(eventB.tx)).toBeGreaterThan(BigInt(eventA.tx));
    const seenB=await b.next(({page})=>page.transactions.some(({txId})=>txId===eventB.tx));
    expect(seenB.id).toBe(seenB.page.watermark);
    expect(b.seen.flatMap(({page})=>page.transactions).some(({txId})=>txId===eventA.tx)).toBe(false);
    expect(notices.some((item)=>item.txId===eventB.tx&&item.graphId===witness.b)).toBe(true);
    const [readA,readB]=await Promise.all([reconcile(origin,tokenA,oldA.page.watermark),reconcile(origin,tokenB,oldB.page.watermark)]);
    expect(readA.transactions.map(({txId})=>txId)).toEqual([eventA.tx]);
    expect(readB.transactions.map(({txId})=>txId)).toEqual([eventB.tx]);
    expect(requests.every(({header,tokenInQuery})=>header&&!tokenInQuery)).toBe(true);
    log('RESTORE_DELIVERY_WITNESS',{eventA,eventB,seenA,seenB,readA,readB,notices,requests});
  } finally{
    for(const abort of aborts) abort.abort();
    try { await agent.close(); } finally {
      await listener.close();
      await server.stop(true);
    }
  }
},40_000);
