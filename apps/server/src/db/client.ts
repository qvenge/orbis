import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Фабрика, не синглтон (по образцу spikes/spike-01-rls/src/db.ts).
// prepare=false обязателен для transaction-пулера Supavisor (:6543): prepared statements
// несовместимы с transaction-режимом — см. docs/implementation/01-phase0-findings.md (D12).
// По умолчанию prepare=true (директ :5432 / session :6543-нет); выключается env PG_PREPARE=false.
export function makeDb(opts: { max?: number; prepare?: boolean } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('makeDb: DATABASE_URL не задан (см. apps/server/.env.example)');
  const client = postgres(url, {
    max: opts.max ?? 3,
    prepare: opts.prepare ?? process.env.PG_PREPARE !== 'false',
    onnotice: () => {},
  });
  const db = drizzle(client, { schema });
  return { db, client };
}

export type Db = ReturnType<typeof makeDb>['db'];
