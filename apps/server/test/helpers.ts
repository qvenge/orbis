// apps/server/test/helpers.ts
import { sql } from 'drizzle-orm';
import { makeDb } from '../src/db/client';

export function requireEnv(): void {
  for (const k of ['DATABASE_URL', 'DATABASE_URL_ADMIN']) {
    if (!process.env[k]) {
      throw new Error(
        `Интеграционные тесты требуют ${k} (локально: bunx supabase start, см. apps/server/.env.example)`,
      );
    }
  }
}

export function appDb() {
  return makeDb({ max: 3 });
}

export function adminDb() {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.DATABASE_URL_ADMIN;
  try {
    return makeDb({ max: 1 });
  } finally {
    process.env.DATABASE_URL = prev;
  }
}

/** Случайный owner: FK на auth.users не объявлен (решение 1 плана), строка в auth не нужна. */
export function freshUserId(): string {
  return crypto.randomUUID();
}

/** Полная зачистка данных между сьютами (админ-DSN, обходит RLS). */
export async function truncateAll(): Promise<void> {
  const { db, client } = adminDb();
  await db.execute(sql`TRUNCATE entities, relations, user_settings, chat_threads,
    chat_messages, ai_usage, entity_origins RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM aspect_definitions WHERE owner_id IS NOT NULL`);
  await client.end();
}
