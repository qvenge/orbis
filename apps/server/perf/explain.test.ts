// apps/server/perf/explain.test.ts
//
// ЗАМЕР ПЛАНОВ — вход миграции 0017 («Пересев мира», Задача 23). Три GIN'а, заведённые
// миграцией 0015 под новую форму хранения, обязаны доказать, что ими пользуются: тот, что
// не доказал, там же и снимается. Поэтому файл печатает ВЕРДИКТ по каждому индексу, а не
// просто «зелено».
//
// Гоняется отдельным скриптом `bun run test:perf:explain` — вне CI и вне `bun run test`
// (сев корпуса на 50 000 строк — 22…25 с; число печатает сам прогон строкой
// `explain: корпус …`, а засевает его та же фикстура, что и перф-гейт).
// Повторно гоняется в Задаче 23 как приёмка.
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
// чем звучало: под админом план не просто другой — он недостижим для приложения. Вердикт
// «снимать ли индекс» из этого НЕ следует автоматически: под админ-DSN ходят сиды, скрипты
// и `ops.ts`, и для них индексы работают. Решение — за владельцем спеки и Задачей 23.
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
  // Тест не утверждает, что индекс ДОЛЖЕН быть выбран, — он утверждает, что вердикт снят
  // и однозначен. Решение о снятии индекса принимает Задача 23 по этим двум флагам.
  expect(typeof v.chosen).toBe('boolean');
  expect(typeof v.usable).toBe('boolean');
}, 300_000);

test('вердикт по entities_aspects_gin: горячий запрос — членство в аспекте', async () => {
  const query = compileCountAst({ filter: { aspect: RARE_ASPECT } }, ctx());
  const v = await verdictFor(
    'entities_aspects_gin',
    query,
    `aspects @> ARRAY['${RARE_ASPECT}'] на ${GRAPH_ENTITIES} строках, ~50 совпадений`,
  );
  expect(typeof v.chosen).toBe('boolean');
  expect(typeof v.usable).toBe('boolean');
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
 * `entities_aspects_gin` — кандидат на СНЯТИЕ миграцией 0017 (Задача 23): вердикт этого же
 * файла по нему `chosen=false, usable=false, admin=true`, то есть приложением он не
 * используется. Когда его снимут, админская треть пробы (`admin: @>=true`) покраснеет
 * ПОБОЧНЫМ ЭФФЕКТОМ той миграции, а не регрессом формы предиката. Лечение тогда — снять
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
  // Как и у остальных вердиктов: тест не решает, снимать ли индекс, — он утверждает, что
  // вердикт снят по НЕПУСТОЙ колонке и однозначен. Решение — Задача 23.
  expect(typeof v.chosen).toBe('boolean');
  expect(typeof v.usable).toBe('boolean');
}, 300_000);

test('вердикт по (source_id, role): несущий индекс рекурсивного обхода', async () => {
  // Не GIN и не кандидат на снятие — но именно на нём стоит П6, и если обход перестанет
  // его брать, порог поедет молча вместе с планом.
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
  const v = await verdictFor(
    'relations_source_role',
    query,
    'рекурсивный обход вниз по (source_id, role)',
  );
  expect(v.usable).toBe(true);
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

test('сводка вердиктов напечатана по всем четырём индексам', () => {
  expect(verdicts.map((v) => v.index).sort()).toEqual(
    [
      'entities_aspects_gin',
      'entities_props_gin',
      'entities_query_refs_gin',
      'relations_source_role',
    ].sort(),
  );
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
