// apps/server/src/db/with-identity.ts
// Транзакционно-локальная identity (findings B7, SPIKE-01 доказан в 3 средах):
// set_config(..., is_local=true) умирает на commit И rollback; SET LOCAL ROLE
// authenticated даёт default-гранты Supabase и рабочий auth.uid() в политиках.
//
// У транзакции ДВА идентификатора (D44): `sub` — аккаунт-актор (кто действует), `graph` —
// текущий граф (в чьих данных идёт транзакция). Оба едут одними claims. Политики до
// миграции 0021 ключ `graph` игнорируют — они читают только `auth.uid()`; промежуточное
// состояние рабочее, потому что у личного графа значения совпадают (спека §8.1).
import { sql } from 'drizzle-orm';
import type { Identity } from '../identity'; // import type — стирается: db/ остаётся листом
import type { Db } from './client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function withIdentity<T>(
  db: Db,
  who: Identity,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(who.actor)) {
    throw new Error(`withIdentity: actor не UUID: ${JSON.stringify(who.actor)}`);
  }
  if (!UUID_RE.test(who.graph)) {
    throw new Error(`withIdentity: graph не UUID: ${JSON.stringify(who.graph)}`);
  }
  return db.transaction(async (tx) => {
    // Текущий граф — ключом ВНУТРИ тех же claims (спека §3.5): один set_config, одно время жизни с
    // `sub` (is_local = true: умирает на commit И на rollback). Регистр — нижний, как у `sub`: иначе
    // `current_graph_id()` политик и `auth.uid()` разошлись бы на UUID в верхнем регистре.
    const claims = JSON.stringify({
      sub: who.actor.toLowerCase(),
      role: 'authenticated',
      graph: who.graph.toLowerCase(),
    });
    await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`SET LOCAL ROLE authenticated`);
    return fn(tx);
  });
}
