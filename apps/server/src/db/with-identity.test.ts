// apps/server/src/db/with-identity.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import type { AccountId, GraphId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { accountOf, appDb, mintGraph, personal, requireEnv } from '../../test/helpers';
import { type Identity, identityOfGrant } from '../identity';
import { withIdentity } from './with-identity';

requireEnv(); // бросает с внятным сообщением, если DATABASE_URL/DATABASE_URL_ADMIN не заданы

/**
 * ТОЧНОЕ равенство типов (взаимная присваиваемость), а не присваиваемость в одну сторону.
 * Разница и есть смысл: расширение `AccountId` до `AccountId | GraphId` присваиваемость
 * сохраняет — такой пин промолчал бы, — а равенство даёт `false`, и константа ниже перестаёт
 * компилироваться. Кортежи `[A]`/`[B]` гасят дистрибутивность условного типа по союзам.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('withIdentity (RLS-механика, findings B7)', () => {
  const { db, client } = appDb();
  const userA = mintGraph();
  const userB = mintGraph();

  test('невалидный актор отклоняется до SQL', async () => {
    // Приведение здесь НАМЕРЕННОЕ и единственно возможное: пару с не-UUID компилятор
    // собрать не даёт (значение бренда рождается только в parse*), а рантайм-страж
    // withIdentity сторожит вход из нетипизированного мира и обязан быть проверен.
    const bogus = { actor: 'not-a-uuid', graph: userA } as unknown as Identity;
    await expect(withIdentity(db, bogus, async () => {})).rejects.toThrow(/UUID/);
  });

  test('внутри транзакции auth.uid() = актор, снаружи — NULL', async () => {
    const inside = await withIdentity(db, personal(userA), async (tx) => {
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
    await withIdentity(db, personal(userA), async (tx) => {
      await tx.execute(
        sql`INSERT INTO entities (id, graph_id, title) VALUES (${id}, ${userA}, 'своя')`,
      );
    });
    const mine = await withIdentity(db, personal(userA), async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`),
    );
    expect(mine[0]?.n).toBe(1);
    const theirs = await withIdentity(db, personal(userB), async (tx) =>
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
      withIdentity(db, personal(userA), async (tx) => {
        await tx.execute(
          sql`INSERT INTO entities (id, graph_id, title) VALUES (${id}, ${userA}, 'x')`,
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await withIdentity(db, personal(userA), async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`),
    );
    expect(after[0]?.n).toBe(0);
  });

  test('interleaved: A и B на одном пуле не путаются', async () => {
    const [a, b] = await Promise.all([
      withIdentity(db, personal(userA), async (tx) => {
        const r = await tx.execute(sql`SELECT auth.uid()::text AS uid, pg_sleep(0.05)`);
        return r[0]?.uid;
      }),
      withIdentity(db, personal(userB), async (tx) => {
        const r = await tx.execute(sql`SELECT auth.uid()::text AS uid`);
        return r[0]?.uid;
      }),
    ]);
    expect(a).toBe(userA);
    expect(b).toBe(userB);
  });

  test('interleaved: текущий граф A и B на одном пуле не путается (близнец теста identity)', async () => {
    const graphOf = sql`SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph') AS graph`;
    const [a, b] = await Promise.all([
      // pg_sleep в ПЕРВОЙ ветке обязателен: именно он заставляет соединения пересечься
      withIdentity(db, personal(userA), (tx) =>
        tx.execute(sql`SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph') AS graph,
                            pg_sleep(0.05)`),
      ),
      withIdentity(db, personal(userB), (tx) => tx.execute(graphOf)),
    ]);
    expect(a[0]?.graph).toBe(userA);
    expect(b[0]?.graph).toBe(userB);
  });

  test('текущий граф умирает вместе с транзакцией: снаружи GUC пуст на каждом соединении пула', async () => {
    await withIdentity(db, personal(userA), async () => undefined);
    for (let i = 0; i < 5; i++) {
      const rows = await db.execute(
        sql`SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph') AS graph`,
      );
      expect(rows[0]?.graph ?? null).toBeNull();
    }
  });

  test('актор и граф — разные значения claims: sub = актор, graph = граф', async () => {
    // Через резолвер 2: актор действует в графе, где у него грант, — ровно этот смысл.
    // Собрать пару литералом снаружи `identity.ts` нельзя (замок типа, Р-ИГ-11).
    const who = identityOfGrant({ accountId: accountOf(userB), graphId: userA });
    const rows = await withIdentity(db, who, (tx) =>
      tx.execute(sql`SELECT auth.uid()::text AS uid,
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph') AS graph`),
    );
    expect(rows[0]).toEqual({ uid: userB, graph: userA });
  });

  test('сигнатура: один id вместо пары не компилируется, поля пары — ровно свои типы (Ш-2)', () => {
    // @ts-expect-error — GraphId вместо Identity: ослабь второй параметр до `Identity | GraphId`,
    // и директива станет неиспользуемой (TS2578). Это её мутационная проверка.
    void (() => withIdentity(db, userA, async () => 1));

    // ВТОРАЯ директива снята НАМЕРЕННО. Она стояла на литерале `{ actor: userA, graph: userA }`
    // и обещала пинить «актор обязан быть AccountId», но после замка типа (Р-ИГ-12) литерал
    // красен по ДРУГОЙ причине — у него нет приватного поля, — и расширение `Identity.actor`
    // до `AccountId | GraphId` директиву неиспользуемой уже НЕ делало (измерено ре-ревью).
    // Пин, который не краснеет на снятии своей гарантии, — не пин.
    //
    // Само свойство пинится ниже ТОЧНЫМ равенством типов, а не присваиваемостью: расширение
    // поля до союза присваиваемость сохранило бы, а равенство ломает. Плюс третий рубеж —
    // прод-код: та же мутация даёт TS2345 в десяти файлах (`send-message`, `executor`,
    // `import/review`, `mcp/server`, `routines/lifecycle`, `seed/personal-graph` …).
    const actorIsExactlyAccountId: Exact<Identity['actor'], AccountId> = true;
    const graphIsExactlyGraphId: Exact<Identity['graph'], GraphId> = true;
    expect([actorIsExactlyAccountId, graphIsExactlyGraphId]).toEqual([true, true]);
  });

  afterAll(async () => {
    await client.end();
  });
});
