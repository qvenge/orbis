// apps/server/test/seed-aspects.test.ts
import { describe, expect, test } from 'bun:test';
import { aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, requireEnv } from './helpers';

requireEnv();

describe('сид реестра аспектов', () => {
  test('7 builtin-строк; schema в БД байт-в-байт равна сгенерированной из shared', async () => {
    const { db, client } = adminDb();
    try {
      const rows = await db.execute(
        sql`SELECT id, schema FROM aspect_definitions WHERE owner_id IS NULL ORDER BY id`,
      );
      expect(rows.map((r) => r.id).sort()).toEqual([...BUILTIN_ASPECT_IDS].sort());
      for (const row of rows) {
        expect(row.schema).toEqual(aspectJsonSchema(row.id as (typeof BUILTIN_ASPECT_IDS)[number]));
      }
    } finally {
      await client.end();
    }
  });
});
