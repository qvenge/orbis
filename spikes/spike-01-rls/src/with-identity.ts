import { sql } from 'drizzle-orm';
import type { Db } from './db';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Транзакционно-локальная identity (контракт PRD 01 §5/§4.10, carried «Механика RLS через Bun API»).
// set_config(..., is_local=true) умирает вместе с транзакцией — и на commit, и на rollback.
// Claims уходят параметром запроса, не интерполяцией — инъекция исключена.
export async function withIdentity<T>(
  db: Db,
  actorUserId: string, // D11: actorUserId в коде, owner_id в БД
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (process.env.IDENTITY_MODE === 'app_setting') {
      await tx.execute(sql`select set_config('app.user_id', ${actorUserId}, true)`);
    } else {
      const claims = JSON.stringify({ sub: actorUserId, role: 'authenticated' });
      await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    }
    return fn(tx);
  });
}

export type { Tx };
