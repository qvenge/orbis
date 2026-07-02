// SPIKE-01: матрица (а)–(л). Контракты: PRD 01 §4.10 (политика), §5 (identity),
// carried «Механика RLS через Bun API» (04-decision-log).
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { sql, eq, ne } from 'drizzle-orm';
import { makeDb } from '../src/db';
import { withIdentity, type Tx } from '../src/with-identity';
import { spikeItems } from '../src/schema';
import { USER_A, USER_B, makeAdmin, truncateItems, latch } from './setup';

const admin = makeAdmin();

beforeAll(async () => {
  await truncateItems();
});

afterAll(async () => {
  await admin.end();
});

describe('(ж) свойства роли', () => {
  test('orbis_app: NOSUPERUSER, NOBYPASSRLS; коннект живой', async () => {
    const roles = await admin`
      select rolbypassrls, rolsuper from pg_roles where rolname = 'orbis_app'`;
    expect(roles.length).toBe(1);
    expect(roles[0]!.rolbypassrls).toBe(false);
    expect(roles[0]!.rolsuper).toBe(false);

    const { db, client } = makeDb({ max: 1 });
    const who = await db.execute(sql`select current_user`);
    expect((who as unknown as Array<{ current_user: string }>)[0]!.current_user).toBe('orbis_app');
    await client.end();
  });
});

describe('(а)+(л) базовая изоляция чтения', () => {
  test('A видит ровно свои строки; admin видит всё (контроль)', async () => {
    const { db, client } = makeDb({ max: 2 });
    try {
      // Сидирование через продуктовый путь — заодно happy-path WITH CHECK
      await withIdentity(db, USER_A, async (tx) => {
        await tx.insert(spikeItems).values([
          { ownerId: USER_A, title: 'a1' },
          { ownerId: USER_A, title: 'a2' },
        ]);
      });
      await withIdentity(db, USER_B, async (tx) => {
        await tx.insert(spikeItems).values({ ownerId: USER_B, title: 'b1' });
      });

      const aRows = await withIdentity(db, USER_A, (tx) => tx.select().from(spikeItems));
      expect(aRows.length).toBe(2);
      expect(aRows.every((r) => r.ownerId === USER_A)).toBe(true);

      // (л) анти-false-positive: данные обоих пользователей реально существуют
      const all = await admin`select owner_id from spike_items`;
      expect(all.length).toBe(3);
      const owners = new Set(all.map((r) => r.owner_id as string));
      expect(owners.has(USER_A)).toBe(true);
      expect(owners.has(USER_B)).toBe(true);
    } finally {
      await client.end();
    }
  });
});

describe('(б) чужое не читается и не пишется', () => {
  test('INSERT с owner_id=B под identity A отклоняется (WITH CHECK, 42501)', async () => {
    const { db, client } = makeDb({ max: 1 });
    try {
      let code: string | undefined;
      try {
        await withIdentity(db, USER_A, (tx) =>
          tx.insert(spikeItems).values({ ownerId: USER_B, title: 'smuggled' }),
        );
      } catch (e) {
        code = (e as { code?: string }).code ?? ((e as { cause?: { code?: string } }).cause?.code);
      }
      expect(code).toBe('42501');
    } finally {
      await client.end();
    }
  });

  test('UPDATE и точечный SELECT строки B под identity A → 0 строк', async () => {
    const bRow = await admin`select id from spike_items where title = 'b1'`;
    const bId = bRow[0]!.id as string;

    const { db, client } = makeDb({ max: 1 });
    try {
      const updated = await withIdentity(db, USER_A, (tx) =>
        tx.update(spikeItems).set({ title: 'hacked' }).where(eq(spikeItems.id, bId)).returning(),
      );
      expect(updated.length).toBe(0);

      const selected = await withIdentity(db, USER_A, (tx) =>
        tx.select().from(spikeItems).where(eq(spikeItems.id, bId)),
      );
      expect(selected.length).toBe(0);

      const still = await admin`select title from spike_items where id = ${bId}`;
      expect(still[0]!.title).toBe('b1');
    } finally {
      await client.end();
    }
  });
});

describe('(в) пул не путает identity', () => {
  test('interleaved-транзакции A и B на пуле max=2', async () => {
    const { db, client } = makeDb({ max: 2 });
    try {
      const aInside = latch();
      const bDone = latch();

      const aWork = withIdentity(db, USER_A, async (tx) => {
        const first = await tx.select().from(spikeItems);
        aInside.open();
        await bDone.wait;
        const second = await tx.select().from(spikeItems);
        return { first, second };
      });

      await aInside.wait;
      const bRows = await withIdentity(db, USER_B, (tx) => tx.select().from(spikeItems));
      bDone.open();
      const a = await aWork;

      expect(bRows.length).toBe(1);
      expect(bRows[0]!.ownerId).toBe(USER_B);
      expect(a.first.length).toBe(2);
      expect(a.second.length).toBe(2);
      expect([...a.first, ...a.second].every((r) => r.ownerId === USER_A)).toBe(true);
    } finally {
      await client.end();
    }
  });

  test('последовательный A→B→A на переиспользованных коннекшнах (max=1)', async () => {
    const { db, client } = makeDb({ max: 1 });
    try {
      const a1 = await withIdentity(db, USER_A, (tx) => tx.select().from(spikeItems));
      const b = await withIdentity(db, USER_B, (tx) => tx.select().from(spikeItems));
      const a2 = await withIdentity(db, USER_A, (tx) => tx.select().from(spikeItems));
      expect(a1.length).toBe(2);
      expect(b.length).toBe(1);
      expect(a2.length).toBe(2);
    } finally {
      await client.end();
    }
  });
});

describe('(г) identity умирает вместе с транзакцией', () => {
  test('после withIdentity на том же коннекшне auth.uid() и claims пусты', async () => {
    const { db, client } = makeDb({ max: 1 });
    try {
      await withIdentity(db, USER_A, (tx) => tx.select().from(spikeItems));
      const after = await client`
        select auth.uid() as uid,
               nullif(current_setting('request.jwt.claims', true), '') as claims`;
      expect(after[0]!.uid).toBeNull();
      expect(after[0]!.claims).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('(д) deny-by-default без identity', () => {
  test('SELECT → 0 строк, INSERT → ошибка', async () => {
    const { db, client } = makeDb({ max: 1 });
    try {
      const rows = await db.select().from(spikeItems);
      expect(rows.length).toBe(0);
      await expect(
        db.insert(spikeItems).values({ ownerId: USER_A, title: 'no-identity' }),
      ).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});

describe('(е) service-role вне продуктового пути', () => {
  test('src/* не знает admin/service-креды; внутри withIdentity current_user = orbis_app', async () => {
    for (const f of ['db.ts', 'schema.ts', 'with-identity.ts']) {
      const text = await Bun.file(new URL(`../src/${f}`, import.meta.url)).text();
      expect(text.includes('SERVICE_ROLE')).toBe(false);
      expect(text.includes('DATABASE_URL_ADMIN')).toBe(false);
    }
    const { db, client } = makeDb({ max: 1 });
    try {
      const user = await withIdentity(db, USER_A, async (tx) => {
        const r = await tx.execute(sql`select current_user`);
        return (r as unknown as Array<{ current_user: string }>)[0]!.current_user;
      });
      expect(user).toBe('orbis_app');
    } finally {
      await client.end();
    }
  });
});

describe('(з) generic plan / prepared statements', () => {
  test('7+ прогонов одного запроса под A, затем под B → B видит только своё', async () => {
    const { db, client } = makeDb({ max: 1, prepare: process.env.PG_PREPARE !== 'false' });
    // Параметризованный запрос ($1): после ~5 исполнений Postgres может перейти
    // на generic plan — RLS-предикат обязан вычисляться на execute, не на plan.
    const notTitled = (tx: Tx) =>
      tx.select().from(spikeItems).where(ne(spikeItems.title, 'zzz'));
    try {
      for (let i = 0; i < 8; i++) {
        const rows = await withIdentity(db, USER_A, notTitled);
        expect(rows.every((r) => r.ownerId === USER_A)).toBe(true);
      }
      const bRows = await withIdentity(db, USER_B, notTitled);
      expect(bRows.length).toBe(1);
      expect(bRows[0]!.ownerId).toBe(USER_B);
    } finally {
      await client.end();
    }
  });
});

describe('(и) rollback-путь', () => {
  test('исключение после set_config: строки нет, следующий checkout чист', async () => {
    const { db, client } = makeDb({ max: 1 });
    try {
      await expect(
        withIdentity(db, USER_A, async (tx) => {
          await tx.insert(spikeItems).values({ ownerId: USER_A, title: 'doomed' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const doomed = await admin`select 1 from spike_items where title = 'doomed'`;
      expect(doomed.length).toBe(0);

      const after = await client`select auth.uid() as uid`;
      expect(after[0]!.uid).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('(к) session-гигиена и мусорные claims', () => {
  test('current_user и search_path не меняются транзакциями', async () => {
    const { db, client } = makeDb({ max: 1 });
    try {
      const before = await client`show search_path`;
      await withIdentity(db, USER_A, (tx) => tx.select().from(spikeItems));
      const afterPath = await client`show search_path`;
      const afterUser = await client`select current_user`;
      expect(afterPath[0]!.search_path).toBe(before[0]!.search_path);
      expect(afterUser[0]!.current_user).toBe('orbis_app');
    } finally {
      await client.end();
    }
  });

  test('мусорные claims не открывают данные', async () => {
    const { db, client } = makeDb({ max: 1 });
    try {
      // sub — не uuid: либо ошибка каста, либо 0 строк; но не «видно всё»
      const notUuid = await withIdentity(db, 'not-a-uuid', (tx) =>
        tx.select().from(spikeItems),
      ).catch(() => 'thrown' as const);
      expect(notUuid === 'thrown' || (Array.isArray(notUuid) && notUuid.length === 0)).toBe(true);

      // claims — не JSON
      const notJson = await db
        .transaction(async (tx) => {
          await tx.execute(sql`select set_config('request.jwt.claims', 'not-json', true)`);
          return tx.select().from(spikeItems);
        })
        .catch(() => 'thrown' as const);
      expect(notJson === 'thrown' || (Array.isArray(notJson) && notJson.length === 0)).toBe(true);
    } finally {
      await client.end();
    }
  });
});
