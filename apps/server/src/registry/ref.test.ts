// apps/server/src/registry/ref.test.ts
// Ссылочные kind'ы §А6 на живой базе: `ref` (проверка цели компиляцией множества
// `target`, зеркало-ребро роли `ref`, архивация цели), `registry_ref` (по таблице
// целевого реестра ∪ `CONTRACT_IDS_V1`) и `grant` (существующий инвариант назначения).
//
// Через `execute()`, а не вызовом `assertRefValue` напрямую: проверяется не функция, а
// РУБЕЖ — что путь записи в неё заходит на всех трёх точках (create, update, attach).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  newId,
} from '@orbis/shared';
import { assertStaticQuery, type QueryAst } from '@orbis/shared/query';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteRequest, ExecuteResult, WireEntity } from '../executor/types';
import { undoAction } from '../executor/undo';
import type { CompileCtx } from '../query/compile-ast';
import { effectiveRegistry } from './cache';
import type { RegistrySnapshot } from './load';
import { changedRefProps, refTargetMembershipSql, syncRefMirror } from './ref';

requireEnv();

const { db, client } = appDb();
const T0 = new Date('2026-08-27T09:00:00.000Z');

/** Снимок реестра из ВСТРОЕННЫХ словарей — тот же приём, что у `compile.golden.test.ts`. */
const GOLDEN_REG: RegistrySnapshot = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
  roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
  ownerVersion: 0,
  systemVersion: 1,
};

const GOLDEN_CTX: CompileCtx = {
  ownerId: '00000000-0000-7000-8000-0000000000a1',
  today: '2026-08-27',
  timeZone: 'Europe/Moscow',
  reg: GOLDEN_REG,
  thisEntityId: null,
};

function req(
  user: string,
  ops: Array<{ tool: string; input: unknown }>,
  over: Partial<ExecuteRequest> = {},
): ExecuteRequest {
  return {
    actorUserId: user,
    actorKind: 'owner',
    source: 'fast_path',
    operations: ops,
    clock: () => T0,
    ...over,
  };
}

function okEntity(r: ExecuteResult): WireEntity {
  if (!r.ok) throw new Error(`ожидался успех, получено ${JSON.stringify(r.error)}`);
  return r.results[0] as WireEntity;
}

function err(r: ExecuteResult): { code: string; message: string; details?: unknown } {
  if (r.ok) throw new Error('ожидался отказ, получен успех');
  return r.error;
}

/** Причина отказа из details — потребитель читает структуру, а не разбирает текст. */
function reasonOf(r: ExecuteResult): unknown {
  return (err(r).details as { reason?: unknown } | undefined)?.reason;
}

async function createCategory(user: string, title: string): Promise<string> {
  const e = okEntity(
    await execute(
      db,
      req(user, [
        { tool: 'entity_create', input: { title, tags: [], aspects: ['orbis/category'] } },
      ]),
    ),
  );
  return e.id;
}

/** Транзакция с категорией — новой формой (`props` по id свойства). */
async function createTxn(user: string, title: string, categoryId?: string): Promise<string> {
  const e = okEntity(
    await execute(
      db,
      req(user, [
        {
          tool: 'entity_create',
          input: {
            title,
            tags: [],
            aspects: ['orbis/financial'],
            props: {
              'orbis/amount': '340.00',
              'orbis/direction': 'expense',
              'orbis/occurred_on': '2026-08-20',
              ...(categoryId === undefined ? {} : { 'orbis/finance_category': categoryId }),
            },
          },
        },
      ]),
    ),
  );
  return e.id;
}

/** Зеркала-рёбра роли `ref` этой сущности: цель + свойство из `meta`. */
async function refEdges(
  user: string,
  entityId: string,
): Promise<Array<{ target: string; property: unknown }>> {
  return await withIdentity(db, user, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT target_id, meta->>'property' AS property
        FROM relations
       WHERE source_id = ${entityId}::uuid AND role = 'ref'
       ORDER BY target_id`)) as unknown as Array<{
      target_id: string;
      property: string | null;
    }>;
    return rows.map((r) => ({ target: r.target_id, property: r.property }));
  });
}

/** Сущности владельца с таким заголовком — проба «записи НЕ появилось». */
async function titledCount(user: string, title: string): Promise<number> {
  return await withIdentity(db, user, async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT count(*)::int AS n FROM entities WHERE title = ${title}`,
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  });
}

/** Значения свойств строки — правда сущности (§А1-1), а не её проекция. */
async function propsOf(user: string, entityId: string): Promise<Record<string, unknown>> {
  return await withIdentity(db, user, async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT props FROM entities WHERE id = ${entityId}::uuid`,
    )) as unknown as Array<{ props: Record<string, unknown> }>;
    const row = rows[0];
    if (row === undefined) throw new Error('сущность не найдена');
    return row.props;
  });
}

async function tagsOf(user: string, entityId: string): Promise<string[]> {
  return await withIdentity(db, user, async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT tags FROM entities WHERE id = ${entityId}::uuid`,
    )) as unknown as Array<{ tags: string[] }>;
    const row = rows[0];
    if (row === undefined) throw new Error('сущность не найдена');
    return row.tags;
  });
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

test('ref: множество цели компилируется тем же движком и соединяется по id с ::uuid', () => {
  // Эталон посчитан ВРУЧНУЮ по §6.1 и §А5-7, а не снят с прогона (та же дисциплина, что у
  // `compile.golden.test.ts`): `compileWhere` даёт `true` + умолчание архивности + скрытие
  // служебных аспектов + само дерево, а соединение по id добавляет эта функция.
  // Касты — предмет проверки: `aspects && ARRAY[…]::text[]` у служебных и `::uuid[]` у
  // списка целей. Без второго `e.id = ANY($1)` сравнивал бы uuid с text и падал бы ошибкой
  // оператора вместо честного «цель не в множестве».
  const def = BUILTIN_PROPERTY_META.find((p) => p.id === 'orbis/finance_category');
  if (def === undefined || def.type.kind !== 'ref') throw new Error('свойство-ссылка не найдено');
  const q = new PgDialect().sqlToQuery(
    refTargetMembershipSql(def.type, ['019e4466-aaaa-7e07-b5d4-64be9721da51'], GOLDEN_CTX),
  );
  expect(q.sql.replaceAll(/\s+/g, ' ').trim()).toBe(
    'SELECT e.id FROM entities e WHERE (' +
      "(true AND NOT archived AND NOT (aspects && ARRAY[$1]::text[]) AND aspects @> ARRAY['orbis/category'])" +
      ') AND e.id = ANY(ARRAY[$2]::uuid[])',
  );
  expect(q.params).toEqual(['orbis/agent-run', '019e4466-aaaa-7e07-b5d4-64be9721da51']);
});

test('ref: значение вне множества target — VALIDATION REF_TARGET «цель не в множестве target»', async () => {
  const user = freshUserId();
  const note = okEntity(
    await execute(
      db,
      req(user, [{ tool: 'entity_create', input: { title: 'Заметка', tags: [] } }]),
    ),
  );
  const category = await createCategory(user, 'Еда');

  // Заметка существует и видима владельцу, но множество цели — `aspect=orbis/category`
  const r = await execute(
    db,
    req(user, [
      {
        tool: 'entity_create',
        input: {
          title: 'Обед',
          tags: [],
          aspects: ['orbis/financial'],
          props: {
            'orbis/amount': '340.00',
            'orbis/direction': 'expense',
            'orbis/occurred_on': '2026-08-20',
            'orbis/finance_category': note.id,
          },
        },
      },
    ]),
  );
  expect(err(r).code).toBe('VALIDATION');
  expect(reasonOf(r)).toBe('REF_TARGET');
  expect(err(r).message).toContain('цель не в множестве target');
  // ОТКАТ ПОЛОН: проверка целей стоит ПОСЛЕ стадии 5, то есть строка успевает лечь в tx —
  // и обязана уйти вместе с ней. Без этого утверждения рефактор, уносящий `applyRefEffects`
  // за транзакцию (прецедент в дереве есть — `maybeSuggestRule` работает пост-коммитно), не
  // окрасил бы ни одного теста, а отказанные записи начали бы персистить.
  expect(await titledCount(user, 'Обед')).toBe(0);

  // Несуществующая (и чужая — RLS их не различает) цель называется своей причиной
  const missing = await execute(
    db,
    req(user, [
      {
        tool: 'entity_create',
        input: {
          title: 'Обед 2',
          tags: [],
          aspects: ['orbis/financial'],
          props: {
            'orbis/amount': '1.00',
            'orbis/direction': 'expense',
            'orbis/occurred_on': '2026-08-20',
            'orbis/finance_category': newId(),
          },
        },
      },
    ]),
  );
  expect(err(missing).message).toContain('не найдена');

  // Та же запись с ЗАКОННОЙ целью проходит — отказ выше про цель, а не про форму записи
  const good = await createTxn(user, 'Обед 3', category);
  expect(good).toBeTruthy();
});

test('ref: установка/смена/снятие создаёт/переносит/удаляет ребро role=ref с meta.property; ребро пересоздаётся при расхождении', async () => {
  const user = freshUserId();
  const food = await createCategory(user, 'Еда');
  const fun = await createCategory(user, 'Развлечения');

  // Установка
  const txn = await createTxn(user, 'Обед', food);
  expect(await refEdges(user, txn)).toEqual([{ target: food, property: 'orbis/finance_category' }]);

  // Смена — ребро ПЕРЕНОСИТСЯ, а не добавляется вторым
  const moved = await execute(
    db,
    req(user, [
      { tool: 'entity_update', input: { id: txn, props: { 'orbis/finance_category': fun } } },
    ]),
  );
  expect(moved.ok).toBe(true);
  expect(await refEdges(user, txn)).toEqual([{ target: fun, property: 'orbis/finance_category' }]);

  // Расхождение: ребро есть, значения нет — истина СВОЙСТВО, ребро пересоздаётся.
  // Подмена делается админским подключением, то есть МИМО исполнителя: иначе проверка
  // жила бы внутри того же кода, который проверяется.
  const { db: admin, client: adminClient } = adminDb();
  try {
    await admin.execute(sql`
      UPDATE relations SET target_id = ${food}::uuid
       WHERE source_id = ${txn}::uuid AND role = 'ref'`);
  } finally {
    await adminClient.end();
  }
  expect(await refEdges(user, txn)).toEqual([{ target: food, property: 'orbis/finance_category' }]);
  // Правка ТЕМ ЖЕ значением (свойство не меняется) обязана вернуть ребро к правде
  const resync = await execute(
    db,
    req(user, [
      { tool: 'entity_update', input: { id: txn, props: { 'orbis/finance_category': fun } } },
    ]),
  );
  expect(resync.ok).toBe(true);
  expect(await refEdges(user, txn)).toEqual([{ target: fun, property: 'orbis/finance_category' }]);

  // Снятие — ребра не остаётся. Проверяется на `orbis/rule_target`, а не на
  // `orbis/finance_category`: у транзакции категория ОБЯЗАТЕЛЬНА (`orbis/financial`
  // объявляет её required), и снятие там отвергает валидатор реестра раньше зеркала.
  const rule = okEntity(
    await execute(
      db,
      req(user, [
        {
          tool: 'entity_create',
          input: {
            title: 'пятёрочка → Еда',
            tags: [],
            aspects: ['orbis/memory'],
            // Образец обязателен у любого правила (В7, fail-closed): предмет проверки
            // здесь — зеркало ссылки, а не форма правила, поэтому он просто заполнен.
            props: {
              'orbis/memory_kind': 'rule',
              'orbis/rule_pattern': 'пятерочка',
              'orbis/rule_target': food,
            },
          },
        },
      ]),
    ),
  );
  expect(await refEdges(user, rule.id)).toEqual([{ target: food, property: 'orbis/rule_target' }]);
  const unset = await execute(
    db,
    req(user, [{ tool: 'entity_update', input: { id: rule.id, unset: ['orbis/rule_target'] } }]),
  );
  expect(unset.ok).toBe(true);
  expect(await refEdges(user, rule.id)).toEqual([]);
});

test('ref: архивация цели помечает источники needs-review; повторная установка той же категории — отказ', async () => {
  const user = freshUserId();
  const food = await createCategory(user, 'Еда');
  const one = await createTxn(user, 'Обед', food);
  const two = await createTxn(user, 'Ужин', food);
  expect(await tagsOf(user, one)).toEqual([]);

  const archived = await execute(
    db,
    req(user, [{ tool: 'entity_update', input: { id: food, archived: true } }]),
  );
  expect(archived.ok).toBe(true);
  expect(await tagsOf(user, one)).toEqual(['needs-review']);
  expect(await tagsOf(user, two)).toEqual(['needs-review']);

  // Повторная архивация тега не плодит — ни та же цель, ни ВТОРАЯ цель того же источника.
  // Вторая цель важнее первой: у первой пометку не повторяет уже сам исполнитель («стала
  // архивной», а не «архивна»), и без второй проверка идемпотентности самого UPDATE'а
  // исчезала бы вместе с этим гейтом.
  const again = await execute(
    db,
    req(user, [{ tool: 'entity_update', input: { id: food, archived: true } }]),
  );
  expect(again.ok).toBe(true);
  expect(await tagsOf(user, one)).toEqual(['needs-review']);

  const rules = await createCategory(user, 'Правила');
  const tagged = await execute(
    db,
    req(user, [
      { tool: 'entity_update', input: { id: one, props: { 'orbis/rule_target': rules } } },
    ]),
  );
  expect(tagged.ok).toBe(true);
  const second = await execute(
    db,
    req(user, [{ tool: 'entity_update', input: { id: rules, archived: true } }]),
  );
  expect(second.ok).toBe(true);
  expect(await tagsOf(user, one)).toEqual(['needs-review']);

  // Архивная цель выпала из множества target — пере-установка того же значения отказ
  const three = await execute(
    db,
    req(user, [
      {
        tool: 'entity_update',
        input: { id: two, props: { 'orbis/finance_category': food } },
      },
    ]),
  );
  expect(err(three).code).toBe('VALIDATION');
  expect(reasonOf(three)).toBe('REF_TARGET');
  expect(err(three).message).toContain('цель архивна');

  // …но САМА запись-источник не заморожена: ссылка остаётся, правка соседнего поля идёт
  const rename = await execute(
    db,
    req(user, [{ tool: 'entity_update', input: { id: two, title: 'Ужин поздний' } }]),
  );
  expect(rename.ok).toBe(true);
  expect(await refEdges(user, two)).toEqual([{ target: food, property: 'orbis/finance_category' }]);
  // ЗАГОЛОВОК ПРАВКИ ТОЖЕ ОТКАЧЕН, и это половина границы: без ДРУГОЙ, законной цели
  // рядом «откатилось» неотличимо от «и так не менялось» — на успехе значение стало бы
  // `spare`, и утверждение о `food` покраснело бы.
  const spare = await createCategory(user, 'Досуг');
  const swapped = await execute(
    db,
    req(user, [
      {
        tool: 'entity_update',
        input: {
          id: two,
          title: 'Ужин переименованный',
          props: { 'orbis/finance_category': food },
        },
      },
    ]),
  );
  expect(reasonOf(swapped)).toBe('REF_TARGET');
  expect((await propsOf(user, two))['orbis/finance_category']).toBe(food);
  expect(await titledCount(user, 'Ужин переименованный')).toBe(0);
  expect(await refEdges(user, two)).toEqual([{ target: food, property: 'orbis/finance_category' }]);
  const legal = await execute(
    db,
    req(user, [
      { tool: 'entity_update', input: { id: two, props: { 'orbis/finance_category': spare } } },
    ]),
  );
  expect(legal.ok).toBe(true);
  expect((await propsOf(user, two))['orbis/finance_category']).toBe(spare);
});

test('ref/registry_ref: run_routine принимает только рутину; rule_scope — контракт из CONTRACT_IDS_V1', async () => {
  const user = freshUserId();
  const note = okEntity(
    await execute(
      db,
      req(user, [{ tool: 'entity_create', input: { title: 'Не рутина', tags: [] } }]),
    ),
  );
  // Свойства прогона — system_writable (§А2-5), поэтому механизм записи `verb`. Аспект
  // прогона намеренно НЕ навешивается: он требует ещё пять служебных свойств, а предмет
  // проверки — цель ссылки, а не полнота аспекта (свойство живёт и без носителя, §А1-1).
  const run = await execute(
    db,
    req(
      user,
      [
        {
          tool: 'entity_create',
          input: { title: 'Прогон', tags: [], props: { 'orbis/run_routine': note.id } },
        },
      ],
      { mechanism: 'verb', source: 'system' },
    ),
  );
  expect(err(run).code).toBe('VALIDATION');
  expect(reasonOf(run)).toBe('REF_TARGET');
  expect(err(run).message).toContain('цель не в множестве target');

  // registry_ref{target: contract}: шим интервала А→Б-1 (РП-6)
  const category = await createCategory(user, 'Продукты');
  const okScope = await execute(
    db,
    req(user, [
      {
        tool: 'entity_create',
        input: {
          title: 'пятёрочка → Продукты',
          tags: [],
          aspects: ['orbis/memory'],
          props: {
            'orbis/memory_kind': 'rule',
            'orbis/rule_scope': 'orbis/money-movement',
            'orbis/rule_pattern': 'пятерочка',
            'orbis/rule_target': category,
          },
        },
      },
    ]),
  );
  expect(okScope.ok).toBe(true);

  const badScope = await execute(
    db,
    req(user, [
      {
        tool: 'entity_create',
        input: {
          title: 'мусор → Продукты',
          tags: [],
          aspects: ['orbis/memory'],
          // Образец заполнен НАМЕРЕННО: без него стадия 2 ответила бы раньше
          // (RULE_WITHOUT_PATTERN), и проба перестала бы проверять валидатор ссылок.
          props: {
            'orbis/memory_kind': 'rule',
            'orbis/rule_scope': 'orbis/nope',
            'orbis/rule_pattern': 'мусор',
          },
        },
      },
    ]),
  );
  expect(err(badScope).code).toBe('VALIDATION');
  expect(reasonOf(badScope)).toBe('REF_TARGET');
  expect(err(badScope).message).toContain('не найдена');
});

test('ref: batch «заведи категорию и положи в неё трату» проходит — цель ищется по ИТОГОВОМУ состоянию tx', async () => {
  const user = freshUserId();
  const categoryId = newId();
  const r = await execute(
    db,
    req(
      user,
      [
        {
          tool: 'entity_create',
          input: {
            id: categoryId,
            title: 'Транспорт',
            tags: [],
            aspects: ['orbis/category'],
          },
        },
        {
          tool: 'entity_create',
          input: {
            title: 'Такси',
            tags: [],
            aspects: ['orbis/financial'],
            props: {
              'orbis/amount': '420.00',
              'orbis/direction': 'expense',
              'orbis/occurred_on': '2026-08-21',
              'orbis/finance_category': categoryId,
            },
          },
        },
      ],
      { batchId: newId() },
    ),
  );
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const txn = (r.results[1] as WireEntity).id;
  expect(await refEdges(user, txn)).toEqual([
    { target: categoryId, property: 'orbis/finance_category' },
  ]);
});

test('ref: два ссылочных свойства на одну цель — одно ребро, а не отказ (rel_uniq до 0017)', async () => {
  const user = freshUserId();
  const food = await createCategory(user, 'Еда');
  // `orbis/rule_target` и `orbis/finance_category` — оба ref в категорию; на одной записи
  // они дают одну пару (источник, цель), а `rel_uniq` до 0017 вмещает её один раз.
  const both = await execute(
    db,
    req(user, [
      {
        tool: 'entity_create',
        input: {
          title: 'пятёрочка → Еда',
          tags: [],
          props: { 'orbis/rule_target': food, 'orbis/finance_category': food },
        },
      },
    ]),
  );
  if (!both.ok) throw new Error(JSON.stringify(both.error));
  const source = (both.results[0] as WireEntity).id;
  const edges = await refEdges(user, source);
  expect(edges).toHaveLength(1);
  expect(edges[0]?.target).toBe(food);

  // ГЛАВНОЕ: снятие ОДНОЙ из двух ссылок не должно уносить общее ребро — вторая жива, и её
  // источник обязан остаться видимым для §А6-3. Ребро пересобирается с подписью выжившего
  // свойства (находка Important-1 гейт-ревью: раньше здесь оставался ноль рёбер).
  const dropped = await execute(
    db,
    req(user, [{ tool: 'entity_update', input: { id: source, unset: ['orbis/rule_target'] } }]),
  );
  expect(dropped.ok).toBe(true);
  expect(await refEdges(user, source)).toEqual([
    { target: food, property: 'orbis/finance_category' },
  ]);

  // …и пометка при архивации цели до источника доходит — то, что терялось вместе с ребром
  const archived = await execute(
    db,
    req(user, [{ tool: 'entity_update', input: { id: food, archived: true } }]),
  );
  expect(archived.ok).toBe(true);
  expect(await tagsOf(user, source)).toEqual(['needs-review']);
});

test('ref: undo правки категории возвращает и свойство, и зеркало-ребро', async () => {
  const user = freshUserId();
  const sink = makeChatJournalSink();
  const food = await createCategory(user, 'Еда');
  const fun = await createCategory(user, 'Развлечения');
  const txn = await createTxn(user, 'Обед', food);
  // Ребро от СОЗДАНИЯ ставится тем же движком — иначе откат ниже нечего было бы возвращать
  expect(await refEdges(user, txn)).toEqual([{ target: food, property: 'orbis/finance_category' }]);

  const moved = await execute(
    db,
    req(user, [
      { tool: 'entity_update', input: { id: txn, props: { 'orbis/finance_category': fun } } },
    ]),
    { sink },
  );
  if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  expect(await refEdges(user, txn)).toEqual([{ target: fun, property: 'orbis/finance_category' }]);

  const undone = await undoAction(db, { actorUserId: user, actionId: moved.actionId });
  expect(undone.ok).toBe(true);
  // Единица отката — СВОЙСТВО (§А7-4); ребро производно и сходится за ним само
  const back = okEntity(
    await execute(db, req(user, [{ tool: 'entity_update', input: { id: txn, title: 'Обед' } }])),
  );
  expect(back.props['orbis/finance_category']).toBe(food);
  expect(await refEdges(user, txn)).toEqual([{ target: food, property: 'orbis/finance_category' }]);
});

test('ref: undo архивации цели снимает needs-review — и только у тех, кого пометила эта операция (Р-11-1)', async () => {
  const user = freshUserId();
  const sink = makeChatJournalSink();
  const food = await createCategory(user, 'Еда');
  const fun = await createCategory(user, 'Развлечения');
  const onlyFood = await createTxn(user, 'Обед', food);
  // Второй источник ссылается на ОБЕ категории: `finance_category` и `rule_target` — цели
  // разные, значит и рёбра разные, и пометки приходят порознь.
  const both = await createTxn(user, 'Ужин', food);
  const linked = await execute(
    db,
    req(user, [
      { tool: 'entity_update', input: { id: both, props: { 'orbis/rule_target': fun } } },
    ]),
    { sink },
  );
  expect(linked.ok).toBe(true);

  // ПОРЯДОК АРХИВАЦИЙ ВАЖЕН: «Еда» первой — тогда ОБА источника попадают в её список
  // помеченных; «Развлечения» второй — «Ужин» уже помечен, и в ЕЁ список не попадает.
  const archiveFood = await execute(
    db,
    req(user, [{ tool: 'entity_update', input: { id: food, archived: true } }]),
    { sink },
  );
  if (!archiveFood.ok) throw new Error(JSON.stringify(archiveFood.error));
  const archiveFun = await execute(
    db,
    req(user, [{ tool: 'entity_update', input: { id: fun, archived: true } }]),
    { sink },
  );
  if (!archiveFun.ok) throw new Error(JSON.stringify(archiveFun.error));
  expect(await tagsOf(user, onlyFood)).toEqual(['needs-review']);
  expect(await tagsOf(user, both)).toEqual(['needs-review']);

  const undone = await undoAction(db, { actorUserId: user, actionId: archiveFood.actionId });
  expect(undone.ok).toBe(true);
  // У «Обеда» архивных целей не осталось — тег снят.
  expect(await tagsOf(user, onlyFood)).toEqual([]);
  // У «Ужина» ОСТАЛАСЬ ссылка на архивные «Развлечения»: он в списке помеченных этой
  // операцией, но снимать у него нечего — иначе откат одной архивации стирал бы след другой.
  expect(await tagsOf(user, both)).toEqual(['needs-review']);

  // НАЗВАННЫЙ ОСТАТОК рулинга Р-11-1: снимаем только у тех, кому пометили ЭТОЙ операцией, —
  // «Ужин» во второй список не попал (был уже помечен), и её откат тега не снимет. Тег
  // остаётся консервативным следом «требует разбора»; правило выбрано так намеренно, чтобы
  // откат не стирал пометку, поставленную человеком руками.
  const undoneToo = await undoAction(db, { actorUserId: user, actionId: archiveFun.actionId });
  expect(undoneToo.ok).toBe(true);
  expect(await tagsOf(user, both)).toEqual(['needs-review']);
});

/** Встроенные `ref`-свойства с объявленным множеством цели: (id, один вариант `target`). */
function builtinRefTargets(): Array<[string, QueryAst]> {
  const out: Array<[string, QueryAst]> = [];
  for (const def of BUILTIN_PROPERTY_META) {
    if (def.type.kind !== 'ref' || def.type.target === undefined) continue;
    const targets = Array.isArray(def.type.target) ? def.type.target : [def.type.target];
    for (const ast of targets) out.push([def.id, ast]);
  }
  return out;
}

test('ref: каждый объявленный встроенный target статичен — гейт §А6-1 выполним по построению словаря', () => {
  // Обязательство докблока `compileCtxOf` («today/timeZone множеством цели не читаются»)
  // стоит на статичности `ref.target`. Боевой гейт при записи ОПРЕДЕЛЕНИЯ ставит Задача 15;
  // до неё встроенный словарь — единственное, что можно проверить, и он проверяется.
  //
  // Проверяются РОВНО те, у кого `target` объявлен: `target: undefined` — законная форма
  // (`targetsOf` читает её как «ограничения нет, остаётся существование под RLS»), и падать
  // на ней тестом ПРО СТАТИЧНОСТЬ значило бы уводить разбирающегося не туда. Сколько их
  // сегодня — отдельное утверждение ниже, со своей причиной в имени.
  const targets = builtinRefTargets();
  expect(targets.length).toBeGreaterThanOrEqual(4);
  for (const [propertyId, ast] of targets) {
    try {
      assertStaticQuery(ast);
    } catch (e) {
      throw new Error(`target свойства «${propertyId}» не статичен: ${String(e)}`);
    }
  }
});

test('ref: перечень — у всех встроенных ref-свойств сегодня объявлен target (не правило, а состав словаря)', () => {
  // Это ПЕРЕЧЕНЬ, а не запрет: свойство без `target` законно, и его появление обязано
  // покраснеть здесь — с внятным сообщением «вот кто без цели», — а не в пробе статичности.
  const withoutTarget = BUILTIN_PROPERTY_META.filter(
    (p) => p.type.kind === 'ref' && p.type.target === undefined,
  ).map((p) => p.id);
  expect(withoutTarget).toEqual([]);
});

/**
 * Запись ПОД ПРОЕКТОМ со ссылкой на категорию: правило `nearest_ancestor` проставляет ей
 * вычисляемые `orbis/parent_project`/`orbis/root_project`, то есть ссылочные свойства,
 * которых владелец не писал. Ровно эта обстановка нужна обеим пробам Р-11-2.
 */
async function txnUnderProject(
  user: string,
): Promise<{ project: string; txn: string; category: string }> {
  const category = await createCategory(user, 'Еда');
  const project = okEntity(
    await execute(
      db,
      req(user, [
        {
          tool: 'entity_create',
          input: {
            title: 'Проект',
            tags: [],
            props: { 'orbis/project_stage': 'active' },
            aspects: ['orbis/project'],
          },
        },
      ]),
    ),
  ).id;
  const txn = await createTxn(user, 'Обед', category);
  const linked = await execute(
    db,
    req(user, [
      { tool: 'relation_create', input: { source_id: project, target_id: txn, role: 'subitem' } },
    ]),
  );
  expect(linked.ok).toBe(true);
  // Обстановка ЗАШЛА в проверяемый путь: вычисляемые ссылки на проект действительно
  // проставлены — без этого обе пробы ниже зеленели бы на пустом месте.
  const computed = await propsOf(user, txn);
  expect(computed['orbis/parent_project']).toBe(project);
  expect(computed['orbis/root_project']).toBe(project);
  return { project, txn, category };
}

test('ref: правка категории у записи под проектом не вешает ребро на проект, и архивация проекта её не метит (Р-11-2)', async () => {
  const user = freshUserId();
  const { project, txn } = await txnUnderProject(user);
  const second = await createCategory(user, 'Развлечения');

  // Рядовая операция финансов: смена категории. Она — единственная правка ссылки, и втянуть
  // за собой вычисляемые соседние ссылки не должна.
  const recategorized = await execute(
    db,
    req(user, [
      { tool: 'entity_update', input: { id: txn, props: { 'orbis/finance_category': second } } },
    ]),
  );
  expect(recategorized.ok).toBe(true);
  expect(await refEdges(user, txn)).toEqual([
    { target: second, property: 'orbis/finance_category' },
  ]);

  // §А6-3 срабатывает на ссылку ВЛАДЕЛЬЦА, а не на кэш иерархии: архивация проекта тегов не
  // ставит, архивация категории — ставит.
  const archivedProject = await execute(
    db,
    req(user, [{ tool: 'entity_update', input: { id: project, archived: true } }]),
  );
  expect(archivedProject.ok).toBe(true);
  expect(await tagsOf(user, txn)).toEqual([]);

  const archivedCategory = await execute(
    db,
    req(user, [{ tool: 'entity_update', input: { id: second, archived: true } }]),
  );
  expect(archivedCategory.ok).toBe(true);
  expect(await tagsOf(user, txn)).toEqual(['needs-review']);
});

test('ref: конец-ПРОИЗВОДИТЕЛЬ Р-11-2 — changedRefProps не отдаёт вычисляемые ссылки', () => {
  // Проба чистая (без БД) и целится в ОДИН конец правила: сквозной тест выше её не заменяет
  // — там сработал бы и гейт писателя, и по красноте было бы не понять, который из двух.
  const project = '019e4466-dddd-7e07-b5d4-64be9721da51';
  const category = '019e4466-eeee-7e07-b5d4-64be9721da51';
  const before = { 'orbis/parent_project': project, 'orbis/root_project': project };
  const after = { ...before, 'orbis/finance_category': category };
  const changed = changedRefProps(GOLDEN_REG, before, after, new Set(['orbis/finance_category']));
  expect(changed).toEqual([{ propertyId: 'orbis/finance_category', after: category }]);
});

test('ref: конец-ПИСАТЕЛЬ Р-11-2 — syncRefMirror вычисляемое свойство не отражает даже по прямому списку', async () => {
  // Через исполнитель вычисляемое свойство до писателя не доходит (список отбирает
  // `changedRefProps`), поэтому список тут рукописный. Гейт писателя недостижим боевым
  // путём СЕГОДНЯ, но он связывает будущего производителя списка (правило `mirror_relation`
  // строкой реестра, часть Б) — и без этой пробы был бы украшением.
  const user = freshUserId();
  const { project, txn, category } = await txnUnderProject(user);
  await withIdentity(db, user, async (tx) => {
    const reg = await effectiveRegistry(tx, user);
    await syncRefMirror(tx, user, txn, [{ propertyId: 'orbis/root_project', after: project }], reg);
  });
  expect(await refEdges(user, txn)).toEqual([
    { target: category, property: 'orbis/finance_category' },
  ]);
});
