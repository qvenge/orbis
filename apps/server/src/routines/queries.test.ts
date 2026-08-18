// apps/server/src/routines/queries.test.ts
// Список владельцев для тика планировщика рутин (V1.13, инвариант 14) против живой БД.
//
// Тест намеренно идёт под ролью orbis_app БЕЗ identity — ровно так, как ходит планировщик:
// у тика нет владельца, он их только перечисляет, а работу ведёт уже под withIdentity.
// appDb() поднимает пул на DATABASE_URL (роль orbis_app и локально, и в CI); проверка
// current_user ниже — страховка от ложно-зелёного: с админским DSN тесты прошли бы и без
// политики 0013, ничего при этом не доказав.
//
// ПОВЕДЕНЧЕСКАЯ ПОЛОВИНА ИНВАРИАНТА 14 ЖИВЁТ ЗДЕСЬ, а не в pgTAP: админский DSN не может
// SET ROLE orbis_app (postgres не суперпользователь, неявное членство создателя роли идёт
// с SET FALSE), а выдать себе право прямо в откатываемой транзакции нельзя — на сборке
// образа CI supabase/postgres:17.6.1.140 GRANT ... TO CURRENT_USER роняет бэкенд сегфолтом.
// В pgTAP (группа 11) осталась структурная половина: форма политики и наличие гранта.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { ownerIdsForScheduler } from './queries';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

/**
 * Код ошибки Postgres из отказа запроса. Идём по цепочке cause: drizzle заворачивает
 * отказ драйвера в DrizzleQueryError, у которого своего `code` нет, — читать его напрямую
 * значит получить undefined и зелёный тест на любой ошибке.
 */
function pgCode(err: unknown): string {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur !== null && cur !== undefined; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return `без кода Postgres: ${String(err)}`;
}

/** Код отказа запроса — или 'запрос прошёл', если он неожиданно НЕ упал. */
async function codeOfRejection(run: Promise<unknown>): Promise<string> {
  return run.then(() => 'запрос прошёл', pgCode);
}

const OWNER_A = freshUserId();
const OWNER_B = freshUserId();

beforeAll(async () => {
  await truncateAll();
  for (const user of [OWNER_A, OWNER_B]) {
    await createCaller({
      actorUserId: user,
      actorKind: 'owner',
      db,
      clientVersion: null,
    }).user.seedOnboarding();
  }
});

afterAll(async () => {
  await client.end();
});

test('сьют идёт под служебной ролью без identity — иначе проверки ниже ничего не доказывают', async () => {
  // auth.uid() здесь НЕ зовём: у orbis_app нет USAGE на схему auth (роль NOINHERIT, а
  // права висят на authenticated) — вызов упал бы с 42501. В политиках выражение работает,
  // потому что там оно уже разобрано в OID'ы и имя схемы заново не резолвится.
  // Признак «нет identity» читаем напрямую из GUC, который ставит withIdentity.
  const role = await db.execute(
    sql`SELECT current_user AS role,
               coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = '' AS anon`,
  );
  expect(role[0]?.role).toBe('orbis_app');
  expect(role[0]?.anon).toBe(true);
});

test('ownerIdsForScheduler под orbis_app без identity: видит владельцев, созданных сидом, по возрастанию', async () => {
  const ids = await ownerIdsForScheduler(db);
  // Оба владельца, а не «свой»: под orbis_app auth.uid() пуст, и узкая политика вернула бы
  // пустоту. Именно чужие строки — то, ради чего 0013 существует. Двух РАЗНЫХ владельцев
  // достаточно: одного дала бы и политика, скоупленная по владельцу.
  expect(ids).toContain(OWNER_A);
  expect(ids).toContain(OWNER_B);
  // Порядок пинится отдельно: тик обходит владельцев детерминированно, иначе два
  // сосуществующих деплоя (Render держит старый и новый контейнер) расходились бы в
  // порядке обхода, и гонка за один и тот же бакет ловилась бы через раз.
  expect(ids).toEqual([...ids].sort());
  expect(new Set(ids).size).toBe(ids.length);
});

test('user_settings под orbis_app без identity: запись отклоняется (0013 даёт только чтение)', async () => {
  // Политика 0013 — FOR SELECT, грант — ровно SELECT. Какой из двух барьеров сработает
  // первым, тест не пинит: важен итог «служебная роль настройки не пишет».
  const code = await codeOfRejection(
    db.execute(sql`INSERT INTO user_settings (owner_id) VALUES (${freshUserId()})`),
  );
  expect(code).toBe('42501');
});

test('граф под orbis_app без identity невидим: 0013 открывает список владельцев, а не их данные', async () => {
  // Ровно два законных исхода, и оба означают «не видно»: 42501 (гранта на entities у
  // служебной роли нет) либо ноль строк (право откуда-то есть, но политики для этой роли
  // нет и RLS прячет всё). Пинить, КАКОЙ именно, нельзя — default privileges различаются
  // между локальным стеком Supabase CLI и образом CI (урок группы 9 pgTAP). Провал — третий
  // исход: строки видны. Данные в таблице заведомо есть — сид выше создал 18 сущностей на
  // каждого из двух владельцев, так что пустота здесь не может быть пустотой таблицы.
  const seen = await db
    .execute(sql`SELECT count(*)::int AS n FROM entities`)
    .then((r) => ({ denied: false as const, n: Number(r[0]?.n) }))
    .catch((e: unknown) => ({ denied: true as const, code: pgCode(e) }));
  if (seen.denied) {
    expect(seen.code).toBe('42501');
  } else {
    expect(seen.n).toBe(0);
  }
});
