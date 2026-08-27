// apps/server/src/test/graph-fixture.ts
// Корпус объёма для перф-гейта П6 и для замера планов (`perf/graph.test.ts`,
// `perf/explain.test.ts`): 50 000 сущностей и ~150 000 рёбер — иерархия `subitem` глубиной 8
// плюс упоминания (см. докблок `PARENTS_PER_NODE` о том, почему иерархия именно дерево).
// Не тест сам по себе — библиотека для двух perf-сьютов (bun test берёт только *.test.ts).
//
// ПРЯМОЙ INSERT ПОД АДМИН-DSN — НАЗВАННОЕ ИСКЛЮЧЕНИЕ из правила «мутации только через
// executor», ровно того же рода, что у `src/test/perf.ts`, но по другой причине.
// В `perf.ts` исполнитель НУЖЕН: там мерятся операции, у которых стоимость делают его
// хуки (привязка транзакции к конверту, body_refs). Здесь мерится ОБХОД ГРАФА, и
// исполнитель к его стоимости не добавляет ничего, зато 50 000 сущностей через
// `entity_create` — это 50 000 строк журнала, 50 000 версий и десятки минут сева на каждый
// прогон. Корпус при этом заведомо синтетический: он не изображает данные владельца, он
// изображает ОБЪЁМ.
//
// КОРПУС КЕШИРУЕТСЯ. Владелец детерминирован (uuid v5 от фиксированного имени), и повторный
// вызов пересчитывает только счётчики строк: совпали — сев пропускается. Любой `truncateAll`
// соседнего сьюта корпус сносит, и следующий прогон засеет его заново — это норма, а не
// поломка: perf-сьюты живут вне CI и вне общего `bun run test` (находки 38/51).
import { ORBIS_NAMESPACE } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { adminDb } from '../../test/helpers';
import { entities, relations } from '../db/schema';

/** Владелец корпуса — один и тот же между прогонами, иначе кеш не имел бы смысла. */
export const GRAPH_OWNER_ID = uuidv5('graph-perf-fixture:owner', ORBIS_NAMESPACE);

/**
 * Размеры уровней иерархии: девять уровней (0…8) — ровно глубина 8. Числа подобраны так,
 * чтобы сумма дала 50 000, а ветвление осталось правдоподобным (десятки проектов сверху,
 * тысячи листьев снизу), а не «дерево-метёлка», на котором обход не показателен.
 */
const LEVEL_SIZES = [1, 10, 100, 500, 2000, 6000, 12000, 15000, 14389] as const;
export const GRAPH_ENTITIES = LEVEL_SIZES.reduce((a, b) => a + b, 0);

/**
 * ИЕРАРХИЯ — ДЕРЕВО (один родитель на узел), и это НЕ упрощение ради зелёного гейта, а
 * вывод из замера. Первая редакция корпуса давала узлу ТРИ родителя `subitem` (реестр это
 * разрешает: у роли нет ни `target_max_incoming`, ни `acyclic`), и рёбер выходило ровно
 * 150 000. На таком графе замер показал следующее (медианы, 2026-08-27, локальный Supabase,
 * Apple Silicon):
 *
 *   поддерево 92 узла   — descendants_of 9 мс,   recomputeProjectAncestors   0,77 с
 *   поддерево 847 узлов — descendants_of 24 мс,  recomputeProjectAncestors   7,1 с
 *   поддерево 10 191    — descendants_of 177 мс, recomputeProjectAncestors  92,1 с
 *
 * Вниз обход дешёв (нисходящая половина того же CTE на 10 191 узле — 101 мс); всю стоимость
 * делает ВОСХОДЯЩАЯ половина `recomputeProjectAncestors`: она идёт вверх ОТ КАЖДОГО узла
 * поддерева, и при нескольких родителях число пар «(узел, предок, глубина)» растёт как
 * произведение, а не как сумма. Это находка о ДВИЖКЕ ПРЕДКОВ (Задача 7b), а не о запросах,
 * и держать её внутри перф-гейта запросов значило бы смешать два разных вердикта.
 *
 * Поэтому корпус гейта — легальный граф ОБЫЧНОЙ формы: `subitem`-дерево плюс сто тысяч
 * рёбер `mention` (самая многочисленная роль живого графа), то есть та же нагрузка на
 * таблицу `relations` и на выбор по роли, но без ромбов в иерархии.
 *
 * На этом корпусе ОБА порога П6 берутся: обход вниз — медиана 71 мс при пороге 100, пересчёт
 * предков — 0,43…0,60 с при пороге 1 с. Второй, впрочем, взялся не сам: на ромбах он
 * упирался в ту же беду, что и на дереве, только сильнее, и лечится она в движке предков
 * (`executor/ancestors.ts`, CTE `picked` — там числа и разбор). Ромбы причину усиливали, но
 * не создавали.
 */
const PARENTS_PER_NODE = 1;

/** Рёбер `mention` на узел — ими корпус добирает объём таблицы связей до ~150 000. */
const MENTIONS_PER_NODE = 2;
/** Смещения цели упоминания: разные и не кратные размеру корпуса — пары не повторяются. */
const MENTION_OFFSETS = [1, 7] as const;

/** Строк в одном INSERT: компромисс «мало round-trip'ов» ↔ «пакет не разрастается». */
const BATCH = 2000;

/** Каждая N-я сущность получает редкое списочное свойство — вход замера GIN по `props`. */
const RARE_EVERY = 1000;

/** Аспект, редкий по построению: на нём меряется план `aspects @> ARRAY[…]`. */
export const RARE_ASPECT = 'orbis/category';
/** Свойство-список, редкое по построению: на нём меряется план `props @> …`. */
export const RARE_PROPERTY = 'orbis/aliases';
/** Значение, которое ищет горячий запрос замера планов. */
export const RARE_VALUE = 'такси';

/** id узла уровня `level` под номером `index` — детерминирован, как и весь корпус. */
export function graphNodeId(level: number, index: number): string {
  return uuidv5(`graph-perf-fixture:${level}:${index}`, ORBIS_NAMESPACE);
}

/** Сколько узлов на уровне (для тестов, выбирающих корень обхода). */
export function graphLevelSize(level: number): number {
  return LEVEL_SIZES[level] ?? 0;
}

export const GRAPH_DEPTH = LEVEL_SIZES.length - 1;

/** Рёбер иерархии — считается по той же формуле, что и сев, а не пишется числом руками. */
export const GRAPH_HIERARCHY_EDGES = LEVEL_SIZES.reduce(
  (total, size, level) =>
    level === 0
      ? total
      : total + size * Math.min(PARENTS_PER_NODE, LEVEL_SIZES[level - 1] as number),
  0,
);

/** Всего рёбер в корпусе: иерархия плюс упоминания. */
export const GRAPH_RELATIONS = GRAPH_HIERARCHY_EDGES + GRAPH_ENTITIES * MENTIONS_PER_NODE;

const TASK_STATUSES = ['inbox', 'planned', 'in_progress', 'waiting', 'done'] as const;

function entityRow(level: number, index: number): typeof entities.$inferInsert {
  const flat = level * 100000 + index;
  const rare = flat % RARE_EVERY === 0;
  const props: Record<string, unknown> = {
    'orbis/task_status': TASK_STATUSES[flat % TASK_STATUSES.length] as string,
    'orbis/due_date': `2026-${String(1 + (flat % 12)).padStart(2, '0')}-${String(1 + (flat % 28)).padStart(2, '0')}`,
  };
  const aspects = ['orbis/task'];
  if (rare) {
    props[RARE_PROPERTY] = [RARE_VALUE, `алиас-${flat}`];
    aspects.push(RARE_ASPECT);
  }
  // Проект — на верхних двух уровнях: правило `nearest_ancestor` обязано что-то находить,
  // иначе замер `recomputeProjectAncestors` мерил бы пустой обход.
  if (level <= 1) aspects.push('orbis/project');
  return {
    id: graphNodeId(level, index),
    ownerId: GRAPH_OWNER_ID,
    title: `Узел ${level}.${index}`,
    body: '',
    tags: [],
    props,
    aspects,
    queryRefs: [],
    aspectsLegacy: {},
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  };
}

/**
 * Родители узла: `PARENTS_PER_NODE` РАЗНЫХ узлов предыдущего уровня. Формула
 * `(index * PARENTS_PER_NODE + k) % prevSize` даёт подряд идущие остатки, то есть разные
 * значения, пока уровень выше не меньше числа родителей, — и `min` ниже это учитывает.
 */
function parentsOf(level: number, index: number): number[] {
  const prevSize = LEVEL_SIZES[level - 1] as number;
  const count = Math.min(PARENTS_PER_NODE, prevSize);
  return Array.from({ length: count }, (_, k) => (index * PARENTS_PER_NODE + k) % prevSize);
}

async function countRows(
  db: ReturnType<typeof adminDb>['db'],
): Promise<{ entities: number; relations: number }> {
  const rows = (await db.execute(sql`
    SELECT (SELECT count(*) FROM entities WHERE owner_id = ${GRAPH_OWNER_ID}::uuid) AS e,
           (SELECT count(*) FROM relations r
              JOIN entities s ON s.id = r.source_id
             WHERE s.owner_id = ${GRAPH_OWNER_ID}::uuid) AS r`)) as unknown as Array<{
    e: string;
    r: string;
  }>;
  const row = rows[0];
  return { entities: Number(row?.e ?? 0), relations: Number(row?.r ?? 0) };
}

/**
 * Сеет корпус, если его ещё нет. Возвращает фактические счётчики — их печатает вызывающий:
 * замер, сделанный на неполном корпусе, обязан быть виден по числам, а не только по времени.
 */
export async function ensureGraphFixture(): Promise<{
  entities: number;
  relations: number;
  seeded: boolean;
}> {
  const { db, client } = adminDb();
  try {
    const before = await countRows(db);
    if (before.entities === GRAPH_ENTITIES && before.relations === GRAPH_RELATIONS) {
      return { ...before, seeded: false };
    }
    // Неполный корпус — не «досеваем», а пересеваем: досев ЛЮБОЙ формы обязан знать, какие
    // именно строки уже есть, а знать этого он не может — прошлый прогон могли оборвать.
    await db.execute(sql`DELETE FROM entities WHERE owner_id = ${GRAPH_OWNER_ID}::uuid`);

    const rows: (typeof entities.$inferInsert)[] = [];
    for (const [level, size] of LEVEL_SIZES.entries()) {
      for (let index = 0; index < size; index++) rows.push(entityRow(level, index));
    }
    for (let i = 0; i < rows.length; i += BATCH) {
      await db.insert(entities).values(rows.slice(i, i + BATCH));
    }

    const edges: (typeof relations.$inferInsert)[] = [];
    for (const [level, size] of LEVEL_SIZES.entries()) {
      if (level === 0) continue;
      for (let index = 0; index < size; index++) {
        for (const parent of parentsOf(level, index)) {
          edges.push({
            id: uuidv5(`graph-perf-fixture:edge:${level}:${index}:${parent}`, ORBIS_NAMESPACE),
            sourceId: graphNodeId(level - 1, parent),
            targetId: graphNodeId(level, index),
            role: 'subitem',
            relationType: 'parent',
          });
        }
      }
    }
    // Упоминания: объём таблицы связей и селективность по роли. Смещения взаимно различны и
    // не кратны размеру корпуса, поэтому ни петли, ни повтора пары (source, target, type)
    // не возникает — а `rel_uniq` стоит именно на этой тройке.
    const flat = rows.map((r) => r.id as string);
    for (const [i, sourceId] of flat.entries()) {
      for (const offset of MENTION_OFFSETS) {
        edges.push({
          id: uuidv5(`graph-perf-fixture:mention:${i}:${offset}`, ORBIS_NAMESPACE),
          sourceId,
          targetId: flat[(i + offset) % flat.length] as string,
          role: 'mention',
          relationType: 'related_to',
        });
      }
    }
    for (let i = 0; i < edges.length; i += BATCH) {
      await db.insert(relations).values(edges.slice(i, i + BATCH));
    }

    // ANALYZE — условие осмысленности и замера, и EXPLAIN: на свежезалитой таблице
    // планировщик выбирает план по умолчаниям статистики, и вердикт по индексу был бы
    // вердиктом о его неведении (тот же урок, что в `src/test/perf.ts`).
    await db.execute(sql`ANALYZE entities, relations`);
    return { ...(await countRows(db)), seeded: true };
  } finally {
    await client.end();
  }
}
