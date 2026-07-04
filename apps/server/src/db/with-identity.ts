// apps/server/src/db/with-identity.ts
// Транзакционно-локальная identity (findings B7, SPIKE-01 доказан в 3 средах):
// set_config(..., is_local=true) умирает на commit И rollback; SET LOCAL ROLE
// authenticated даёт default-гранты Supabase и рабочий auth.uid() в политиках.
import { sql } from 'drizzle-orm';
import type { Db } from './client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function withIdentity<T>(
  db: Db,
  actorUserId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(actorUserId)) {
    throw new Error(`withIdentity: actorUserId не UUID: ${JSON.stringify(actorUserId)}`);
  }
  return db.transaction(async (tx) => {
    const claims = JSON.stringify({ sub: actorUserId.toLowerCase(), role: 'authenticated' });
    await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`SET LOCAL ROLE authenticated`);
    return fn(tx);
  });
}
