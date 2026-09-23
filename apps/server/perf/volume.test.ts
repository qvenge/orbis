// apps/server/perf/volume.test.ts
// Корпус объёма Финансов (§С8-15): 20 000 движений, 480 конвертов, 12 периодов. Гоняется
// ОТДЕЛЬНЫМ скриптом `bun run test:perf:volume` — вне CI и вне `bun run test`/`test:perf`, по тому
// же доводу, что `test:perf:graph`: сев идёт десятки секунд, а под параллельной нагрузкой полного
// прогона медианы уезжают в разы (шапка `perf/perf.test.ts:1-25`).
// В вехе 0 здесь два сторожа (корпус наполнен; проход селектора равен бюджет-хуку) и БАЗОВАЯ
// ЛИНИЯ p95 Overview под ролью приложения; задача 9 Б-1 добавила сверку «ноль расхождений»
// (холодный ≡ тёплый), задача 12 Б-1 — ГЕЙТ §С8-15 (p95 движка ≤ 500 мс на ПРОГРЕТОМ корпусе;
// холодный записывается, порога не несёт) и трёхзначные EXPLAIN-вердикты по горячим запросам
// Budget под ролью приложения (§С8-10, Р-14). С Б-2 второй реализации Overview нет (Р-32, В-10):
// «ноль расхождений» — сверка обоих путей движка со СНИМКОМ `test/golden/budget-engine.json`
// (половина `volume`), а половина гейта «≤ 2× второй реализации» ушла вместе с ней — сравнивать
// не с чем (Р-К-44); остаётся абсолютный порог.
//
// ЗАМЕР, машина: Intel Core i7-9750H @ 2,6 ГГц (12 потоков), 16 ГБ, Darwin 25.2.0, локальный
// Supabase в Docker; прогоны последовательные, ничего параллельного. Корпус: 23 712 сущностей /
// 480 конвертов / 16 211 привязок (счёт — из `ensureVolumeFixture`, не из головы); сев 76…99 с,
// прогон файла 39…50 с при реюзе, 124…136 с со свежим севом.
//
// ЗДЕСЬ ДИАПАЗОН ПО ВСЕМ ПРОГОНАМ, А НЕ ТОЧКА, и это не осторожность, а замер: p95 при n = 20 —
// ВТОРОЙ максимум выборки, и двух выбросов стенда хватает, чтобы сдвинуть его на десятки
// процентов при неподвижной медиане. Поэтому медиана стоит рядом с каждым p95, а гейтовая серия
// — N = 40 (Ф-Б1-47; p95 = 38-й из 40, третий сверху).
//   overview:engine:warm  p95 255…340 мс (медиана 224…276) — прогоны 08.09–23.09 (Б-1, вехи Б-2)
//   overview:engine:cold  p95 308…499 мс (медиана 294…407) — движок без кэша spent, порога нет
//   spent-cache:invalidate480 медиана 6,7…10,4 мс           — цена сноса 480 строк кэша
// Верх обоих диапазонов — пять прогонов 23.09 (задача 11 Б-2) под фоновой нагрузкой машины
// (load average 3,5…4,4): warm 273…340, cold 397…499.
// Числа гейтовой серии прогонов Б-1 и вех Б-2 сняты в чередующейся форме замера (две программы
// вызов за вызовом); с одной программой серия идёт подряд, и дрейф машины снимает прогрев кэша и
// медиана рядом с p95.
//
// ПОРОГ §С8-15 ДОСТИГНУТ во ВСЕХ прогонах. Числа — этой машины и этого корпуса, а не гарантия:
// увидел хуже записанного — РАСШИРЬ диапазон, а не молчи (дисциплина `perf.test.ts:100-107`,
// `graph.test.ts:74-88`). Порог при этом не трогать ни при каких числах: он дословно из спеки, и
// подкрутка под результат — первое, что ловит тест «пороги дословно из спеки».
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type BudgetOverview,
  type BudgetSubscription,
  canonicalJson,
  newId,
  ROLE_ENVELOPE_BINDING,
} from '@orbis/shared';
import { type SQL, sql } from 'drizzle-orm';
import { selectEnvelopes } from '../src/budget/binding';
import { invalidateSpentCache } from '../src/budget/spent-cache';
import { type Tx, withIdentity } from '../src/db/with-identity';
import { execute } from '../src/executor/executor';
import { lit } from '../src/query/compile-ast';
import { effectiveRegistry } from '../src/registry/cache';
import type { RegistrySnapshot } from '../src/registry/load';
import { BUDGET_SUBSCRIPTION_ID, budgetOverviewOf } from '../src/subscriptions/budget';
import { builtinSubscription } from '../src/subscriptions/registry';
import { BUDGET_ENGINE_GOLDEN, volumeSnapshotOf } from '../src/test/overview-golden';
import { measureMedian, measureP95 } from '../src/test/perf';
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
  VOLUME_PROBE_IDS,
  VOLUME_TODAY,
  volumeCombination,
  volumeMonth,
  volumeProbeProps,
  volumeProbes,
} from '../src/test/volume-fixture';
import { adminDb, appDb, personal, requireEnv } from '../test/helpers';

requireEnv();
const { db, client } = appDb();
/** Прогонов на замер — как в `graph.test.ts:61`: на семи p95 вырождается в максимум. */
const P95_RUNS = 20;
/**
 * Прогонов на КАЖДУЮ сторону гейта — сорок, а не двадцать (Ф-Б1-47, как §С8-16 в `perf.test.ts`).
 * При nearest-rank p95 на двадцати — ВТОРОЙ максимум, и один выброс стенда решал судьбу гейта; на
 * сорока p95 — 38-й из 40, третий сверху, и два выброса подряд гейт переживает.
 */
const GATE_P95_RUNS = 40;

/**
 * Порог §С8-15 — ДОСЛОВНО из спеки, а не «то, что получилось» (образец `graph.test.ts:63-69`).
 *
 * «≤ 500 мс» ловит абсолютную негодность. Вторая половина приёмки — «≤ 2× второй реализации в ТОМ
 * ЖЕ прогоне» — ушла вместе со второй реализацией (Р-32, Р-К-44): сравнивать не с чем, а
 * относительный порог «не хуже прошлого прогона» потребовал бы истории замеров, которой в срезе
 * нет. Регрессию ВЫВОДА держит снимок (`test/golden/budget-engine.json`), регрессию ВРЕМЕНИ —
 * абсолютный порог и диапазон в шапке.
 *
 * Ориентир пробы П2 (`.superpowers/probe/p2/bench-B-indexed.txt`, RUNS=100 WARMUP=20,
 * ИНДЕКСИРОВАННЫЙ прогон — называть обязательно): 272,9 / 231,6 / 174,5 мс; без экспрессионных
 * индексов (`bench-A2-noindex.txt`) — 312,5 / 291,1 / 185,3. В репозитории этих индексов НЕТ
 * (миграция среза одна — 0018, Р-И-23), поэтому запас до 500 мс здесь меньше, чем был у пробы;
 * измеренный вход для решения об индексе дают вердикты EXPLAIN ниже.
 */
const VOLUME_BUDGETS = { overviewP95Ms: 500 } as const;

interface Measured {
  engineP95: number;
}

/** Нарушители — СПИСКОМ, а не первым упавшим (образец `graph.test.ts:265/:289`). */
function gateViolations(m: Measured, budgets: { overviewP95Ms: number }): string[] {
  const out: string[] = [];
  if (m.engineP95 > budgets.overviewP95Ms) {
    out.push(`overview:engine=${m.engineP95.toFixed(0)}ms > ${budgets.overviewP95Ms}ms`);
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
  reg = await withIdentity(db, personal(VOLUME_OWNER_ID), (tx) =>
    effectiveRegistry(tx, VOLUME_OWNER_ID),
  );
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
  // пересеет 23 712 строк. Сам тест сторожа убирает их за собой (`finally`); здесь — страховка на
  // случай, если он упал раньше уборки. Рёбра и версии уходят каскадом FK (`schema.ts:108/:111/:276-278`),
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
     WHERE graph_id = ${VOLUME_OWNER_ID} AND NOT archived AND 'orbis/budget' = ANY(aspects)
     ORDER BY id`)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Движок на готовой tx с одним `today`. Реестр и подписка берутся из `beforeAll`.
 * Конвейер §2.8 (`preparePeriod` в `aggregates.ts`) не зовётся, и это видно по его сигнатуре:
 * он принимает `Db`, а не `Tx`, и зовётся ДО `withIdentity`, потому что внутри гоняет
 * `postDueInstances`/`materializeInstances` через `execute()` — в своих транзакциях. Внутрь одной
 * tx он не влезает, к подписке отношения не имеет, а корпус 0c статичен.
 */
function overviewOn(tx: Tx, month: string): Promise<BudgetOverview> {
  return budgetOverviewOf(tx, VOLUME_OWNER_ID, { month, today: VOLUME_TODAY }, budgetDef, reg);
}

type VolumeSnapshot = { envelopes: Array<Record<string, unknown>> } & Record<string, unknown>;

/**
 * Расхождения со снимком — ПОИМЁННО: «не равны» на сорока конвертах и шести ведомостях не говорит,
 * ЧТО разъехалось, а §С8-15 требует ноль расхождений «по всем 480 конвертам и всем ведомостям».
 * Конверты сверяются ПО ПОЗИЦИИ: порядок карточек — часть снимка (`normalizeOverview` нумерует id
 * по первой встрече), и переставленные конверты — расхождение, а не совпадение по множеству.
 * Сравнение через `canonicalJson` (`aspect-registry.ts:25`): jsonb не хранит порядок ключей, и
 * наивный `JSON.stringify` объявил бы расхождением любое значение, прошедшее через БД.
 */
function divergencesOf(expected: unknown, actual: unknown, month: string): string[] {
  const exp = expected as VolumeSnapshot;
  const act = actual as VolumeSnapshot;
  const out: string[] = [];
  const n = Math.max(exp.envelopes.length, act.envelopes.length);
  for (let i = 0; i < n; i++) {
    const e = exp.envelopes[i];
    const a = act.envelopes[i];
    if (e === undefined || a === undefined) {
      out.push(
        `${month} конверт #${i}: ${e === undefined ? 'лишний в выдаче движка' : 'нет в выдаче движка'}`,
      );
      continue;
    }
    for (const f of [
      'envelope',
      'category',
      'spent',
      'effectiveLimit',
      'remaining',
      'dailyPace',
      'phase',
    ]) {
      if (canonicalJson(e[f]) !== canonicalJson(a[f])) {
        out.push(
          `${month} конверт #${i}.${f}: снимок ${canonicalJson(e[f])} ≠ движок ${canonicalJson(a[f])}`,
        );
      }
    }
  }
  for (const l of ['period', 'balance', 'comingUp', 'planned', 'unbudgeted', 'alertCount']) {
    if (canonicalJson(exp[l]) !== canonicalJson(act[l])) {
      out.push(
        `${month} ведомость ${l}: снимок ${canonicalJson(exp[l])} ≠ движок ${canonicalJson(act[l])}`,
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
    await withIdentity(db, personal(VOLUME_OWNER_ID), (tx) =>
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

/**
 * Замер движка на ПРОГРЕТОМ корпусе — серия подряд внутри ОДНОЙ открытой tx.
 *
 * Прежде гейт мерил две программы ЧЕРЕДУЯСЬ, вызов за вызовом (Ф-Б1-47): относительный порог
 * иначе мерил дрейф стенда между двумя сериями не меньше, чем разницу реализаций. С одной
 * программой чередование теряет предмет; дрейф машины снимается прогревом (кэш `spent` и его
 * статистика — `warmSpentCache`; первый вызов серии печатается отдельным числом и в p95 не входит,
 * Р8) и медианой, которая печатается рядом с каждым p95.
 *
 * Мерится ЧИСТАЯ работа движка внутри уже открытой tx: `BEGIN`/`SET LOCAL ROLE`/`COMMIT` в замер
 * не входят (тот же довод, что у приёмки §С8-16: «замер — чтение внутри открытой tx»), — так число
 * сопоставимо с сериями прежней формы, где секундомер тоже стоял внутри транзакции.
 */
async function measureWarmP95(runs: number): Promise<Measured> {
  return withIdentity(db, personal(VOLUME_OWNER_ID), async (tx) => {
    const run = () => overviewOn(tx, VOLUME_LAST_MONTH);
    const t0 = performance.now();
    await run();
    console.log(`perf: overview:engine:warm:first ${(performance.now() - t0).toFixed(1)}ms`);
    return { engineP95: await measureP95('overview:engine:warm', runs, run) };
  });
}

// ---------------------------------------------------------------------------
// EXPLAIN-вердикты по горячим запросам Budget (§С8-10, Р-14) — вход решения об индексах
// ---------------------------------------------------------------------------

/** План под ролью приложения (образец `explain.test.ts:91`). */
async function planOf(query: SQL, forceIndex: boolean): Promise<string> {
  const rows = await withIdentity(db, personal(VOLUME_OWNER_ID), async (tx) => {
    if (forceIndex) await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    return [...(await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`))];
  });
  return JSON.stringify(rows);
}

/** Тот же план под админ-DSN: политик нет — значит нет и security qual (образец `:100`). */
async function adminPlanOf(query: SQL): Promise<string> {
  const admin = adminDb();
  try {
    const rows = await admin.db.transaction(async (tx) => [
      ...(await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`)),
    ]);
    return JSON.stringify(rows);
  } finally {
    await admin.client.end();
  }
}

interface Verdict {
  index: string;
  chosen: boolean;
  usable: boolean;
  usableWithoutRls: boolean;
  note: string;
}

const verdicts: Verdict[] = [];

/**
 * ТРИ вопроса, а не один (шапка `explain.test.ts:16-24`): выбран ли индекс под ролью; может ли
 * он быть выбран под ней вообще (`enable_seqscan = off`); берётся ли он под админ-DSN, где
 * политик нет. Третий отделяет «индекс не подходит запросу» от «подходит, но RLS не пускает» —
 * без него вердикт «не используется» читался бы как «снимайте» в обоих случаях.
 */
async function verdictFor(index: string, query: SQL, note: string): Promise<Verdict> {
  const v: Verdict = {
    index,
    chosen: (await planOf(query, false)).includes(index),
    usable: (await planOf(query, true)).includes(index),
    usableWithoutRls: (await adminPlanOf(query)).includes(index),
    note,
  };
  verdicts.push(v);
  console.log(
    `explain: ${index} — под ролью ${v.chosen ? 'ВЫБРАН' : 'НЕ выбран'}, при enable_seqscan=off ` +
      `${v.usable ? 'пригоден' : 'НЕ пригоден'}; под админ-DSN ` +
      `${v.usableWithoutRls ? 'ВЫБРАН' : 'не выбран'} — ${note}`,
  );
  return v;
}

/**
 * Доля корпуса в `entities` — ПОД АДМИН-DSN, потому что под ролью чужих владельцев не видно, а
 * планировщик их видит и считает по ним селективность.
 *
 * Число здесь не украшение: оно решает вердикт по `entities_graph_updated` (см. тест ниже).
 */
async function corpusShareOfEntities(): Promise<number> {
  const admin = adminDb();
  try {
    const rows = (await admin.db.execute(sql`
      SELECT (SELECT count(*) FROM entities WHERE graph_id = ${VOLUME_OWNER_ID}::uuid)::float8
             / greatest((SELECT count(*) FROM entities), 1)::float8 AS share`)) as unknown as Array<{
      share: number;
    }>;
    return Number(rows[0]?.share ?? 0);
  } finally {
    await admin.client.end();
  }
}

/**
 * Пин ИНВАРИАНТА, а не строки вердикта, — для индексов, чей выбор решает СЕЛЕКТИВНОСТЬ (Ф-Б1-48а).
 *
 * `entities_graph_updated` — ровно такой. Замер по восьми долям корпуса в `entities` (ревью 09.09; 100 % — естественная, семь —
 * копии строк под чужим владельцем + `ANALYZE` + EXPLAIN + `ROLLBACK`): 100 / 90 / 80 / 70 / 60 %
 * → Seq Scan; 50 / 40 / 31 % → Bitmap Index Scan по этому индексу. Точка переключения планировщика
 * лежит между 50 и 60 %, то есть `chosen` — не факт про индекс, а непрерывная функция состава
 * таблицы: естественный порядок `bun run test:perf` → `bun run test:perf:volume` оставляет рядом
 * фикстуру на ~3 тыс. строк, доля становится 89 %, и пин по порогу доли красит гейт ПРИ НЕТРОНУТОМ
 * КОДЕ (воспроизведено: 11/12).
 *
 * Что держится на ВСЕХ долях — два утверждения, и оба про RLS, а не про cost-модель:
 *   1. `usable === true` — индекс запросу подходит (при `enable_seqscan = off` берётся всегда);
 *   2. `chosen === usableWithoutRls` — политика `current_graph_select` выбор по этому индексу НЕ меняет.
 * Второе — содержательное трёхзначное утверждение файла и НЕ тавтология: у `entities_aspects_gin`
 * (форма движка) и у `relations_source_role` оно ЛОЖНО, и оба пинятся строкой рядом.
 */
function expectRlsNeutral(v: Verdict): void {
  expect(`${v.index}: usable=${v.usable} rls-neutral=${v.chosen === v.usableWithoutRls}`).toBe(
    `${v.index}: usable=true rls-neutral=true`,
  );
}

/** Пин вердикта СТРОКОЙ целиком: сменится любой из трёх флагов — тест покраснеет (образец `:162`). */
function expectVerdict(v: Verdict, expected: string): void {
  expect(`${v.index}: chosen=${v.chosen} usable=${v.usable} admin=${v.usableWithoutRls}`).toBe(
    `${v.index}: ${expected}`,
  );
}

/**
 * Карта видимости `relations` — ПОД АДМИН-DSN, как доля корпуса выше: это факт о таблице, а не о
 * модели доступа. `relallvisible / relpages` — то самое число, по которому планировщик оценивает
 * Index Only Scan, и именно оно решает, какой из двух индексов-близнецов обслужит привязки (докблок
 * `expectTwinServes`). Печатается рядом с вердиктом как объяснение, гейтом не является.
 */
async function relationsVisibility(): Promise<string> {
  const admin = adminDb();
  try {
    const rows = (await admin.db.execute(sql`
      SELECT relallvisible, relpages FROM pg_class WHERE oid = 'relations'::regclass`)) as unknown as Array<{
      relallvisible: number;
      relpages: number;
    }>;
    return `${rows[0]?.relallvisible}/${rows[0]?.relpages}`;
  } finally {
    await admin.client.end();
  }
}

/**
 * Пин ИНВАРИАНТА для пары индексов-БЛИЗНЕЦОВ с префиксом `source_id` — `relations_source_role`
 * (source_id, role) и `rel_uniq` (source_id, target_id, role); остаток 87 Б-1, снят задачей 2 Б-2.
 *
 * Какой из двух выберет планировщик под ролью, решает НЕ доля корпуса и НЕ код, а КАРТА ВИДИМОСТИ
 * `relations`: политика `current_graph_select` (0021) спрашивает оба конца ребра, и `rel_uniq`, несущий
 * `target_id` в самом индексе, выигрывает Index Only Scan'ом — но только когда страницы помечены
 * all-visible, то есть после VACUUM. Замер 23.09 (задача 2 Б-2), восемь долей корпуса в `entities`
 * (100 / 90 / 80 / 70 / 60 / 50 / 40 / 31 %: копии строк под чужим графом + `ANALYZE` + EXPLAIN +
 * `ROLLBACK`), два состояния таблицы:
 *   - прогретый корпус, `relallvisible` 261/265 (как 09.09 в Б-1) — на всех восьми долях
 *     `relations_source_role: chosen=false usable=false admin=true`, `rel_uniq: chosen=true usable=true
 *     admin=false`; это и был прежний трёхфлаговый пин обоих;
 *   - свежий сев корпуса до первого VACUUM, `relallvisible` 0/262 — на всех восьми долях
 *     `relations_source_role: chosen=true usable=true admin=false`, `rel_uniq: chosen=false usable=false
 *     admin=false`, а под админ-DSN — Seq Scan по `relations`.
 * Доля не сдвинула вердикт ни в одной точке; карта видимости перевернула его в каждой. Свежий сев — не
 * экзотика: корпус сносит любой `truncateAll`, и следующий `test:perf:volume` сеет заново, а успеет ли
 * autovacuum пройти `relations` до EXPLAIN (≈50 с после сева), решает случай — так пин и покраснел
 * 23.09 в предписанном порядке («volume ПЕРВЫМ», autovacuum `relations` — через 3 с ПОСЛЕ прогона).
 *
 * Что держится в ОБОИХ состояниях — одно утверждение о пути приложения: под ролью привязки конвертов
 * обслуживает индекс (хотя бы один из близнецов), и Seq Scan по `relations` в плане роли нет. Ровно
 * этот вопрос и задавал вход Р-14 («проиндексирован ли запрос»); имя близнеца — функция VACUUM, и
 * пинить его — пинить календарь автовакуума. Тот же приём, что множество близнецов у обхода
 * `descendants_of` в `explain.test.ts` (Ф-Г-62).
 */
function expectTwinServes(twins: readonly Verdict[], rolePlan: string): void {
  const served = twins.filter((v) => v.chosen).map((v) => v.index);
  const seqOnRelations = /"Node Type":\s*"Seq Scan"[^}]*?"Relation Name":\s*"relations"/.test(
    rolePlan,
  );
  expect(`индексом=${served.length > 0} seq-scan-relations=${seqOnRelations}`).toBe(
    'индексом=true seq-scan-relations=false',
  );
}

/**
 * Конверты месяца ФОРМОЙ СЫРОГО SQL — `'orbis/budget' = ANY(aspects)`. Ею по-прежнему пишут сырые
 * запросы Финансов мимо движка (преемники и траты без конверта в `rolloverPreview`, пречек
 * `rolloverCreate`, селектор `binding.ts`); прежде ею же отбирала конверты месяца вторая
 * реализация Overview, снесённая в Б-2 (Р-32), — вердикт по форме остаётся входом решения об
 * индексах. Сторож в тесте держит состав: копия обязана вернуть ровно сорок конвертов месяца.
 */
function envelopesOfMonthQuery(period: { start: string; end: string }): SQL {
  return sql`SELECT id FROM entities
     WHERE graph_id = ${VOLUME_OWNER_ID} AND NOT archived
       AND 'orbis/budget' = ANY(aspects)
       AND props->>'orbis/period_start' <= ${period.end}
       AND props->>'orbis/period_end' >= ${period.start}`;
}

/**
 * ТОТ ЖЕ отбор конвертов месяца, но ФОРМОЙ ДВИЖКА (Ф-Б1-48б) — `aspects @> ARRAY['orbis/budget']`.
 *
 * Так компилирует предикат контракта `expr/compile.ts:465` (литерал — `lit`,
 * `query/compile-ast.ts:130`), и этой ФОРМОЙ предиката аспекта приложение ходит после Б-1
 * (`subscriptions/budget.ts:308-310`). Копия несёт только предикат аспекта — без проверок обязательных
 * слотов `compileContractPredicate`, так что это вердикт о форме, не о боевом запросе целиком (дрейф
 * оригинала — остаток 12-m-3; сторож «те же 40 конвертов» держит состав). Разница с формой сырого SQL не косметическая: `@>` — операция,
 * которую GIN по массиву обслуживает, а `= ANY(…)` — scalar-array-op, и её не обслуживает никто.
 * Без вердикта по ЭТОЙ форме вход решения об индексах говорил бы о запросе, которого в бою нет.
 */
function engineAspectEnvelopesQuery(period: { start: string; end: string }): SQL {
  return sql`SELECT e.id FROM entities e
     WHERE e.graph_id = ${VOLUME_OWNER_ID} AND NOT e.archived
       AND e.aspects @> ARRAY[${lit('orbis/budget')}]
       AND e.props->>'orbis/period_start' <= ${period.end}
       AND e.props->>'orbis/period_end' >= ${period.start}`;
}

/**
 * Доступ к `relations` у ведомости `spent` движка (`sumLedgerSql`, ветка `bound_via`,
 * `subscriptions/budget.ts`) — ровно два предиката, и они решают выбор индекса: роль и множество
 * `source_id` (у движка `= ANY($ids)`, здесь `IN (…)` — для выбора индекса по `relations` это одно
 * условие). Фильтры по `entities` не переносятся намеренно: выбор индекса ПО `relations` они не
 * меняют, а джойн с `entities` и предикаты класса сделали бы вердикт вердиктом о ДРУГОМ запросе.
 *
 * ГЛАВНАЯ ЦЕНА ЭТОГО ЗАПРОСА ПОД РОЛЬЮ — не индекс, а политика. `current_graph_select` на `relations`
 * (`0021`) исполняется ДВУМЯ hashed SubPlan'ами, и каждый — Seq Scan по `entities` на 23 712
 * строк (живой EXPLAIN 09.09). Сам доступ к `relations` при этом Index Only Scan по `rel_uniq`;
 * то есть выбор индекса здесь уже оптимален, а платит запрос за проверку обоих концов ребра.
 *
 * ЧЕГО СТОРОЖ КОПИИ НЕ ЛОВИТ (остаток 12-m-3): он сверяет ЧИСЛО строк, а не текст запроса, и
 * дрейф ОРИГИНАЛА мимо копии пройдёт молча, если на корпусе он ничего не меняет (снятый
 * `NOT archived` при нуле архивных конвертов — проверено ревью). Форма сторожа предписана
 * брифом; замена — задача 19.
 */
function bindingsOfEnvelopesQuery(envelopeIds: readonly string[]): SQL {
  const ids = sql.join(
    envelopeIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`SELECT count(*)::text AS count FROM relations r
     WHERE r.role = ${ROLE_ENVELOPE_BINDING} AND r.source_id IN (${ids})`;
}

test('корпус наполнен: гейт меряет данные, а не пустой граф', async () => {
  expect(fixture.envelopes).toBe(VOLUME_ENVELOPES);
  expect(fixture.bindings).toBeGreaterThanOrEqual(VOLUME_MIN_BINDINGS);
  // Реестр и подписка уже сняты в `beforeAll` — тот же вход, что у замера.
  const overview = await withIdentity(db, personal(VOLUME_OWNER_ID), (tx) =>
    overviewOn(tx, VOLUME_LAST_MONTH),
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
  // Разъехался бы `graph_id` — админ строки видит, роль нет, и весь замер шёл бы по пустоте,
  // оставаясь зелёным (класс сторожа `perf.test.ts:212`, `graph.test.ts:181`).
  const ids = await withIdentity(db, personal(VOLUME_OWNER_ID), (tx) => envelopeIdsOf(tx));
  expect(ids).toHaveLength(VOLUME_ENVELOPES);
  expect(new Set(ids).size).toBe(VOLUME_ENVELOPES);
}, 300_000);

test('Р-К-2: сто движений через исполнитель дают те же привязки, что проход селектора', async () => {
  const probes = volumeProbes();
  try {
    await probeBindingsMatchSelector(probes);
  } finally {
    // УБОРКА СРАЗУ, а не в `afterAll`: пробы меняют `spent`, баланс и Unbudgeted корпуса, а снимок
    // `test/golden/budget-engine.json` снят с корпуса БЕЗ них. Порядок тестов файла снимку не
    // принадлежит (в Bun 1.2.7 тест из `describe` этого файла идёт РАНЬШЕ верхнеуровневых — замер
    // 23.09, родня Ф-Г-34), и доживи пробы до замера — сверка «меряется тот Overview, что в снимке»
    // сравнивала бы со снимком другой мир (так и покраснела на первом прогоне хода 3).
    const admin = adminDb();
    try {
      await cleanupVolumeProbes(admin.db);
    } finally {
      await admin.client.end();
    }
  }
}, 300_000);

async function probeBindingsMatchSelector(probes: ReturnType<typeof volumeProbes>): Promise<void> {
  // 1. Что говорит проход фикстуры — тем же селектором и по тому же `volumeCombination`,
  //    которым сеялись 16 000+ привязок корпуса.
  const expected = await withIdentity(db, personal(VOLUME_OWNER_ID), (tx) =>
    selectEnvelopes(tx, {
      graphId: VOLUME_OWNER_ID,
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
    identity: personal(VOLUME_OWNER_ID),
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

  const rows = (await withIdentity(db, personal(VOLUME_OWNER_ID), (tx) =>
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
}

test('базовая линия: p95 budgetOverviewOf под ролью приложения (порога нет — он в перф-гейте ниже)', async () => {
  // Под ролью, а не под админ-DSN: под админом план другой (Р-9a-3, `perf/explain.test.ts`), и
  // число было бы честным, но не про тот путь, каким ходит владелец. Меряется вместе с открытием
  // транзакции — так ходит прод; кэш `spent` здесь в том состоянии, в каком его оставил сев.
  const run = () =>
    withIdentity(db, personal(VOLUME_OWNER_ID), (tx) => overviewOn(tx, VOLUME_LAST_MONTH));
  const t0 = performance.now();
  await run(); // холодный прогон печатается отдельным числом (Р8), в p95 не входит
  console.log(`perf: volume:overview:cold ${(performance.now() - t0).toFixed(1)}ms`);
  const p95 = await measureP95('volume:overview', P95_RUNS, run);
  console.log(
    `perf: базовая линия Overview на 20k — p95 ${p95.toFixed(0)} мс (порог — в перф-гейте §С8-15)`,
  );
  expect(p95).toBeGreaterThan(0);
}, 900_000);

describe('§С8-15: Budget из подписки на синтетике 20k×40×12 — ноль расхождений', () => {
  /**
   * Сверка ДВУХПРОХОДНАЯ (Ф-Б1-44): холодный путь движка ≡ тёплый ≡ снимок.
   *
   * Снимок — половина `volume` файла `test/golden/budget-engine.json` (Р-32, В-10): снят движком и в
   * том же шаге последний раз сверен со второй реализацией Overview, после чего она снесена.
   * Пересдача — ЯВНАЯ, разбором расхождения, а не записью того, что вышло.
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
  test('12 месяцев × 40 конвертов: холодный ≡ тёплый ≡ снимок', async () => {
    const admin = adminDb();
    try {
      await admin.db.execute(
        sql`DELETE FROM envelope_spent_cache WHERE graph_id = ${VOLUME_OWNER_ID}::uuid`,
      );
    } finally {
      await admin.client.end();
    }
    const coldDiffs: string[] = [];
    const warmDiffs: string[] = [];
    for (let k = 0; k < VOLUME_MONTHS; k += 1) {
      const month = volumeMonth(k);
      await withIdentity(db, personal(VOLUME_OWNER_ID), async (tx) => {
        const reg = await effectiveRegistry(tx, VOLUME_OWNER_ID);
        const def = builtinSubscription(reg, BUDGET_SUBSCRIPTION_ID) as BudgetSubscription;
        // Часы корпуса ПРИБИТЫ (`VOLUME_TODAY`): даты синтетики выведены из них, и с системным
        // «сегодня» корпус протухал бы каждую полночь.
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
        const snapshot = canonicalJson(BUDGET_ENGINE_GOLDEN.volume[month]);
        if (canonicalJson(volumeSnapshotOf(cold)) !== snapshot) coldDiffs.push(month);
        if (canonicalJson(volumeSnapshotOf(warm)) !== snapshot) warmDiffs.push(month);
        // Сторож: сверка идёт по ДАННЫМ, а не по пустоте — число из корпуса, не литералом.
        expect(cold.envelopes.length).toBe(VOLUME_ENVELOPES_PER_MONTH);
      });
    }
    // Списки нарушителей, а не первый упавший; порознь — чтобы было видно, ЧЕЙ путь разошёлся.
    expect({ cold: coldDiffs, warm: warmDiffs }).toEqual({ cold: [], warm: [] });
    // И кэш действительно наполнился: иначе «тёплый» был бы вторым холодным, а сверка —
    // тавтологией «движок равен себе».
    const rows = (await withIdentity(db, personal(VOLUME_OWNER_ID), (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM envelope_spent_cache
                     WHERE graph_id = ${VOLUME_OWNER_ID}::uuid`),
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(VOLUME_ENVELOPES);
  }, 900_000);
});

test('гейт §С8-15: пороги дословно из спеки и они действительно гейтят', () => {
  // Порог, подкрученный под результат, — самый дешёвый способ сделать гейт зелёным, поэтому
  // число пинится строкой: его правка красит этот тест первым. Половина «≤ 2×» ушла вместе со
  // второй реализацией (Р-К-44) — пин держит и то, что она не вернулась молча.
  expect(Object.values(VOLUME_BUDGETS).join('/')).toBe('500');
  // Мутационная проверка: без неё `expect(...).toEqual([])` в гейте был бы истинен и у функции,
  // которая ВСЕГДА возвращает пустой список, — дефект, из-за которого три проверки
  // `explain.test.ts` оказались тавтологиями (докблок `expectVerdict` там же).
  expect(gateViolations({ engineP95: 600 }, VOLUME_BUDGETS)).toHaveLength(1);
  expect(gateViolations({ engineP95: 150 }, VOLUME_BUDGETS)).toEqual([]);
});

test('замер и сверка со снимком на одной транзакции: меряется тот Overview, что в снимке', async () => {
  // Полная сверка (12 месяцев × 40 конвертов, все ведомости) стоит выше и отвечает за §С8-15
  // «ноль расхождений». Эта отвечает за смысл ЧИСЛА: без неё p95 мерил бы программу, про
  // правильность которой известно из соседнего теста, — а он мог отработать на другой tx и при
  // другом состоянии кэша spent. Расхождения — поимённо (`divergencesOf`).
  const diffs = await withIdentity(db, personal(VOLUME_OWNER_ID), async (tx) =>
    divergencesOf(
      BUDGET_ENGINE_GOLDEN.volume[VOLUME_LAST_MONTH],
      volumeSnapshotOf(await overviewOn(tx, VOLUME_LAST_MONTH)),
      VOLUME_LAST_MONTH,
    ),
  );
  expect(diffs).toEqual([]);
}, 300_000);

test('перф-гейт §С8-15: p95 движка ≤ 500 мс на прогретом корпусе', async () => {
  const ids = await withIdentity(db, personal(VOLUME_OWNER_ID), (tx) => envelopeIdsOf(tx));
  await warmSpentCache(ids);

  const { engineP95 } = await measureWarmP95(GATE_P95_RUNS);

  // Строка порога печатается на КАЖДОМ прогоне и для достигнутого тоже: «достигнут» — такой же
  // факт замера, как «не достигнут» (образец `graph.test.ts:270-279`). Подпись строится ИЗ порога,
  // а не пишется числом второй раз: разъехавшаяся подпись («≤ 500 мс» при пороге 100) — первое,
  // что видит читатель лога, и она бы врала.
  const ceil = VOLUME_BUDGETS.overviewP95Ms;
  console.log(
    `perf: overview:engine ≤ ${ceil} мс — порог §С8-15 ${
      engineP95 <= ceil ? 'ДОСТИГНУТ' : 'НЕ достигнут'
    } (p95 = ${engineP95.toFixed(0)} мс)`,
  );
  expect(gateViolations({ engineP95 }, VOLUME_BUDGETS)).toEqual([]);
}, 900_000);

test('холодный корпус: p95 без кэша spent записывается (порога не несёт)', async () => {
  const ids = await withIdentity(db, personal(VOLUME_OWNER_ID), (tx) => envelopeIdsOf(tx));
  // Цена самой инвалидации — отдельной строкой: иначе читатель не отличит «движок медленный без
  // кэша» от «DELETE 480 строк дорогой», а холодное число включает и то и другое.
  await measureMedian('spent-cache:invalidate480', 5, () =>
    withIdentity(db, personal(VOLUME_OWNER_ID), (tx) =>
      invalidateSpentCache(tx, VOLUME_OWNER_ID, ids),
    ),
  );
  const cold = await measureP95('overview:engine:cold', P95_RUNS, () =>
    withIdentity(db, personal(VOLUME_OWNER_ID), async (tx) => {
      // Инвалидация и расчёт — в ОДНОЙ tx: расчёт тут же перезаписывает строки кэша, поэтому
      // следующий прогон снова холодный. Разнеси по двум tx — второй замер стал бы прогретым.
      await invalidateSpentCache(tx, VOLUME_OWNER_ID, ids);
      return budgetOverviewOf(
        tx,
        VOLUME_OWNER_ID,
        { month: VOLUME_LAST_MONTH, today: VOLUME_TODAY },
        budgetDef,
        reg,
      );
    }),
  );
  console.log(
    `perf: overview:engine:cold p95 = ${cold.toFixed(0)} мс — ЗАПИСЫВАЕТСЯ, порога нет (Р8 рамки)`,
  );
  expect(cold).toBeGreaterThan(0);
}, 900_000);

test('EXPLAIN под ролью: GIN недостижим в ОБЕИХ формах, btree по владельцу RLS-нейтрален', async () => {
  const period = await withIdentity(db, personal(VOLUME_OWNER_ID), async (tx) => {
    // границы месяца считает сам движок — копии календаря нет
    return (await overviewOn(tx, VOLUME_LAST_MONTH)).period;
  });
  const q = envelopesOfMonthQuery(period);
  // Сторож копии: без этой строки запрос мог бы разъехаться с множеством конвертов месяца молча —
  // тогда вердикт был бы вердиктом о другом запросе.
  const ids = await withIdentity(db, personal(VOLUME_OWNER_ID), async (tx) => [
    ...((await tx.execute(q)) as unknown as Array<{ id: string }>),
  ]);
  expect(ids).toHaveLength(VOLUME_ENVELOPES_PER_MONTH);

  // ВЕРДИКТ снят прогоном 09.09 и записан как есть (Р-К-41: пин, а не предсказание).
  //
  // Форма СЫРОГО SQL (`= ANY(aspects)`): chosen=false usable=false admin=FALSE. Третий флаг здесь
  // важнее двух первых — недостижимость НЕ про RLS: `'orbis/budget' = ANY(aspects)` это
  // scalar-array-op, а GIN по массиву обслуживает операции вхождения (`@>`, `&&`). Эту форму не
  // берёт никто и ни под какой ролью, и `enable_seqscan = off` её не спасает.
  expectVerdict(
    await verdictFor(
      'entities_aspects_gin',
      q,
      'конверты месяца, форма СЫРОГО SQL (= ANY(aspects))',
    ),
    'chosen=false usable=false admin=false',
  );

  // ПЯТЫЙ вердикт — по форме ДВИЖКА (Ф-Б1-48б), и он переворачивает вывод предыдущего.
  //
  // Приложение после Б-1 ходит `aspects @> ARRAY['orbis/budget']`, а это ровно та операция,
  // которую GIN обслуживает: под АДМИНОМ план берёт `entities_aspects_gin` (480 строк, 26
  // heap-блоков против Seq Scan по 23 712). Под ролью — нет, и причина названа в
  // `explain.test.ts:27-38`: политика `current_graph_select` приходит security qual'ом, а
  // `arraycontains` не leakproof (`pg_proc.proleakproof = false`), поэтому индексным условием
  // containment стать не может в принципе. То есть «сперва форма предиката, потом индекс»
  // приложению НИЧЕГО не даёт — форма уже правильная, не пускает модель доступа. Тем же мерилом
  // измерены и экспрессионные индексы пробы П2 (`props->>'orbis/period_*'`): `->>`
  // (`jsonb_object_field_text`) тоже не leakproof, и под ролью у них нет `Index Cond` вовсе.
  const qEngine = engineAspectEnvelopesQuery(period);
  const idsEngine = await withIdentity(db, personal(VOLUME_OWNER_ID), async (tx) => [
    ...((await tx.execute(qEngine)) as unknown as Array<{ id: string }>),
  ]);
  // Сторож копии: форма другая — множество то же самое, иначе вердикты сравнивались бы по разным
  // запросам, а не по разным формам одного.
  expect(idsEngine).toHaveLength(VOLUME_ENVELOPES_PER_MONTH);
  expectVerdict(
    await verdictFor(
      'entities_aspects_gin',
      qEngine,
      'те же конверты месяца, форма ДВИЖКА (aspects @> ARRAY[…])',
    ),
    'chosen=false usable=false admin=true',
  );

  // `entities_graph_updated` — пин ИНВАРИАНТА, а не строки (Ф-Б1-48а; докблок `expectRlsNeutral`).
  // Доля печатается как факт замера: она объясняет `chosen`, но гейтом не является.
  const share = await corpusShareOfEntities();
  console.log(
    `explain: корпус занимает ${(share * 100).toFixed(0)} % таблицы entities` +
      ' — доля объясняет chosen, но пином не является (Ф-Б1-48а)',
  );
  expectRlsNeutral(
    await verdictFor(
      'entities_graph_updated',
      q,
      `частичный btree (graph_id, updated_at); доля корпуса ${(share * 100).toFixed(0)} %`,
    ),
  );
}, 300_000);

test('EXPLAIN под ролью: привязки конвертов обслуживает индекс-близнец, а не Seq Scan по relations', async () => {
  const ids = await withIdentity(db, personal(VOLUME_OWNER_ID), (tx) => envelopeIdsOf(tx));
  const q = bindingsOfEnvelopesQuery(ids);
  const { total, probeBound } = await withIdentity(db, personal(VOLUME_OWNER_ID), async (tx) => {
    const rows = (await tx.execute(q)) as unknown as Array<{ count: string }>;
    // Пробы сторожа Р-К-2 создаёт соседний тест ЧЕРЕЗ ИСПОЛНИТЕЛЬ, и бюджет-хук привязывает их
    // к тем же конвертам корпуса — их вклад считается отдельно, иначе сторож копии сравнивал бы
    // счёт корпуса со счётом «корпус плюс пробы». Тест сторожа убирает их за собой, так что вклад
    // обычно ноль; счёт остаётся страховкой от прогона, упавшего до уборки.
    const probes = (await tx.execute(sql`
      SELECT count(*)::text AS count FROM relations r
       WHERE r.role = ${ROLE_ENVELOPE_BINDING}
         AND r.target_id IN (${sql.join(
           VOLUME_PROBE_IDS.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})`)) as unknown as Array<{ count: string }>;
    return { total: Number(rows[0]?.count), probeBound: Number(probes[0]?.count) };
  });
  // Сторож копии: столько же, сколько насеяла 0c.
  expect(total - probeBound).toBe(fixture.bindings);
  // Вердикты ОБОИХ близнецов снимаются и печатаются (сводка ниже пинит их список), но гейтом служит
  // инвариант `expectTwinServes`, а не строка трёх флагов: какой из двух берёт план роли, решает
  // карта видимости `relations` (VACUUM после сева), и она печатается рядом как объяснение.
  //
  // Прежний ответ входа Р-14 «`relations_source_role` для пути приложения — кандидат в лишние» замер
  // 23.09 опроверг: на свежезасеянной таблице путь роли обслуживает именно он, а `rel_uniq` не
  // пригоден вовсе. Лишним по этому запросу не оказался ни один из двух.
  const visibility = await relationsVisibility();
  const twins = [
    await verdictFor(
      'relations_source_role',
      q,
      `привязки 480 конвертов, роль ${ROLE_ENVELOPE_BINDING}; relallvisible ${visibility}`,
    ),
    await verdictFor(
      'rel_uniq',
      q,
      `он же — уникальный (source_id, target_id, role); relallvisible ${visibility}`,
    ),
  ];
  console.log(
    `explain: карта видимости relations ${visibility} (relallvisible/relpages) — она выбирает ` +
      'близнеца, пином не является (остаток 87)',
  );
  expectTwinServes(twins, await planOf(q, false));
}, 300_000);

test('сводка EXPLAIN напечатана по всем снятым вердиктам', () => {
  // Список пинится целиком: вердикт, выпавший из прогона (тест переименовали, вызов потеряли),
  // иначе исчез бы из сводки молча, а сводка — это ВЕСЬ отчёт задачи об индексах.
  // `entities_aspects_gin` стоит ДВАЖДЫ намеренно: две формы одного отбора (сырого SQL и движка)
  // дают РАЗНЫЕ вердикты, и именно эта пара — главный вход решения (Ф-Б1-48б).
  expect(verdicts.map((v) => v.index).sort()).toEqual(
    [
      'entities_aspects_gin',
      'entities_aspects_gin',
      'entities_graph_updated',
      'rel_uniq',
      'relations_source_role',
    ].sort(),
  );
  console.log('explain: СВОДКА ДЛЯ РЕШЕНИЯ ОБ ИНДЕКСАХ (вход 0019/Б-2, не Б-1)');
  for (const v of verdicts) {
    // Ветки читают ВСЕ ТРИ флага, а не два: «не выбран» и «не пригоден» — разные новости.
    // Пригодный, но не выбранный индекс снимать нельзя (его берёт другой профиль данных);
    // не пригодный ни под какой ролью говорит о ФОРМЕ запроса, а не об индексе.
    const why = v.chosen
      ? 'используется приложением'
      : v.usable
        ? `под ролью НЕ выбирается, но пригоден (при enable_seqscan=off берётся) — планировщик предпочёл другой доступ; под админ-DSN ${v.usableWithoutRls ? 'выбирается' : 'тоже не выбирается'}`
        : v.usableWithoutRls
          ? 'приложением НЕ используется, хотя запросу подходит: под ролью его не пускает модель доступа (предикат не leakproof либо политика спрашивает больше колонок); под админ-DSN работает'
          : 'форма запроса индексом не покрывается ни под какой ролью';
    // Пометка печатается ВМЕСТЕ с именем: две строки одного индекса различает только она.
    console.log(
      `  ${v.index} [${v.note}]: chosen=${v.chosen} usable=${v.usable} admin=${v.usableWithoutRls} — ${why}`,
    );
  }
});
