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

  test('aspectsMap = карта из aspects_legacy; props/aspects/queryRefs едут (пока пустые); meta едет', async () => {
    const { db, client } = appDb();
    const owner = freshUserId();
    const id = crypto.randomUUID();
    try {
      const row = await withIdentity(db, owner, async (tx) => {
        // Прямой INSERT, а не исполнитель: до Задачи 4b он в новые колонки не пишет, и
        // проверять надо именно перенос НОСИТЕЛЯ — что карта уезжает из `aspects_legacy`,
        // а `aspects` наружу отдаётся списком, а не картой.
        await tx.execute(
          sql`INSERT INTO entities (id, owner_id, title, meta, aspects_legacy, props, aspects, query_refs)
              VALUES (${id}, ${owner}, 'носитель',
                      ${JSON.stringify({ source: 'проба' })}::jsonb,
                      ${JSON.stringify({ 'orbis/task': { status: 'todo' } })}::jsonb,
                      '{}'::jsonb, '{}'::text[], '{}'::text[])`,
        );
        const rows = await tx.query.entities.findMany({ where: (e, { eq }) => eq(e.id, id) });
        return rows[0];
      });
      if (!row) throw new Error('строка не прочитана после INSERT');
      const wire = toWireEntity(row);
      expect(wire.aspectsMap).toEqual({ 'orbis/task': { status: 'todo' } });
      expect(wire.meta).toEqual({ source: 'проба' });
      expect(wire.props).toEqual({});
      expect(wire.aspects).toEqual([]);
      expect(wire.queryRefs).toEqual([]);
      expect(() => entitySchema.parse(wire)).not.toThrow();
    } finally {
      await client.end();
    }
  });
});
