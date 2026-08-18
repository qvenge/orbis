// apps/server/src/routines/queries.test.ts
// Список владельцев для тика планировщика рутин (V1.13, инвариант 14) против живой БД.
//
// Тест намеренно идёт под ролью orbis_app БЕЗ identity — ровно так, как ходит планировщик:
// у тика нет владельца, он их только перечисляет, а работу ведёт уже под withIdentity.
// appDb() поднимает пул на DATABASE_URL (роль orbis_app и локально, и в CI); проверка
// current_user ниже — страховка от ложно-зелёного: с админским DSN тест прошёл бы и без
// политики 0013, ничего при этом не доказав.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { ownerIdsForScheduler } from './queries';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

test('ownerIdsForScheduler под orbis_app без identity: видит владельцев, созданных сидом, по возрастанию', async () => {
  const role = await db.execute(sql`SELECT current_user AS role`);
  expect(role[0]?.role).toBe('orbis_app');

  const a = freshUserId();
  const b = freshUserId();
  for (const user of [a, b]) {
    await createCaller({
      actorUserId: user,
      actorKind: 'owner',
      db,
      clientVersion: null,
    }).user.seedOnboarding();
  }

  const ids = await ownerIdsForScheduler(db);
  // Оба владельца, а не «свой»: под orbis_app auth.uid() пуст, и узкая политика вернула бы
  // пустоту. Именно чужие строки — то, ради чего 0013 существует.
  expect(ids).toContain(a);
  expect(ids).toContain(b);
  // Порядок пинится отдельно: тик обходит владельцев детерминированно, иначе два
  // сосуществующих деплоя (Render держит старый и новый контейнер) расходились бы в
  // порядке обхода, и гонка за один и тот же бакет ловилась бы через раз.
  expect(ids).toEqual([...ids].sort());
  expect(new Set(ids).size).toBe(ids.length);
});
