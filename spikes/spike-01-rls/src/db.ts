import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

// Фабрика, не синглтон: тестам нужны пулы разного размера
// (max=1 — детерминированное переиспользование коннекшна, max=2 — interleaving).
export function makeDb(opts: { max?: number; prepare?: boolean } = {}) {
  const client = postgres(process.env.DATABASE_URL_APP!, {
    max: opts.max ?? 3,
    // prepare=false обязателен для transaction-пулера Supavisor (6543)
    prepare: opts.prepare ?? process.env.PG_PREPARE !== 'false',
    onnotice: () => {},
  });
  const db = drizzle(client, { schema });
  return { db, client };
}

export type Db = ReturnType<typeof makeDb>['db'];
