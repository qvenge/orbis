import postgres from 'postgres';

// Пул к hosted Supabase через Supavisor.
// session-пулер :5432 → PG_PREPARE=true; transaction-пулер :6543 → PG_PREPARE=false.
export const sql = postgres(process.env.DATABASE_URL!, {
  max: 3,
  prepare: process.env.PG_PREPARE !== 'false',
  onnotice: () => {},
});
