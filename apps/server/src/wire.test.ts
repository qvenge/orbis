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

  test('wire-форма несёт ТОЛЬКО новую правду: props/aspects/queryRefs, и старых носителей нет', async () => {
    const { db, client } = appDb();
    const owner = freshUserId();
    const id = crypto.randomUUID();
    try {
      const row = await withIdentity(db, owner, async (tx) => {
        // Прямой INSERT, а не исполнитель: форма строки здесь и есть предмет проверки.
        //
        // ПРЕЖДЕ строка нарочно несла заполненными старые носители (`meta`,
        // `aspects_legacy`) рядом с новыми — иначе «наружу не едет» было бы истинно просто
        // потому, что и внутри пусто. Теперь этих колонок нет в базе вовсе
        // (contract-миграция 0017), и утверждение стало сильнее: не «есть, но не едет», а
        // «негде взять». Проверка формы наружу при этом остаётся — за ней следят и разбор
        // схемы ниже, и wire-контракт.
        await tx.execute(
          sql`INSERT INTO entities (id, owner_id, title, props, aspects, query_refs)
              VALUES (${id}, ${owner}, 'носитель',
                      ${JSON.stringify({ 'orbis/task_status': 'todo' })}::jsonb,
                      ARRAY['orbis/task']::text[], '{}'::text[])`,
        );
        const rows = await tx.query.entities.findMany({ where: (e, { eq }) => eq(e.id, id) });
        return rows[0];
      });
      if (!row) throw new Error('строка не прочитана после INSERT');
      const wire = toWireEntity(row);
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
