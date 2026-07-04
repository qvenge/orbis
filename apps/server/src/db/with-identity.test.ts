// apps/server/src/db/with-identity.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv } from '../../test/helpers';
import { withIdentity } from './with-identity';

requireEnv(); // бросает с внятным сообщением, если DATABASE_URL/DATABASE_URL_ADMIN не заданы

describe('withIdentity (RLS-механика, findings B7)', () => {
  const { db, client } = appDb();
  const userA = freshUserId();
  const userB = freshUserId();

  test('невалидный actorUserId отклоняется до SQL', async () => {
    await expect(withIdentity(db, 'not-a-uuid', async () => {})).rejects.toThrow(/UUID/);
  });

  test('внутри транзакции auth.uid() = actorUserId, снаружи — NULL', async () => {
    const inside = await withIdentity(db, userA, async (tx) => {
      const r = await tx.execute(sql`SELECT auth.uid()::text AS uid, current_user AS who`);
      return r[0];
    });
    expect(inside?.uid).toBe(userA);
    expect(inside?.who).toBe('authenticated');
    // свежий checkout после транзакции чист (пул max=3, гоняем несколько раз).
    // Прямой auth.uid() под orbis_app недоступен: NOINHERIT без грантов на схему auth,
    // а GRANT USAGE ON SCHEMA auth от postgres тихо не выдаётся (findings грабля 1).
    // Проверяем первоисточник — request.jwt.claims (паттерн спайка SPIKE-01).
    for (let i = 0; i < 5; i++) {
      const r = await db.execute(sql`
        SELECT nullif(current_setting('request.jwt.claims', true), '') AS claims,
               current_user AS who`);
      expect(r[0]?.claims ?? null).toBeNull();
      expect(r[0]?.who).toBe('orbis_app');
    }
  });

  test('изоляция: A создаёт, A видит, B — нет; вне identity — deny-by-default', async () => {
    const id = crypto.randomUUID();
    await withIdentity(db, userA, async (tx) => {
      await tx.execute(
        sql`INSERT INTO entities (id, owner_id, title) VALUES (${id}, ${userA}, 'своя')`,
      );
    });
    const mine = await withIdentity(db, userA, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`),
    );
    expect(mine[0]?.n).toBe(1);
    const theirs = await withIdentity(db, userB, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`),
    );
    expect(theirs[0]?.n).toBe(0);
    // Вне identity deny жёстче, чем «0 строк»: у orbis_app (NOINHERIT) нет грантов
    // на таблицы вовсе — 42501 permission denied. Ловим try/catch: drizzle-запрос —
    // thenable, не Promise (findings грабля 2), код — в e.code ?? e.cause.code.
    let anonCode: string | undefined;
    try {
      await db.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`);
    } catch (e) {
      anonCode = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    }
    expect(anonCode).toBe('42501');
  });

  test('rollback-путь: identity и данные умирают вместе с транзакцией', async () => {
    const id = crypto.randomUUID();
    await expect(
      withIdentity(db, userA, async (tx) => {
        await tx.execute(
          sql`INSERT INTO entities (id, owner_id, title) VALUES (${id}, ${userA}, 'x')`,
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await withIdentity(db, userA, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`),
    );
    expect(after[0]?.n).toBe(0);
  });

  test('interleaved: A и B на одном пуле не путаются', async () => {
    const [a, b] = await Promise.all([
      withIdentity(db, userA, async (tx) => {
        const r = await tx.execute(sql`SELECT auth.uid()::text AS uid, pg_sleep(0.05)`);
        return r[0]?.uid;
      }),
      withIdentity(db, userB, async (tx) => {
        const r = await tx.execute(sql`SELECT auth.uid()::text AS uid`);
        return r[0]?.uid;
      }),
    ]);
    expect(a).toBe(userA);
    expect(b).toBe(userB);
  });

  afterAll(async () => {
    await client.end();
  });
});
