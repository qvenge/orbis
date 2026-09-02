// apps/server/perf/explain.test.ts
//
// ЗАМЕР ПЛАНОВ — приёмка миграции 0017 («Пересев мира», Задача 23b). Файл писался как ВХОД
// решения («какой GIN 0015 доказал, что им пользуются»), а с накатом 0017 стал его ПИНОМ:
// решение принято и записано здесь же — ни один из трёх GIN не снимается, и вердикт, на
// котором это стоит, обязан покраснеть, если изменится.
//
// Гоняется отдельным скриптом `bun run test:perf:explain` — вне CI и вне `bun run test`
// (сев корпуса на 50 000 строк — 22…25 с; число печатает сам прогон строкой
// `explain: корпус …`, а засевает его та же фикстура, что и перф-гейт).
//
// ПОЧЕМУ ПОД РОЛЬЮ ПРИЛОЖЕНИЯ, А НЕ ПОД АДМИН-DSN. Роль без `BYPASSRLS` получает поверх
// запроса политику `owner_owns_row` (`owner_id = (SELECT auth.uid())`), и планировщик видит
// ДРУГОЙ запрос: у него появляется второй отбор, меняется оценка селективности, а вместе с
// ней — и выбор доступа. Вердикт, снятый под админом, к бою отношения не имеет (§А1-4/§С8-10).
//
// ТРИ ВОПРОСА, А НЕ ОДИН, и их нельзя путать:
//   1. ВЫБРАН ли индекс планировщиком под ролью приложения — это и есть «им пользуются»;
//   2. МОЖЕТ ли он быть выбран под ней вообще (`enable_seqscan = off`);
//   3. берётся ли он под АДМИН-DSN, где политик нет.
// Третий вопрос отделяет «индекс не подходит запросу» от «индекс подходит, но RLS его не
// пускает», и без него вердикт «не используется» читался бы как «снимайте» в обоих случаях.
// Ловушка, уже стоившая этой ветке времени: подзапросная форма `= ANY((SELECT …))` роняет
// GIN молча — то есть «не выбран» бывает свойством ЗАПРОСА, а не индекса.
//
// ЧТО ЗАМЕР ПОКАЗАЛ (2026-08-27) И ПОЧЕМУ ЭТО ГЛАВНОЕ В ФАЙЛЕ. Под ролью приложения ни один
// GIN на `entities` НЕ ПРИМЕНИМ — и это не про селективность и не про размер корпуса.
// Политика `owner_owns_row` (0001) — security qual, а операторы containment НЕ leakproof
// (`pg_proc.proleakproof = false` у `jsonb_contains`, `arraycontains`, `jsonb_exists`;
// пиннится тестом ниже). PostgreSQL обязан проверить security qual ПЕРВОЙ, а индексное
// условие проверяется до неё — поэтому не-leakproof предикат индексным условием стать не
// может в принципе. Под админ-DSN тот же запрос берёт GIN и отрабатывает за доли
// миллисекунды; под ролью приложения — Bitmap Heap Scan по `entities_owner_updated` с
// фильтром по куче (44 мс против 0,5 мс на 50 000 строк).
//
// Отсюда и предупреждение выжимки «роль без BYPASSRLS видит другой план» оказалось сильнее,
// чем звучало: под админом план не просто другой — он недостижим для приложения.
//
// РЕШЕНИЕ, ПРИНЯТОЕ ПО ЭТОМУ ЗАМЕРУ (Р-23b-1, миграция 0017): все три GIN 0015 ОСТАВЛЕНЫ.
// «Не используется приложением» здесь — свойство модели доступа, а не индекса: то же верно
// для ВСЕХ дореформенных GIN/FTS на `entities`, и снятие по этому признаку выкосило бы их
// все. Под админ-DSN ходят сиды, скрипты и `ops.ts` — для них индексы работают.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bindQueryBlocks, parseBody, queryRefsFromDoc } from '@orbis/shared/doc';
import { type SQL, sql } from 'drizzle-orm';
import { withIdentity } from '../src/db/with-identity';
import { MEMORY_ASPECT } from '../src/memory/rules';
import { memoryEntitiesWhere } from '../src/memory/select';
import { compileCountAst } from '../src/query/compile-ast';
// `loadRegistry` не существует с тех пор, как чтение реестра переехало в кеш
// (`registry/cache.ts:effectiveRegistry`). Файл гоняется вне `bun run test`, поэтому
// переименование прошло мимо него молча: до этой правки прогон падал ещё на импорте —
// `SyntaxError: Export named 'loadRegistry' not found`. Чинится здесь, потому что иначе
// переносить сюда замер было бы некуда (Задача 18, ре-ревью).
import { effectiveRegistry, parseRegistryOfSnapshot } from '../src/registry/cache';
import type { RegistrySnapshot } from '../src/registry/load';
import {
  ensureGraphFixture,
  GRAPH_ENTITIES,
  GRAPH_OWNER_ID,
  RARE_ASPECT,
  RARE_PROPERTY,
  RARE_VALUE,
} from '../src/test/graph-fixture';
import { adminDb, appDb, requireEnv } from '../test/helpers';

requireEnv();

const { db, client } = appDb();

let reg: RegistrySnapshot;

beforeAll(async () => {
  const fixture = await ensureGraphFixture();
  console.log(
    `explain: корпус ${fixture.entities} сущностей / ${fixture.relations} рёбер` +
      ` (${fixture.seeded ? 'засеян' : 'взят из кеша'})`,
  );
  expect(fixture.entities).toBe(GRAPH_ENTITIES);
  reg = await withIdentity(db, GRAPH_OWNER_ID, (tx) => effectiveRegistry(tx, GRAPH_OWNER_ID));
  // @ts-expect-error bun-types 1.2.7 не объявляет второй аргумент `beforeAll` — таймаут, —
  // хотя рантайм его принимает. Убрать число нельзя: засев корпуса в 150k рёбер идёт минуты
  // и упёрся бы в умолчание хука. Пометка снимется сама, когда типы догонят рантайм.
}, 900_000);

afterAll(async () => {
  await client.end();
});

/** Плоский текст плана: EXPLAIN (FORMAT JSON) под ролью приложения. */
async function planOf(query: SQL, forceIndex: boolean): Promise<string> {
  const rows = await withIdentity(db, GRAPH_OWNER_ID, async (tx) => {
    if (forceIndex) await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    return [...(await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`))];
  });
  return JSON.stringify(rows);
}

/** Тот же план, но под админ-DSN: политик нет, значит нет и security qual. */
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

async function verdictFor(index: string, query: SQL, note: string): Promise<Verdict> {
  const chosen = (await planOf(query, false)).includes(index);
  const usable = (await planOf(query, true)).includes(index);
  const usableWithoutRls = (await adminPlanOf(query)).includes(index);
  const v: Verdict = { index, chosen, usable, usableWithoutRls, note };
  verdicts.push(v);
  console.log(
    `explain: ${index} — под ролью приложения ${chosen ? 'ВЫБРАН' : 'НЕ выбран'}, ` +
      `при enable_seqscan=off ${usable ? 'пригоден' : 'НЕ пригоден'}; ` +
      `под админ-DSN ${usableWithoutRls ? 'ВЫБРАН' : 'не выбран'} — ${note}`,
  );
  return v;
}

/**
 * Индексы, которые contract-миграция 0017 СНИМАЕТ, — дословно из её текста.
 *
 * Два первых уходят вместе с колонками (`entities.aspects_legacy`, `entities.meta`), два
 * последних — явным `DROP INDEX` вместе с колонкой `relations.relation_type`. Список нужен
 * здесь ради одного утверждения: НИ ОДИН из индексов, по которым этот файл снимает вердикт,
 * в него не входит — то есть решение «оставить» принято по замеру, а не по забывчивости.
 */
const DROPPED_BY_0017: readonly string[] = [
  'entities_aspects_legacy_gin',
  'entities_meta_gin',
  'relations_source_type',
  'relations_target_type',
];

/**
 * ПИН ВЕРДИКТА — строкой целиком, а не тремя `typeof … === 'boolean'`.
 *
 * До этой задачи три из семи проверок файла были ТАВТОЛОГИЯМИ: `expect(typeof v.chosen)
 * .toBe('boolean')` истинно при любом замере, то есть «7 pass» означало «семь тестов
 * отработали», а не «семь проверок что-то проверили» (долг 4 ветки). Файл вне `bun run
 * test`, и покраснеть этому было негде.
 *
 * Теперь вердикт пинится целиком: сменится любой из трёх флагов — тест покраснеет и
 * заставит перечитать DROP-список 0017. Именно это и есть приёмка «EXPLAIN против 0017».
 */
function expectVerdict(v: Verdict, expected: string): void {
  expect(DROPPED_BY_0017).not.toContain(v.index);
  expect(`${v.index}: chosen=${v.chosen} usable=${v.usable} admin=${v.usableWithoutRls}`).toBe(
    `${v.index}: ${expected}`,
  );
}

const ctx = () => ({
  ownerId: GRAPH_OWNER_ID,
  today: '2026-07-03',
  timeZone: 'Europe/Moscow',
  reg,
});

test('вердикт по entities_props_gin: горячий запрос — containment по props', async () => {
  // Горячий запрос — ровно тот, что порождает компилятор для `<списочное свойство>=v`:
  // containment ОТ КОРНЯ колонки. Подпутевая форма (`props->'x' ?| …`) этим индексом не
  // покрывается вовсе, и вердикт по ней был бы вердиктом о другой форме запроса.
  const query = compileCountAst(
    { filter: { prop: RARE_PROPERTY, op: 'contains', value: RARE_VALUE } },
    ctx(),
  );
  const v = await verdictFor(
    'entities_props_gin',
    query,
    `props @> {"${RARE_PROPERTY}":["${RARE_VALUE}"]} на ${GRAPH_ENTITIES} строках, ~50 совпадений`,
  );
  // ВЕРДИКТ 0017: приложением НЕ используется, под админ-DSN — используется. Причина одна
  // на все три GIN и не в индексе: политика `owner_owns_row` приходит security qual'ом, а
  // `jsonb_contains` не leakproof (пиннится отдельным тестом ниже). Поэтому 0017 индекс
  // ОСТАВЛЯЕТ: под админским подключением ходят сиды, скрипты и `ops.ts`.
  expectVerdict(v, 'chosen=false usable=false admin=true');
}, 300_000);

test('вердикт по entities_aspects_gin: горячий запрос — членство в аспекте', async () => {
  const query = compileCountAst({ filter: { aspect: RARE_ASPECT } }, ctx());
  const v = await verdictFor(
    'entities_aspects_gin',
    query,
    `aspects @> ARRAY['${RARE_ASPECT}'] на ${GRAPH_ENTITIES} строках, ~50 совпадений`,
  );
  expectVerdict(v, 'chosen=false usable=false admin=true');
}, 300_000);

/**
 * ФОРМА ПРЕДИКАТА НОСИТЕЛЯ ПАМЯТИ (Задача 18, `src/memory/select.ts`) — здесь, а не в
 * юнит-сьюте селектора, и это переезд по ре-ревью, а не украшение.
 *
 * Проба жила в `src/memory/select.test.ts` и была зелёной навсегда: она снимала EXPLAIN под
 * АДМИН-соединением, дописав `owner_id = '…'` ОБЫЧНЫМ предикатом, — то есть имитировала RLS
 * тем, чем RLS не является. Под ролью приложения тот же отбор приходит security qual'ом
 * политики `owner_owns_row`, и вывод менялся на противоположный. Ровно та ловушка, о
 * которой предупреждает шапка этого файла.
 *
 * Три вопроса разведены, как и положено здесь:
 *  1. под ролью приложения обе формы дают ОДИН план и GIN не берут — значит выбор формы
 *     боевому пути не помогает и не мешает (селектор читается на каждое сообщение
 *     владельца, поэтому обещать ему ускорение было бы враньём);
 *  2. под админ-DSN GIN берёт ТОЛЬКО `@>` — у `элемент = ANY(массив)` индексируемого
 *     оператора нет вовсе. ПОТРЕБИТЕЛЯ у этого выигрыша сегодня НЕТ: `memoryEntitiesWhere`
 *     и `memoryRulesWhere` зовут ровно три места, и все три — под `withIdentity`; в
 *     `scripts/` строки `orbis/memory` нет вовсе. Форма выбрана по брифу и потому, что она
 *     не хуже, — тот же текст стоит в докблоке `memory/select.ts`, и разъезжаться им нельзя;
 *  3. причина недостижимости под ролью приложения — не селективность, а `proleakproof`;
 *     она пиннится отдельным тестом ниже.
 *
 * Предикат берётся ИЗ КОДА (`memoryEntitiesWhere`), а не переписывается сюда строкой:
 * проба о форме, списанной руками, переставала бы говорить о боевом запросе с первой же
 * правкой селектора.
 *
 * ПРЕДУПРЕЖДЕНИЕ ТОМУ, КТО УВИДИТ ЭТУ ПРОБУ КРАСНОЙ ПОСЛЕ ЧУЖОЙ МИГРАЦИИ.
 * 0017 `entities_aspects_gin` НЕ СНЯЛА (решение по замеру — см. шапку файла), поэтому
 * админская треть пробы (`admin: @>=true`) сегодня верна. Снимет его будущая миграция —
 * покраснеет она ПОБОЧНЫМ ЭФФЕКТОМ, а не регрессом формы предиката; лечение тогда — снять
 * третье утверждение вместе с индексом, а не «чинить» селектор: первые два (обе формы
 * одинаковы под ролью приложения) останутся верными и после снятия.
 */
test('форма предиката памяти: под ролью приложения обе равны, под админом GIN берёт только `@>`', async () => {
  const withContains = sql`SELECT count(*) FROM entities WHERE ${memoryEntitiesWhere()}`;
  const withAnyElement = sql`SELECT count(*) FROM entities WHERE NOT archived AND ${MEMORY_ASPECT} = ANY(aspects)`;

  const app = {
    contains: (await planOf(withContains, false)).includes('entities_aspects_gin'),
    anyElement: (await planOf(withAnyElement, false)).includes('entities_aspects_gin'),
  };
  const forced = {
    contains: (await planOf(withContains, true)).includes('entities_aspects_gin'),
    anyElement: (await planOf(withAnyElement, true)).includes('entities_aspects_gin'),
  };
  const admin = {
    contains: (await adminPlanOf(withContains)).includes('entities_aspects_gin'),
    anyElement: (await adminPlanOf(withAnyElement)).includes('entities_aspects_gin'),
  };
  console.log(
    `explain: предикат памяти — под ролью приложения @>=${app.contains} =ANY=${app.anyElement}` +
      ` (enable_seqscan=off: @>=${forced.contains} =ANY=${forced.anyElement});` +
      ` под админ-DSN @>=${admin.contains} =ANY=${admin.anyElement}`,
  );

  // 1. Боевой путь: форма не решает НИЧЕГО — обе одинаково не берут GIN.
  expect(`app: @>=${app.contains} =ANY=${app.anyElement}`).toBe('app: @>=false =ANY=false');
  // …и даже принудительно индекс под этой ролью недостижим (иначе «не выбран» читалось бы
  // как «планировщик посчитал невыгодным», а это другой диагноз).
  expect(`forced: @>=${forced.contains} =ANY=${forced.anyElement}`).toBe(
    'forced: @>=false =ANY=false',
  );
  // 2. Админ-DSN: вот здесь форма и решает — это и есть причина выбора `@>`.
  expect(`admin: @>=${admin.contains} =ANY=${admin.anyElement}`).toBe('admin: @>=true =ANY=false');
}, 300_000);

test('вердикт по entities_query_refs_gin: колонка заполнена, вердикт снят', async () => {
  // ДО Задачи 21b здесь стояло `expect(filled).toBe(0)` с объяснением «писателя ещё нет».
  // Писатель появился (21a завела `query_refs`, 21b — сиды и слияние), а утверждение
  // осталось бы зелёным навсегда: корпус объёма пишется прямым INSERT'ом с `queryRefs: []`
  // и живого писателя не зовёт вовсе. То есть вердикт снимался бы с ПУСТОЙ колонки — на
  // пустом индексе планировщик не выбирает ничего, и «не используется» означало бы
  // «нечего искать», а не «RLS не пускает». Файл вне `bun run test`, и покраснеть этому
  // было негде (класс дефекта 12 ветки).
  //
  // Поэтому колонка заполняется здесь — и ЗНАЧЕНИЕМ ИЗ БОЕВОГО ПРОИЗВОДИТЕЛЯ
  // (`queryRefsFromDoc` по привязанному документу), а не выдуманным массивом: индекс должен
  // мерить то, что кладёт продукт. Строки — те же RARE-узлы, что и у остальных вердиктов
  // (каждая RARE_EVERY-я), поэтому селективность сравнима.
  const parseReg = parseRegistryOfSnapshot(reg);
  const body = `{{query:aspect=${RARE_ASPECT}, ${RARE_PROPERTY}=${RARE_VALUE}}}`;
  const refs = queryRefsFromDoc(bindQueryBlocks(parseBody(body), parseReg));
  // Страховка осмысленности: производитель обязан вернуть НЕПУСТОЙ индекс — иначе
  // заполнение ниже записало бы `{}` и вердикт снова снимался бы с пустой колонки.
  expect(refs).toContain(RARE_PROPERTY);

  const { db: admin, client: adminClient } = adminDb();
  let filled = 0;
  try {
    // СБРОС ПЕРЕД ЗАМЕРОМ, а не «заполним, если пусто». Корпус кешируется между прогонами
    // (`ensureGraphFixture` сверяет только счётчики строк), и без сброса второй прогон
    // проходил бы на колонке, заполненной первым, — то есть проверка «колонка непуста»
    // зеленела бы и при снятом заполнении. Проверено мутацией: без этого сброса снятие
    // UPDATE ниже прогон не краснило.
    await admin.execute(sql`
      UPDATE entities SET query_refs = '{}'
       WHERE owner_id = ${GRAPH_OWNER_ID}::uuid AND query_refs <> '{}'`);
    const before = (await admin.execute(sql`
      SELECT count(*)::int AS n FROM entities
       WHERE owner_id = ${GRAPH_OWNER_ID}::uuid AND query_refs <> '{}'`)) as unknown as {
      n: number;
    }[];
    // Заодно утверждение о САМОМ КОРПУСЕ: он пишется прямым INSERT'ом и колонку не трогает.
    expect(before[0]?.n).toBe(0);

    await admin.execute(sql`
      UPDATE entities SET query_refs = ${sql.join(
        [
          sql`ARRAY[`,
          sql.join(
            refs.map((r) => sql`${r}`),
            sql`, `,
          ),
          sql`]::text[]`,
        ],
        sql``,
      )}
       WHERE owner_id = ${GRAPH_OWNER_ID}::uuid AND props ? ${RARE_PROPERTY}`);
    const after = (await admin.execute(sql`
      SELECT count(*)::int AS n FROM entities
       WHERE owner_id = ${GRAPH_OWNER_ID}::uuid AND query_refs <> '{}'`)) as unknown as {
      n: number;
    }[];
    filled = after[0]?.n ?? 0;
  } finally {
    await adminClient.end();
  }
  expect(filled).toBeGreaterThan(0);

  const query = sql`SELECT count(*) FROM entities e WHERE query_refs @> ARRAY[${RARE_PROPERTY}]::text[]`;
  const v = await verdictFor(
    'entities_query_refs_gin',
    query,
    `query_refs заполнены у ${filled} строк из ${GRAPH_ENTITIES}; ищется ${RARE_PROPERTY}`,
  );
  // Вердикт снят по НЕПУСТОЙ колонке (см. выше) и пинится целиком. Р-П-1: этот индекс изъят
  // из правила «нет подтверждения → снять» — 0017 его оставляет по тому же доводу, что и
  // два соседних.
  expectVerdict(v, 'chosen=false usable=false admin=true');
}, 300_000);

test('несущий индекс рекурсивного обхода: обход идёт ПО ИНДЕКСУ с префиксом source_id', async () => {
  /**
   * ЧТО ЗДЕСЬ ИНВАРИАНТ, А ЧТО — ДЕТАЛЬ ПЛАНА. Инвариант П6: рекурсивный обход идёт ПО
   * ИНДЕКСУ, а не seqscan'ом по `relations` (150 000 строк). Деталь плана: КАКОЙ из двух
   * индексов с префиксом `source_id` планировщик возьмёт — `relations_source_role`
   * (0016:84) или `rel_uniq` (0017, `(source_id, target_id, role)`).
   *
   * ПОЧЕМУ ИМЯ ПИНИТЬ НЕЛЬЗЯ — ЗАМЕРЕНО, а не выведено. После 0017 оба индекса обслуживают
   * и якорь, и рекурсивную часть: у обоих префикс `source_id` и условие по `role`, а у
   * `rel_uniq` вдобавок `target_id` лежит В ИНДЕКСЕ (Index Only Scan вместо похода в кучу).
   * Выбор идёт по цене и статистике после `ANALYZE` — то есть по состоянию машины и
   * момента. Прогоны на одном и том же коммите разошлись: у координатора план содержал ОБА
   * индекса (`relations_source_role: chosen=true`), у имплементера — только `rel_uniq`.
   * Пин имени сделал бы приёмку §С8-10 невоспроизводимой между машинами.
   *
   * Поэтому утверждается МНОЖЕСТВО: использован хотя бы один индекс из двух и никакой
   * другой. Уйди обход в seqscan — `used` пуст, тест краснеет, и порог П6 не поедет молча.
   *
   * Вердикт по `relations_source_role` при этом СНИМАЕТСЯ И ПЕЧАТАЕТСЯ (сводка ниже) — он
   * остаётся входом решения «нужен ли этот индекс», но решение принимается человеком по
   * нескольким прогонам, а не одним ассертом по одному. 0017 индекс НЕ снимает (Р-23b-9).
   */
  const WALK_INDEXES = ['relations_source_role', 'rel_uniq'] as const;
  const query = compileCountAst(
    {
      filter: {
        rel: {
          kind: 'descendants_of',
          via: 'subitem',
          of: '00000000-0000-7000-8000-0000000000f1',
        },
      },
    },
    ctx(),
  );
  await verdictFor(
    'relations_source_role',
    query,
    'рекурсивный обход вниз по (source_id, role); его же обслуживает rel_uniq — выбор за планировщиком',
  );

  const plan = await planOf(query, false);
  const used = WALK_INDEXES.filter((i) => plan.includes(i));
  console.log(`explain: обход использовал индексы — ${used.join(',') || 'НИ ОДНОГО'}`);
  // Хотя бы один из двух — то есть обход индексный. Пустой `used` означает seqscan.
  expect(`обход индексный: ${used.length > 0}`).toBe('обход индексный: true');
  // …и таблица связей НЕ ЧИТАЕТСЯ ЦЕЛИКОМ. Это отдельное утверждение, а не следствие
  // первого: план рекурсивного CTE состоит из якоря и рекурсивной части, и индексной может
  // оказаться одна из них, пока вторая идёт `Seq Scan on relations`. Тогда `used` непуст, а
  // порог П6 всё равно поехал.
  //
  // Утверждение написано ПРО ПЛАН, а не про `used`: `used` получен фильтром по тому же
  // плану и по построению не может содержать ничего вне `WALK_INDEXES` — проверять это
  // ассертом значило бы завести восьмую тавтологию в файле, который от трёх таких уже
  // избавился (см. докблок `expectVerdict`).
  expect(`seqscan по relations: ${plan.includes('Seq Scan on relations')}`).toBe(
    'seqscan по relations: false',
  );
}, 300_000);

test('ПРИЧИНА, а не только симптом: операторы containment не leakproof', async () => {
  // Это утверждение — проверяемое, и проверяется оно у самого Postgres, а не в комментарии.
  // Пока флаг `proleakproof` у этих трёх функций false, GIN под RLS индексным условием быть
  // не может; станет true (или изменится модель RLS) — тест покраснеет, и вердикты выше
  // придётся снимать заново.
  const rows = await withIdentity(db, GRAPH_OWNER_ID, async (tx) => [
    ...(await tx.execute(sql`
      SELECT proname, proleakproof FROM pg_proc
       WHERE oid IN ('jsonb_contains(jsonb,jsonb)'::regprocedure,
                     'arraycontains(anyarray,anyarray)'::regprocedure,
                     'jsonb_exists(jsonb,text)'::regprocedure)
       ORDER BY proname`)),
  ]);
  console.log('explain: leakproof-флаги операторов —', JSON.stringify(rows));
  expect(rows).toHaveLength(3);
  for (const r of rows) expect((r as { proleakproof: boolean }).proleakproof).toBe(false);
}, 300_000);

test('сводка вердиктов напечатана по всем четырём индексам; DROP-список 0017 им не пересекается', () => {
  expect(verdicts.map((v) => v.index).sort()).toEqual(
    [
      'entities_aspects_gin',
      'entities_props_gin',
      'entities_query_refs_gin',
      'relations_source_role',
    ].sort(),
  );
  // ПРИЁМКА «EXPLAIN против 0017»: миграция снимает ровно четыре индекса, и ни один из них
  // не тот, по которому здесь снят вердикт. Пересечение означало бы, что индекс сняли, не
  // спросив замер, — ровно та ошибка, ради которой этот файл и написан.
  expect(verdicts.map((v) => v.index).filter((i) => DROPPED_BY_0017.includes(i))).toEqual([]);
  expect(DROPPED_BY_0017).toHaveLength(4);
  console.log('explain: СВОДКА ДЛЯ МИГРАЦИИ 0017');
  for (const v of verdicts) {
    const verdict = v.chosen
      ? 'ОСТАВИТЬ — используется приложением'
      : v.usableWithoutRls
        ? 'приложением НЕ используется (RLS не пускает не-leakproof предикат); работает только под админ-DSN'
        : 'форма запроса индексом не покрывается ни под какой ролью';
    console.log(
      `  ${v.index}: chosen=${v.chosen} usable=${v.usable} admin=${v.usableWithoutRls} — ${verdict}`,
    );
  }
});
