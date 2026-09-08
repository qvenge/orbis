// apps/server/perf/volume.test.ts
// Корпус объёма Финансов (§С8-15): 20 000 движений, 480 конвертов, 12 периодов. Гоняется
// ОТДЕЛЬНЫМ скриптом `bun run test:perf:volume` — вне CI и вне `bun run test`/`test:perf`, по тому
// же доводу, что `test:perf:graph`: сев идёт десятки секунд, а под параллельной нагрузкой полного
// прогона медианы уезжают в разы (шапка `perf/perf.test.ts:1-25`).
// В вехе 0 здесь два сторожа (корпус наполнен; проход селектора равен бюджет-хуку) и БАЗОВАЯ
// ЛИНИЯ p95 `computeOverview` под ролью приложения. Порогов нет — их ставит задача 12.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type BudgetSubscription,
  canonicalJson,
  newId,
  ROLE_ENVELOPE_BINDING,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { computeOverview } from '../src/budget/aggregates';
import { selectEnvelopes } from '../src/budget/binding';
import { type Tx, withIdentity } from '../src/db/with-identity';
import { execute } from '../src/executor/executor';
import { effectiveRegistry } from '../src/registry/cache';
import { BUDGET_SUBSCRIPTION_ID, budgetOverviewOf } from '../src/subscriptions/budget';
import { builtinSubscription } from '../src/subscriptions/registry';
import { measureP95 } from '../src/test/perf';
import {
  cleanupVolumeProbes,
  ensureVolumeFixture,
  VOLUME_DEFAULT_CURRENCY,
  VOLUME_ENTITIES,
  VOLUME_ENVELOPES,
  VOLUME_ENVELOPES_PER_MONTH,
  VOLUME_LAST_MONTH,
  VOLUME_MIN_BINDINGS,
  VOLUME_MONTHS,
  VOLUME_OWNER_ID,
  VOLUME_TODAY,
  volumeCombination,
  volumeMonth,
  volumeProbeProps,
  volumeProbes,
} from '../src/test/volume-fixture';
import { adminDb, appDb, requireEnv } from '../test/helpers';

requireEnv();
const { db, client } = appDb();
/** Прогонов на замер — как в `graph.test.ts:61`: на семи p95 вырождается в максимум. */
const P95_RUNS = 20;
let fixture: Awaited<ReturnType<typeof ensureVolumeFixture>>;

beforeAll(async () => {
  const t0 = performance.now();
  fixture = await ensureVolumeFixture();
  console.log(
    `perf: корпус ${fixture.entities} сущностей / ${fixture.envelopes} конвертов /` +
      ` ${fixture.bindings} привязок (${
        fixture.seeded
          ? `засеян за ${((performance.now() - t0) / 1000).toFixed(1)} с`
          : 'взят из кеша'
      })`,
  );
  expect(fixture.entities).toBe(VOLUME_ENTITIES);
  // @ts-expect-error bun-types 1.2.7 не объявляет второй аргумент beforeAll — таймаут, — хотя
  // рантайм его принимает (та же пометка, что `graph.test.ts:169-172`).
}, 900_000);

afterAll(async () => {
  // Пробы сторожа — не часть корпуса: без уборки счётчик кеша разъедется и следующий прогон
  // пересеет 23 712 строк. Рёбра и версии уходят каскадом FK (`schema.ts:108/:111/:276-278`),
  // а вот строки `envelope_spent_cache` КОНВЕРТОВ, в которые пробы попали, — не уходят: их
  // сносит `cleanupVolumeProbes` (Ф-Б1-44). Уборка тут админ-SQL, то есть мимо исполнителя,
  // и кэш о ней узнать неоткуда.
  const admin = adminDb();
  try {
    await cleanupVolumeProbes(admin.db);
  } finally {
    await admin.client.end();
  }
  await client.end();
});

/**
 * Идентификаторы всех конвертов корпуса — ПОД ТОЙ ЖЕ РОЛЬЮ, что и замер.
 *
 * Порядок по `id` фиксирован: список уходит и в сторож, и в `invalidateSpentCache` холодного
 * замера, а недетерминированный порядок сделал бы «холодное» число невоспроизводимым.
 */
async function envelopeIdsOf(tx: Tx): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT id FROM entities
     WHERE owner_id = ${VOLUME_OWNER_ID} AND NOT archived AND 'orbis/budget' = ANY(aspects)
     ORDER BY id`)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

test('корпус наполнен: гейт меряет данные, а не пустой граф', async () => {
  expect(fixture.envelopes).toBe(VOLUME_ENVELOPES);
  expect(fixture.bindings).toBeGreaterThanOrEqual(VOLUME_MIN_BINDINGS);
  const overview = await withIdentity(db, VOLUME_OWNER_ID, (tx) =>
    computeOverview(tx, VOLUME_OWNER_ID, VOLUME_LAST_MONTH, VOLUME_TODAY),
  );
  expect(overview.envelopes).toHaveLength(VOLUME_ENVELOPES_PER_MONTH);
  // траты доехали до конвертов — иначе spent мерил бы пустоту (сторож `perf.test.ts:222`)
  expect(overview.envelopes.some((e) => e.spent !== '0.00')).toBe(true);
  // категории 30/31 конвертов не имеют — вторая половина Overview тоже под замером
  expect(overview.unbudgeted.length).toBeGreaterThan(0);
  expect(Number(overview.balance.expense)).toBeGreaterThan(0);
}, 900_000);

test('корпус: 480 конвертов видны под ролью приложения, а не только админу', async () => {
  // Корпус сеется прямыми INSERT под админ-DSN (Р-К-2/РП-8), а гейт мерит путь владельца.
  // Разъехался бы `owner_id` — админ строки видит, роль нет, и весь замер шёл бы по пустоте,
  // оставаясь зелёным (класс сторожа `perf.test.ts:212`, `graph.test.ts:181`).
  const ids = await withIdentity(db, VOLUME_OWNER_ID, (tx) => envelopeIdsOf(tx));
  expect(ids).toHaveLength(VOLUME_ENVELOPES);
  expect(new Set(ids).size).toBe(VOLUME_ENVELOPES);
}, 300_000);

test('Р-К-2: сто движений через исполнитель дают те же привязки, что проход селектора', async () => {
  const probes = volumeProbes();
  // 1. Что говорит проход фикстуры — тем же селектором и по тому же `volumeCombination`,
  //    которым сеялись 16 000+ привязок корпуса.
  const expected = await withIdentity(db, VOLUME_OWNER_ID, (tx) =>
    selectEnvelopes(tx, {
      ownerId: VOLUME_OWNER_ID,
      defaultCurrency: VOLUME_DEFAULT_CURRENCY,
      rows: probes.map((p) => {
        const c = volumeCombination(volumeProbeProps(p), ['orbis/financial']);
        if (c === null) throw new Error(`проба ${p.id} без комбинации — фикстура сломана`);
        return { key: p.id, ...c };
      }),
    }),
  );
  // 2. Что делает бюджет-хук на настоящем пути записи — своим `combinationOf`.
  const result = await execute(db, {
    actorUserId: VOLUME_OWNER_ID,
    actorKind: 'owner',
    source: 'ui',
    batchId: newId(),
    operations: probes.map((p) => ({
      tool: 'entity_create',
      input: {
        id: p.id,
        title: p.title,
        tags: [],
        props: volumeProbeProps(p),
        aspects: ['orbis/financial'],
      },
    })),
  });
  expect(result.ok).toBe(true);

  const rows = (await withIdentity(db, VOLUME_OWNER_ID, (tx) =>
    tx.execute(sql`
      SELECT r.target_id, r.source_id FROM relations r
      WHERE r.role = ${ROLE_ENVELOPE_BINDING}
        AND r.target_id IN (${sql.join(
          probes.map((p) => sql`${p.id}::uuid`),
          sql`, `,
        )})`),
  )) as unknown as Array<{ target_id: string; source_id: string }>;
  const actual = new Map<string, string | null>(probes.map((p) => [p.id, null]));
  for (const row of rows) actual.set(row.target_id, row.source_id);

  // Сверка ПОИМЁННАЯ, а не по числу: совпадение счётчиков при переставленных конвертах — ровно
  // тот дефект, ради которого сторож заведён.
  expect([...actual.entries()].sort()).toEqual([...expected.entries()].sort());
  // И сторож не выродился: у большинства проб конверт есть, у части — законно нет.
  const bound = [...actual.values()].filter((v) => v !== null).length;
  expect(bound).toBeGreaterThan(50);
  expect(bound).toBeLessThan(probes.length);
}, 300_000);

test('базовая линия: p95 computeOverview под ролью приложения (порога нет — он в задаче 12)', async () => {
  // Под ролью, а не под админ-DSN: под админом план другой (Р-9a-3, `perf/explain.test.ts`), и
  // число было бы честным, но не про тот путь, каким ходит владелец.
  const run = () =>
    withIdentity(db, VOLUME_OWNER_ID, (tx) =>
      computeOverview(tx, VOLUME_OWNER_ID, VOLUME_LAST_MONTH, VOLUME_TODAY),
    );
  const t0 = performance.now();
  await run(); // холодный прогон печатается отдельным числом (Р8), в p95 не входит
  console.log(`perf: volume:overview:cold ${(performance.now() - t0).toFixed(1)}ms`);
  const p95 = await measureP95('volume:overview', P95_RUNS, run);
  console.log(
    `perf: базовая линия Overview на 20k — p95 ${p95.toFixed(0)} мс (порог ставит задача 12)`,
  );
  expect(p95).toBeGreaterThan(0);
}, 900_000);

describe('§С8-15: Budget из подписки на синтетике 20k×40×12 — ноль расхождений', () => {
  /**
   * Сверка ДВУХПРОХОДНАЯ (Ф-Б1-44): холодный путь движка ≡ тёплый ≡ оракул.
   *
   * Одного прохода мало с тех пор, как ведомость `spent` материализуется (§Б5-5). На свежем
   * севе КАЖДЫЙ конверт читается ровно один раз (у месяца свои сорок), то есть один проход
   * меряет только ПРОМАХ — путь, в котором кэша фактически нет. Попадание тогда покрывалось бы
   * лишь повторным запуском всего гейта, а он идёт при реюзе корпуса, то есть в режиме, где
   * поломку легко списать на «грязный стенд».
   *
   * Поэтому кэш владельца сносится ЯВНО перед сверкой (уборка мимо исполнителя — значит и
   * мимо писателей кэша, Ф-Б1-44), первый вызов движка считает по графу и кладёт строки,
   * второй обязан вернуть то же самое из строк. Разъедься они — виноват кэш, и это видно
   * прямо здесь, а не на следующем прогоне.
   */
  test('12 месяцев × 40 конвертов: холодный ≡ тёплый ≡ оракул', async () => {
    const admin = adminDb();
    try {
      await admin.db.execute(
        sql`DELETE FROM envelope_spent_cache WHERE owner_id = ${VOLUME_OWNER_ID}::uuid`,
      );
    } finally {
      await admin.client.end();
    }
    const coldDiffs: string[] = [];
    const warmDiffs: string[] = [];
    for (let k = 0; k < VOLUME_MONTHS; k += 1) {
      const month = volumeMonth(k);
      await withIdentity(db, VOLUME_OWNER_ID, async (tx) => {
        const reg = await effectiveRegistry(tx, VOLUME_OWNER_ID);
        const def = builtinSubscription(reg, BUDGET_SUBSCRIPTION_ID) as BudgetSubscription;
        // Часы корпуса ПРИБИТЫ (`VOLUME_TODAY`): даты синтетики выведены из них, и с системным
        // «сегодня» корпус протухал бы каждую полночь.
        const a = await computeOverview(tx, VOLUME_OWNER_ID, month, VOLUME_TODAY);
        const cold = await budgetOverviewOf(
          tx,
          VOLUME_OWNER_ID,
          { month, today: VOLUME_TODAY },
          def,
          reg,
        );
        // Тот же вызов ВТОРОЙ раз: сорок строк кэша уже записаны первым, и ответ обязан
        // прийти из них — байт в байт.
        const warm = await budgetOverviewOf(
          tx,
          VOLUME_OWNER_ID,
          { month, today: VOLUME_TODAY },
          def,
          reg,
        );
        const oracle = canonicalJson(a);
        if (canonicalJson(cold) !== oracle) coldDiffs.push(month);
        if (canonicalJson(warm) !== oracle) warmDiffs.push(month);
        // Сторож: сверка идёт по ДАННЫМ, а не по пустоте — число из корпуса, не литералом.
        expect(a.envelopes.length).toBe(VOLUME_ENVELOPES_PER_MONTH);
      });
    }
    // Списки нарушителей, а не первый упавший; порознь — чтобы было видно, ЧЕЙ путь разошёлся.
    expect({ cold: coldDiffs, warm: warmDiffs }).toEqual({ cold: [], warm: [] });
    // И кэш действительно наполнился: иначе «тёплый» был бы вторым холодным, а сверка —
    // тавтологией «движок равен себе».
    const rows = (await withIdentity(db, VOLUME_OWNER_ID, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM envelope_spent_cache
                     WHERE owner_id = ${VOLUME_OWNER_ID}::uuid`),
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(VOLUME_ENVELOPES);
  }, 900_000);
});
