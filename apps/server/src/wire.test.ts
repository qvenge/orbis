// apps/server/src/wire.test.ts
import { describe, expect, test } from 'bun:test';
import { entitySchema } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv } from '../test/helpers';
import { withIdentity } from './db/with-identity';
import { toWireEntity } from './wire';

requireEnv();

describe('wire-сериализация (решение 12 плана)', () => {
  test('строка из Postgres → toWireEntity → entitySchema.parse проходит; формат — UTC Z', async () => {
    const { db, client } = appDb();
    const owner = freshUserId();
    const id = crypto.randomUUID();
    try {
      const row = await withIdentity(db, owner, async (tx) => {
        await tx.execute(
          sql`INSERT INTO entities (id, owner_id, title) VALUES (${id}, ${owner}, 'parity')`,
        );
        const rows = await tx.query.entities.findMany({ where: (e, { eq }) => eq(e.id, id) });
        return rows[0];
      });
      if (!row) throw new Error('строка не прочитана после INSERT');
      const wire = toWireEntity(row);
      expect(() => entitySchema.parse(wire)).not.toThrow(); // zod datetime() без офсета
      expect(wire.createdAt.endsWith('Z')).toBe(true); // не '+00:00'
      expect(wire.updatedAt).toBe(row.updatedAt.toISOString());
    } finally {
      await client.end();
    }
  });
});
