// apps/server/perf/graph.test.ts
//
// Перф-гейт П6 — обход графа на объёме: 50 000 сущностей, ~150 000 рёбер `subitem`,
// глубина 8. Гоняется ОТДЕЛЬНЫМ скриптом `bun run test:perf:graph`, вне CI и вне
// `bun run test`/`test:perf` (находки 38/51): сев корпуса занимает минуты, а под
// параллельной нагрузкой полного прогона медианы уезжают в разы — тот же довод, что в
// шапке `perf.test.ts`.
//
// Что гейт мерит: `descendants_of` НОВОГО компилятора под RLS (роль приложения, не
// админ-DSN — под ролью без BYPASSRLS и план другой) и `recomputeProjectAncestors` на
// большом поддереве. Что НЕ мерит: абсолютную скорость машины. Пороги заданы кратно
// измеренному и ловят регрессию В РАЗЫ — потерянный индекс `(source_id, role)`,
// коррелированный подзапрос вместо однократного обхода, взрыв путей на ромбах.
//
// Числа печатаются ВСЕГДА (`measureMedian`), включая зелёный прогон: дрейф обязан быть
// виден глазами, а не только по красному.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { withIdentity } from '../src/db/with-identity';
import { recomputeProjectAncestors } from '../src/executor/ancestors';
import { compileCountAst, compileQueryAst } from '../src/query/compile-ast';
import { loadRegistry, type RegistrySnapshot } from '../src/registry/load';
import {
  ensureGraphFixture,
  GRAPH_DEPTH,
  GRAPH_ENTITIES,
  GRAPH_OWNER_ID,
  GRAPH_RELATIONS,
  graphLevelSize,
  graphNodeId,
} from '../src/test/graph-fixture';
import { measureMedian } from '../src/test/perf';
import { appDb, requireEnv } from '../test/helpers';

requireEnv();

const { db, client } = appDb();

/**
 * Потолок для МАЛОГО поддерева. Порога спеки у него нет — есть требование «правка ради
 * больших поддеревьев не должна ломать малые». Число взято кратно измеренному (8…12 мс),
 * как и все прочие пороги файла.
 */
const SMALL_CEILING_MS = 150;

/** Пороги П6 (§С8-13) — ДОСЛОВНО из спеки, а не «то, что получилось». */
const BUDGETS_MS = {
  /** Обход поддерева под RLS запросом, который реально уходит из query-блока. */
  'descendants_of:subtree': 100,
  /** Пересчёт предков на поддереве ≥ 5000 узлов. */
  'recompute:subtree5k': 1000,
} as const;

/**
 * ОБА порога П6 берутся, и второй из них — только после правки движка предков.
 *
 * До правки `recomputeProjectAncestors` на поддереве 4999 узлов давал ДВА режима на одних и
 * тех же данных: 1762 / 1776 / 1776 мс в лучшем и 12 030 / 12 090 / 12 148 / 12 248 мс в
 * худшем; порог 1000 мс не брался ни в одном. Причина и лекарство разобраны в докблоке самой
 * правки — `executor/ancestors.ts`, CTE `picked`: два `DISTINCT ON` с двумя LEFT JOIN
 * заменены одной группировкой. После правки — 428 / 477 / 497 / 575 / 575 / 599 мс на шести
 * прогонах, режим ОДИН. Малое поддерево (6 узлов) не подорожало: 8,7 / 9,7 / 9,9 мс до и
 * 8,5 / 8,6 / 9,0 / 9,2 мс после.
 */

/**
 * Корень замера обхода — узел ПЕРВОГО уровня: его поддерево ≈ 5000 узлов, ровно тот объём,
 * который называет П6 (§С8-13). Уровень выбран не «на глаз»: у корня поддерево — это весь
 * корпус (замер вырождается в «прочитать таблицу»), у листа его нет вовсе, а фактический
 * размер печатается и проверяется сторожем ниже — порог, взятый на поддереве в три узла,
 * не значил бы ничего.
 */
const SUBTREE_ROOT_LEVEL = 1;

/**
 * Второй корень замера — МАЛОЕ поддерево (единицы узлов, уровень 5). Он здесь не ради
 * полноты: `MATERIALIZED` в движке предков (`executor/ancestors.ts`) — подсказка
 * планировщику, и подсказка эта бывает вредной. На пяти тысячах узлов она экономит
 * повторные сортировки, а на семи могла бы стоить дороже, чем экономит: материализация
 * платит за себя только если результат читают много раз. Пока эта строка меряется, «стало
 * лучше большим и хуже малым» видно числом, а не предполагается.
 */
const SMALL_ROOT_LEVEL = 5;

let reg: RegistrySnapshot;
let subtreeRoot: string;
let subtreeSize: number;
let smallRoot: string;
let smallSize: number;

/**
 * Запрос обхода. `limit` НЕ задан намеренно: без него компилятор ставит умолчание §6.1
 * (500), и это ровно то, что уходит из query-блока, из бейджа и из тула. Порог П6 обязан
 * стоять на этом запросе, а не на выгрузке всего поддерева: у неё стоимость делает
 * материализация строк, а не обход (числа обеих — ниже, обе печатаются).
 */
const walkAst = (of: string) =>
  ({ filter: { rel: { kind: 'descendants_of' as const, via: 'subitem', of } } }) as const;

/** Тот же обход, но с выгрузкой ВСЕГО поддерева — наблюдение рядом с порогом. */
const walkAllAst = (of: string) => ({ ...walkAst(of), limit: GRAPH_ENTITIES }) as const;

beforeAll(async () => {
  const t0 = performance.now();
  const fixture = await ensureGraphFixture();
  console.log(
    `perf: корпус ${fixture.entities} сущностей / ${fixture.relations} рёбер, глубина ${GRAPH_DEPTH}` +
      ` (${fixture.seeded ? `засеян за ${((performance.now() - t0) / 1000).toFixed(1)} с` : 'взят из кеша'})`,
  );
  expect(fixture.entities).toBe(GRAPH_ENTITIES);
  expect(fixture.relations).toBe(GRAPH_RELATIONS);
  reg = await withIdentity(db, GRAPH_OWNER_ID, (tx) => loadRegistry(tx, GRAPH_OWNER_ID));
  subtreeRoot = graphNodeId(SUBTREE_ROOT_LEVEL, Math.floor(graphLevelSize(SUBTREE_ROOT_LEVEL) / 2));
  const rows = await withIdentity(db, GRAPH_OWNER_ID, async (tx) => [
    ...(await tx.execute(
      compileCountAst(walkAllAst(subtreeRoot), {
        ownerId: GRAPH_OWNER_ID,
        today: '2026-07-03',
        timeZone: 'Europe/Moscow',
        reg,
      }),
    )),
  ]);
  subtreeSize = Number((rows[0] as { count?: unknown })?.count);
  console.log(`perf: поддерево замера — ${subtreeSize} узлов (уровень ${SUBTREE_ROOT_LEVEL})`);
  smallRoot = graphNodeId(SMALL_ROOT_LEVEL, Math.floor(graphLevelSize(SMALL_ROOT_LEVEL) / 2));
  const smallRows = await withIdentity(db, GRAPH_OWNER_ID, async (tx) => [
    ...(await tx.execute(
      compileCountAst(walkAllAst(smallRoot), {
        ownerId: GRAPH_OWNER_ID,
        today: '2026-07-03',
        timeZone: 'Europe/Moscow',
        reg,
      }),
    )),
  ]);
  smallSize = Number((smallRows[0] as { count?: unknown })?.count);
  console.log(`perf: малое поддерево — ${smallSize} узлов (уровень ${SMALL_ROOT_LEVEL})`);
}, 900_000);

afterAll(async () => {
  await client.end();
});

// Сторож корпуса. Быстрый обход по пустому поддереву — тоже быстрый: без этой проверки
// гейт остался бы зелёным, перестав что-либо мерить (тот же класс сторожа, что у
// `perf.test.ts` про непустую фикстуру).
test('корпус наполнен: обход идёт по данным, а не по пустоте', async () => {
  expect(subtreeSize).toBeGreaterThanOrEqual(4900);
  const ctx = {
    ownerId: GRAPH_OWNER_ID,
    today: '2026-07-03',
    timeZone: 'Europe/Moscow',
    reg,
  };
  const rows = await withIdentity(db, GRAPH_OWNER_ID, async (tx) => [
    ...(await tx.execute(compileQueryAst(walkAllAst(subtreeRoot), ctx))),
  ]);
  expect(rows).toHaveLength(subtreeSize);
  // Обход НЕ выродился в «весь корпус»: поддерево третьего уровня заведомо меньше целого.
  expect(subtreeSize).toBeLessThan(GRAPH_ENTITIES);
  // И не выродился в один уровень: глубина обхода реально больше единицы.
  const oneLevel = await withIdentity(db, GRAPH_OWNER_ID, async (tx) => [
    ...(await tx.execute(
      compileCountAst(
        {
          filter: { rel: { kind: 'children_of', via: 'subitem', of: subtreeRoot } },
          limit: GRAPH_ENTITIES,
        },
        ctx,
      ),
    )),
  ]);
  expect(Number((oneLevel[0] as { count?: unknown })?.count)).toBeLessThan(subtreeSize);
}, 300_000);

test('П6: descendants_of под RLS и пересчёт предков на поддереве ≥5k', async () => {
  const ctx = { ownerId: GRAPH_OWNER_ID, today: '2026-07-03', timeZone: 'Europe/Moscow', reg };

  // Два наблюдения рядом с гейтом (порога не несут, но без них порог нечем толковать):
  // обход ОТ КОРНЯ (весь корпус) и выгрузка ВСЕГО поддерева вместо страницы.
  const rootId = graphNodeId(0, 0);
  await measureMedian('descendants_of:whole-graph', 3, () =>
    withIdentity(db, GRAPH_OWNER_ID, (tx) => tx.execute(compileCountAst(walkAllAst(rootId), ctx))),
  );
  await measureMedian('descendants_of:subtree-all-rows', 5, () =>
    withIdentity(db, GRAPH_OWNER_ID, (tx) =>
      tx.execute(compileQueryAst(walkAllAst(subtreeRoot), ctx)),
    ),
  );

  const subtree = await measureMedian('descendants_of:subtree', 7, () =>
    withIdentity(db, GRAPH_OWNER_ID, (tx) =>
      tx.execute(compileQueryAst(walkAst(subtreeRoot), ctx)),
    ),
  );

  // Пересчёт предков — под ролью ПРИЛОЖЕНИЯ и в транзакции, как в бою (executor.ts:799).
  // Первый вызов правит строки, последующие находят «уже правильно» и правят ноль, поэтому
  // мерится вызов на подготовленном поддереве — то, что и происходит при переносе ветки.
  await withIdentity(db, GRAPH_OWNER_ID, (tx) =>
    recomputeProjectAncestors(tx, GRAPH_OWNER_ID, [subtreeRoot], reg),
  );
  const recompute = await measureMedian('recompute:subtree5k', 5, () =>
    withIdentity(db, GRAPH_OWNER_ID, (tx) =>
      recomputeProjectAncestors(tx, GRAPH_OWNER_ID, [subtreeRoot], reg),
    ),
  );

  // Малое поддерево — та же операция на единицах узлов (см. докблок SMALL_ROOT_LEVEL).
  await withIdentity(db, GRAPH_OWNER_ID, (tx) =>
    recomputeProjectAncestors(tx, GRAPH_OWNER_ID, [smallRoot], reg),
  );
  const recomputeSmall = await measureMedian('recompute:subtree-small', 7, () =>
    withIdentity(db, GRAPH_OWNER_ID, (tx) =>
      recomputeProjectAncestors(tx, GRAPH_OWNER_ID, [smallRoot], reg),
    ),
  );

  // Пересчёт действительно что-то посчитал: обнулим кэш на поддереве и проверим, что вызов
  // возвращает число правок того же порядка, что размер поддерева. Без этой проверки
  // «≤ 1 с» выполнял бы и вызов, который не нашёл ни одной строки.
  const cleared = await withIdentity(db, GRAPH_OWNER_ID, async (tx) => {
    await tx.execute(sql`
      UPDATE entities SET props = props - 'orbis/parent_project' - 'orbis/root_project'
       WHERE owner_id = ${GRAPH_OWNER_ID}::uuid AND props ? 'orbis/parent_project'`);
    return recomputeProjectAncestors(tx, GRAPH_OWNER_ID, [subtreeRoot], reg);
  });
  expect(cleared.recomputed).toBeGreaterThanOrEqual(4900);

  const over: string[] = [];
  for (const [key, ms] of [
    ['descendants_of:subtree', subtree],
    ['recompute:subtree5k', recompute],
  ] as const) {
    // Строка про порог П6 печатается на КАЖДОМ прогоне и для достигнутого порога тоже:
    // «достигнут» — такой же факт замера, как «не достигнут», и исчезнуть из вывода он не
    // должен, иначе следующий читатель не отличит «порог взят» от «строку забыли».
    const met = ms <= BUDGETS_MS[key];
    console.log(
      `perf: ${key} — порог П6 ${BUDGETS_MS[key]} мс ${met ? 'ДОСТИГНУТ' : 'НЕ достигнут'}` +
        ` (замер ${ms.toFixed(0)} мс)`,
    );
    if (!met) over.push(`${key}=${ms.toFixed(0)}ms > ${BUDGETS_MS[key]}ms`);
  }
  // Малое поддерево порога П6 не несёт, но сторожит своё: пересчёт на единицах узлов не
  // должен стоить как на тысячах — иначе подсказка планировщику съела бы больше, чем дала.
  console.log(
    `perf: recompute:subtree-small — ${recomputeSmall.toFixed(0)} мс на ${smallSize} узлах` +
      ` (потолок сторожа ${SMALL_CEILING_MS} мс)`,
  );
  if (recomputeSmall > SMALL_CEILING_MS) {
    over.push(`recompute:subtree-small=${recomputeSmall.toFixed(0)}ms > ${SMALL_CEILING_MS}ms`);
  }
  expect(over).toEqual([]);
}, 900_000);
