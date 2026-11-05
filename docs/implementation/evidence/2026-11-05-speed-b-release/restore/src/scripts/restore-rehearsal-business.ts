import { createHash } from 'node:crypto';
import postgres from 'postgres';

const url = new URL(process.env.DATABASE_URL_ADMIN ?? '');
if (url.hostname !== '127.0.0.1' || !['54342','54343'].includes(url.port) ||
    url.username !== 'supabase_admin' || url.pathname !== '/postgres') throw new Error('not a rehearsal cluster');
const ids = new Map([['54342', '7704502930497941539'], ['54343', '7704502933634711586']]);
const sql = postgres(url.toString(), { max: 1 });
const ident = (value: string) => '"' + value.replaceAll('"', '""') + '"';
try {
  const result = await sql.begin('isolation level repeatable read read only', async (tx) => {
    const [cluster] = await tx<{ id: string }[]>`select system_identifier::text as id from pg_control_system()`;
    if (cluster?.id !== ids.get(url.port)) throw new Error('cluster identity mismatch');
    await tx`set local time zone 'UTC'`;
    const inventory = await tx<{ schema: string; name: string; kind: string }[]>`
      select n.nspname as schema, c.relname as name, c.relkind as kind
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','drizzle') and c.relkind in ('r','p','S')
        and c.relname not in ('change_feed','change_feed_floor','change_feed_id_seq')
      order by n.nspname,c.relname`;
    const snapshot = [];
    for (const { schema, name, kind } of inventory) {
      const fullName = ident(schema) + '.' + ident(name);
      if (kind === 'S') {
        const [value] = await tx.unsafe(`select last_value::text, is_called from ${fullName}`);
        snapshot.push({ table: schema+'.'+name, sequence: value });
        continue;
      }
      const digest = createHash('sha256');
      let count = 0;
      for await (const batch of tx.unsafe(`select to_jsonb(t)::text as payload from ${fullName} t order by to_jsonb(t)::text collate "C"`).cursor(128)) {
        for (const row of batch) { digest.update(String(row.payload)+'\n'); count++; }
      }
      snapshot.push({ table: schema+'.'+name, count, sha256: digest.digest('hex') });
    }
    return snapshot;
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await sql.end();
}
