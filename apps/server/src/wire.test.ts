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

  test('wire-форма несёт ТОЛЬКО новую правду: props/aspects/queryRefs; ни meta, ни старой карты', async () => {
    const { db, client } = appDb();
    const owner = freshUserId();
    const id = crypto.randomUUID();
    try {
      const row = await withIdentity(db, owner, async (tx) => {
        // Прямой INSERT, а не исполнитель: строка нарочно несёт СТАРЫЕ носители
        // заполненными (`meta`, `aspects_legacy`) рядом с новыми — иначе «наружу не едет»
        // было бы истинно просто потому, что и внутри пусто.
        await tx.execute(
          sql`INSERT INTO entities (id, owner_id, title, meta, aspects_legacy, props, aspects, query_refs)
              VALUES (${id}, ${owner}, 'носитель',
                      ${JSON.stringify({ source: 'проба' })}::jsonb,
                      ${JSON.stringify({ 'orbis/task': { status: 'todo' } })}::jsonb,
                      ${JSON.stringify({ 'orbis/task_status': 'todo' })}::jsonb,
                      ARRAY['orbis/task']::text[], '{}'::text[])`,
        );
        const rows = await tx.query.entities.findMany({ where: (e, { eq }) => eq(e.id, id) });
        return rows[0];
      });
      if (!row) throw new Error('строка не прочитана после INSERT');
      const wire = toWireEntity(row);
      // Обе колонки в строке ЗАПОЛНЕНЫ (см. INSERT выше) — и наружу не едет ни одна: это и
      // есть проверяемое утверждение, а не следствие пустых данных (§А1-1, §А1-3).
      expect(row.aspectsLegacy).toEqual({ 'orbis/task': { status: 'todo' } });
      expect(row.meta).toEqual({ source: 'проба' });
      expect('aspectsMap' in wire).toBe(false);
      expect('meta' in wire).toBe(false);
      expect(wire.props).toEqual({ 'orbis/task_status': 'todo' });
      expect(wire.aspects).toEqual(['orbis/task']);
      expect(wire.queryRefs).toEqual([]);
      // Схема wire-формы `.strict()` не объявлена, но `z.object` срезает лишнее: разбор —
      // вторая гарантия того, что старая пара наружу не проедет.
      const parsed = entitySchema.parse(wire);
      expect('aspectsMap' in parsed).toBe(false);
      expect('meta' in parsed).toBe(false);
    } finally {
      await client.end();
    }
  });
});
