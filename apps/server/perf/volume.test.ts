// apps/server/perf/volume.test.ts
// Корпус объёма Финансов (§С8-15): 20 000 движений, 480 конвертов, 12 периодов. Гоняется
// ОТДЕЛЬНЫМ скриптом `bun run test:perf:volume` — вне CI и вне `bun run test`/`test:perf`, по тому
// же доводу, что `test:perf:graph`: сев идёт десятки секунд, а под параллельной нагрузкой полного
// прогона медианы уезжают в разы (шапка `perf/perf.test.ts:1-25`).
// В вехе 0 здесь два сторожа (корпус наполнен; проход селектора равен бюджет-хуку) и БАЗОВАЯ
// ЛИНИЯ p95 `computeOverview` под ролью приложения. Порогов нет — их ставит задача 12.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type BudgetOverview,
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
import type { RegistrySnapshot } from '../src/registry/load';
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

/**
 * Пороги §С8-15 — ДОСЛОВНО из спеки, а не «то, что получилось» (образец `graph.test.ts:63-69`).
 *
 * Второй важнее первого: «≤ 500 мс» ловит абсолютную негодность, «≤ 2× оракула» — регрессию
 * относительно сегодняшнего кода, то есть отвечает на вопрос среза «декларация вместо кода не
 * сделала хуже в разы». Оракул мерится ТЕМ ЖЕ прогоном на той же машине (Р-И-26); базовая линия
 * 0c — ориентир, не порог.
 *
 * Ориентир пробы П2 (`.superpowers/probe/p2/bench-B-indexed.txt`, RUNS=100 WARMUP=20,
 * ИНДЕКСИРОВАННЫЙ прогон — называть обязательно): 272,9 / 231,6 / 174,5 мс; без экспрессионных
 * индексов (`bench-A2-noindex.txt`) — 312,5 / 291,1 / 185,3. В репозитории этих индексов НЕТ
 * (миграция среза одна — 0018, Р-И-23), поэтому запас до 500 мс здесь меньше, чем был у пробы;
 * измеренный вход для решения об индексе дают вердикты EXPLAIN ниже.
 */
const VOLUME_BUDGETS = { overviewP95Ms: 500, ratioToOracle: 2 } as const;

interface Measured {
  oracleP95: number;
  engineP95: number;
}

/** Нарушители — СПИСКОМ, а не первым упавшим (образец `graph.test.ts:265/:289`). */
function gateViolations(
  m: Measured,
  budgets: { overviewP95Ms: number; ratioToOracle: number },
): string[] {
  const out: string[] = [];
  if (m.engineP95 > budgets.overviewP95Ms) {
    out.push(`overview:engine=${m.engineP95.toFixed(0)}ms > ${budgets.overviewP95Ms}ms`);
  }
  const ceiling = m.oracleP95 * budgets.ratioToOracle;
  if (m.engineP95 > ceiling) {
    out.push(
      `overview:engine=${m.engineP95.toFixed(0)}ms > ${budgets.ratioToOracle}× оракула (${ceiling.toFixed(0)}ms)`,
    );
  }
  return out;
}
let fixture: Awaited<ReturnType<typeof ensureVolumeFixture>>;
/**
 * Снимок реестра и декларация подписки — ОДИН раз на прогон, а не на каждый замер: в бою их
 * отдаёт кеш (`registry/cache.ts:103-104`), и промах кеша, попавший в p95, мерил бы первое
 * открытие приложения, а не чтение ведомостей.
 */
let reg: RegistrySnapshot;
let budgetDef: BudgetSubscription;

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
  reg = await withIdentity(db, VOLUME_OWNER_ID, (tx) => effectiveRegistry(tx, VOLUME_OWNER_ID));
  const def = builtinSubscription(reg, BUDGET_SUBSCRIPTION_ID);
  // Сужение объединения: подписка не той машинки — не «пустой Overview», а остановка прогона.
  if (def.engine !== 'budget') {
    throw new Error(`подписка ${BUDGET_SUBSCRIPTION_ID} не бюджетная: ${def.engine}`);
  }
  budgetDef = def;
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

/**
 * Обе реализации — на ОДНОЙ tx и с одним `today`. Реестр и подписка берутся из `beforeAll`.
 * Конвейер §2.8 (`preparePeriod`, `aggregates.ts:628`) не зовётся: он исполняет `execute()` в
 * СВОИХ транзакциях (докблок `aggregates.ts:8-12`), к подписке отношения не имеет и внутрь
 * одной tx не влезает; корпус 0c статичен.
 */
async function overviewPairOn(tx: Tx, month: string) {
  const oracle = await computeOverview(tx, VOLUME_OWNER_ID, month, VOLUME_TODAY);
  const engine = await budgetOverviewOf(
    tx,
    VOLUME_OWNER_ID,
    { month, today: VOLUME_TODAY },
    budgetDef,
    reg,
  );
  return { oracle, engine };
}

/**
 * Расхождения — ПОИМЁННО: «не равны» на сорока конвертах и шести ведомостях не говорит, ЧТО
 * разъехалось, а §С8-15 требует ноль расхождений «по всем 480 конвертам и всем ведомостям».
 * Сравнение через `canonicalJson` (`aspect-registry.ts:25`): jsonb не хранит порядок ключей, и
 * наивный `JSON.stringify` объявил бы расхождением любое значение, прошедшее через БД.
 */
function divergencesOf(oracle: BudgetOverview, engine: BudgetOverview, month: string): string[] {
  const out: string[] = [];
  const rest = new Map(engine.envelopes.map((e) => [e.envelope.id, e]));
  for (const o of oracle.envelopes) {
    const e = rest.get(o.envelope.id);
    if (!e) {
      out.push(`${month} ${o.envelope.id}: конверта нет в выдаче движка`);
      continue;
    }
    rest.delete(o.envelope.id);
    for (const f of ['spent', 'effectiveLimit', 'remaining', 'dailyPace', 'phase'] as const) {
      if (canonicalJson(o[f]) !== canonicalJson(e[f])) {
        out.push(
          `${month} ${o.envelope.id}.${f}: оракул ${canonicalJson(o[f])} ≠ движок ${canonicalJson(e[f])}`,
        );
      }
    }
  }
  for (const id of rest.keys()) out.push(`${month} ${id}: лишний конверт в выдаче движка`);
  for (const l of ['period', 'balance', 'comingUp', 'planned', 'unbudgeted', 'alertCount'] as const) {
    if (canonicalJson(oracle[l]) !== canonicalJson(engine[l])) {
      out.push(
        `${month} ведомость ${l}: оракул ${canonicalJson(oracle[l])} ≠ движок ${canonicalJson(engine[l])}`,
      );
    }
  }
  return out;
}

/**
 * ПРОГРЕТЫЙ корпус (Р8 рамки) — две вещи, обе обязательны.
 *
 * (1) Кэш `spent` (§Б5-5, задача 11) заполнен по всем двенадцати месяцам: первый Overview
 * считает промахи SQL'ем и пишет строки, дальше читает их. Мерить первый вызов значило бы
 * мерить холодный под видом прогретого.
 *
 * (2) У таблицы кэша есть статистика планировщика: без ANALYZE planner берёт умолчания, и
 * `budget.overview` на одной фикстуре давал то 64, то 464 мс (докблок `src/test/perf.ts:378`).
 * ANALYZE требует прав владельца — админ-DSN, как `truncateAll`.
 */
async function warmSpentCache(envelopeIds: readonly string[]): Promise<void> {
  expect(envelopeIds).toHaveLength(VOLUME_ENVELOPES);
  for (let k = 0; k < VOLUME_MONTHS; k++) {
    await withIdentity(db, VOLUME_OWNER_ID, (tx) =>
      budgetOverviewOf(
        tx,
        VOLUME_OWNER_ID,
        { month: volumeMonth(k), today: VOLUME_TODAY },
        budgetDef,
        reg,
      ),
    );
  }
  const admin = adminDb();
  try {
    await admin.db.execute(sql`ANALYZE envelope_spent_cache`);
  } finally {
    await admin.client.end();
  }
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

test('гейт §С8-15: пороги дословно из спеки и они действительно гейтят', () => {
  // Порог, подкрученный под результат, — самый дешёвый способ сделать гейт зелёным, поэтому
  // оба числа пинятся строкой: правка любого из них красит этот тест первым.
  expect(`${VOLUME_BUDGETS.overviewP95Ms}/${VOLUME_BUDGETS.ratioToOracle}`).toBe('500/2');
  // Мутационная проверка: без неё `expect(...).toEqual([])` в гейте был бы истинен и у функции,
  // которая ВСЕГДА возвращает пустой список, — дефект, из-за которого три проверки
  // `explain.test.ts` оказались тавтологиями (докблок `expectVerdict` там же).
  expect(gateViolations({ oracleP95: 100, engineP95: 600 }, VOLUME_BUDGETS)).toHaveLength(2);
  expect(gateViolations({ oracleP95: 100, engineP95: 150 }, VOLUME_BUDGETS)).toEqual([]);
});

test('сверка и замер — на одной транзакции: движок и оракул дают один Overview', async () => {
  // Полная сверка (12 месяцев × 40 конвертов, все ведомости) стоит выше и отвечает за §С8-15
  // «ноль расхождений». Эта отвечает за смысл ЧИСЛА: без неё p95 сравнивал бы две программы,
  // про равенство которых известно из соседнего теста, — а он мог отработать на другой tx и
  // при другом состоянии кэша spent.
  const diffs = await withIdentity(db, VOLUME_OWNER_ID, async (tx) => {
    const { oracle, engine } = await overviewPairOn(tx, VOLUME_LAST_MONTH);
    return divergencesOf(oracle, engine, VOLUME_LAST_MONTH);
  });
  expect(diffs).toEqual([]);
}, 300_000);

test('перф-гейт §С8-15: p95 движка ≤ 2× оракула и ≤ 500 мс на прогретом корпусе', async () => {
  const ids = await withIdentity(db, VOLUME_OWNER_ID, (tx) => envelopeIdsOf(tx));
  await warmSpentCache(ids);

  const oracleP95 = await measureP95('overview:oracle:warm', P95_RUNS, () =>
    withIdentity(db, VOLUME_OWNER_ID, (tx) =>
      computeOverview(tx, VOLUME_OWNER_ID, VOLUME_LAST_MONTH, VOLUME_TODAY),
    ),
  );
  const engineP95 = await measureP95('overview:engine:warm', P95_RUNS, () =>
    withIdentity(db, VOLUME_OWNER_ID, (tx) =>
      budgetOverviewOf(
        tx,
        VOLUME_OWNER_ID,
        { month: VOLUME_LAST_MONTH, today: VOLUME_TODAY },
        budgetDef,
        reg,
      ),
    ),
  );

  // Строка порога печатается на КАЖДОМ прогоне и для достигнутого тоже: «достигнут» — такой же
  // факт замера, как «не достигнут» (образец `graph.test.ts:270-279`).
  for (const [key, ceil] of [
    ['overview:engine ≤ 500 мс', VOLUME_BUDGETS.overviewP95Ms],
    ['overview:engine ≤ 2× оракула', oracleP95 * VOLUME_BUDGETS.ratioToOracle],
  ] as const) {
    console.log(
      `perf: ${key} — порог §С8-15 ${ceil.toFixed(0)} мс ${
        engineP95 <= ceil ? 'ДОСТИГНУТ' : 'НЕ достигнут'
      } (p95 = ${engineP95.toFixed(0)} мс, оракул ${oracleP95.toFixed(0)} мс,` +
        ` отношение ${(engineP95 / oracleP95).toFixed(2)}×)`,
    );
  }
  expect(gateViolations({ oracleP95, engineP95 }, VOLUME_BUDGETS)).toEqual([]);
}, 900_000);
