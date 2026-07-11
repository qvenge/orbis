// apps/server/src/executor/invariants.ts
// Доменные инварианты графа связей (§4.2) — стадия 4 конвейера, всё ДО первой записи.
//
// Все проверки принимают опциональные «виртуальные» эффекты batch (§7.8): связи,
// создаваемые/удаляемые предыдущими операциями того же batch, ещё не записаны в БД,
// но обязаны быть видимы проверкам последующих операций.
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';
import { ExecError } from './errors';

/** Идентичность связи — тройка rel_uniq (§4.2). */
export interface RelationKey {
  sourceId: string;
  targetId: string;
  relationType: string;
}

/** Виртуальные эффекты batch над графом связей (операции 1..N−1 для проверки операции N). */
export interface VirtualGraphEffects {
  /** Создаваемые связи; sourceHasBudget — признак «orbis/budget» у source (для budget-parent). */
  created: ReadonlyArray<RelationKey & { sourceHasBudget: boolean }>;
  /** Удаляемые связи (например, перенос budget-parent батчем «удалить + создать»). */
  deleted: ReadonlyArray<RelationKey>;
  /** Титул виртуальной сущности, созданной тем же batch (для сообщений об ошибках). */
  titleOf?: (id: string) => string | undefined;
}

function sameKey(a: RelationKey, b: RelationKey): boolean {
  return (
    a.sourceId === b.sourceId && a.targetId === b.targetId && a.relationType === b.relationType
  );
}

function blocksOnly<T extends RelationKey>(keys: ReadonlyArray<T> | undefined): T[] {
  return (keys ?? []).filter((k) => k.relationType === 'blocks');
}

/**
 * Титулы сущностей для человекочитаемых сообщений: виртуальные (созданные batch'ем) —
 * из titleOf, остальные — из БД (RLS показывает только свои — этого достаточно,
 * путь цикла состоит из собственных сущностей).
 */
export async function resolveEntityTitles(
  tx: Tx,
  ids: readonly string[],
  titleOf?: (id: string) => string | undefined,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  for (const id of new Set(ids)) {
    const virtual = titleOf?.(id);
    if (virtual !== undefined) titles.set(id, virtual);
  }
  const missing = [...new Set(ids)].filter((id) => !titles.has(id));
  if (missing.length > 0) {
    const rows = (await tx.execute(
      sql`SELECT id, title FROM entities WHERE id IN (${sql.join(
        missing.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )) as unknown as Array<{ id: string; title: string }>;
    for (const row of rows) titles.set(row.id, row.title);
  }
  return titles;
}

/**
 * Ацикличность blocks (§4.2): перед вставкой blocks(source→target) проверить,
 * достижим ли source из target по существующим blocks-рёбрам; если да — вставка
 * замкнула бы цикл → INVARIANT с details.path = [$source, …найденный путь…]
 * в порядке «A → B → C → A» (титулы — в сообщении).
 *
 * ownerId сериализует blocks-записи владельца advisory-lock'ом (как approve/reject в
 * policy/pending). Без него проверка страдает write-skew: FOR UPDATE берётся лишь на два
 * конца нового ребра, а обход графа идёт в READ COMMITTED — две транзакции, добавляющие
 * A→B и C→D при существующих B→C и D→A, друг друга не видят и вместе замыкают цикл.
 * Лок реентерабелен: batch с несколькими blocks берёт его повторно без вреда.
 */
export async function assertAcyclicBlocks(
  tx: Tx,
  ownerId: string,
  sourceId: string,
  targetId: string,
  virtual?: VirtualGraphEffects,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ownerId}:blocks`}, 0))`);
  const edges = blocksEdgesCte(blocksOnly(virtual?.created), blocksOnly(virtual?.deleted));

  // Достижимость по МНОЖЕСТВУ вершин: UNION дедупит уже посещённые, обход линеен по
  // числу рёбер. Прежний обход по path-массивам перечислял все простые пути и
  // взрывался экспоненциально на сходящихся путях (ромбовидный граф, ревью 2026-07-09).
  const hit = (await tx.execute(sql`
    WITH RECURSIVE edges (source_id, target_id) AS (${edges}),
    reach (id) AS (
      SELECT e.target_id FROM edges e WHERE e.source_id = ${targetId}
      UNION
      SELECT e.target_id FROM edges e JOIN reach ON e.source_id = reach.id
    )
    SELECT 1 AS hit FROM reach WHERE id = ${sourceId} LIMIT 1
  `)) as unknown as Array<{ hit: number }>;
  if (hit.length === 0) return;

  // Цикл найден: путь для сообщения восстанавливается ВТОРЫМ запросом только на
  // ошибочном пути — достижимые рёбра (каждое ровно один раз, UNION) + BFS в JS.
  const reachableEdges = (await tx.execute(sql`
    WITH RECURSIVE edges (source_id, target_id) AS (${edges}),
    walk (source_id, target_id) AS (
      SELECT e.source_id, e.target_id FROM edges e WHERE e.source_id = ${targetId}
      UNION
      SELECT e.source_id, e.target_id FROM edges e JOIN walk ON e.source_id = walk.target_id
    )
    SELECT source_id, target_id FROM walk
  `)) as unknown as Array<{ source_id: string; target_id: string }>;
  const tail = shortestPath(reachableEdges, targetId, sourceId);
  if (!tail) {
    // Недостижимо: та же tx, advisory-lock сериализует blocks-записи владельца
    throw new Error('assertAcyclicBlocks: цикл обнаружен, но путь не восстановлен');
  }

  // Путь цикла: [$source, target, …, $source] — порядок «A → B → C → A»
  const path = [sourceId, ...tail];
  const titles = await resolveEntityTitles(tx, path, virtual?.titleOf);
  const rendered = path.map((id) => `«${titles.get(id) ?? id}»`).join(' → ');
  throw new ExecError(
    'INVARIANT',
    `blocks-связь замкнула бы цикл: ${rendered} (§4.2, граф blocks обязан оставаться ацикличным)`,
    { invariant: 'blocks_cycle', path, titles: path.map((id) => titles.get(id) ?? id) },
  );
}

/**
 * CTE-фрагмент blocks-рёбер: БД-строки (минус удаляемые тем же batch) плюс
 * виртуальные рёбра batch (§7.8). Без виртуальных эффектов — чистый SELECT по relations.
 */
function blocksEdgesCte(vCreated: RelationKey[], vDeleted: RelationKey[]) {
  const deletedCond =
    vDeleted.length > 0
      ? sql`AND (r.source_id, r.target_id) NOT IN (VALUES ${sql.join(
          vDeleted.map((e) => sql`(${e.sourceId}::uuid, ${e.targetId}::uuid)`),
          sql`, `,
        )})`
      : sql``;
  const createdUnion =
    vCreated.length > 0
      ? sql`UNION ALL SELECT v.source_id, v.target_id FROM (VALUES ${sql.join(
          vCreated.map((e) => sql`(${e.sourceId}::uuid, ${e.targetId}::uuid)`),
          sql`, `,
        )}) AS v(source_id, target_id)`
      : sql``;
  return sql`
    SELECT r.source_id, r.target_id FROM relations r
    WHERE r.relation_type = 'blocks' ${deletedCond}
    ${createdUnion}
  `;
}

/** Кратчайший путь BFS по списку рёбер: [from, …, to]; undefined — недостижимо. */
function shortestPath(
  edges: ReadonlyArray<{ source_id: string; target_id: string }>,
  from: string,
  to: string,
): string[] | undefined {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const out = adjacency.get(e.source_id);
    if (out) out.push(e.target_id);
    else adjacency.set(e.source_id, [e.target_id]);
  }
  const prev = new Map<string, string>();
  const visited = new Set([from]);
  let frontier = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbor of adjacency.get(node) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        prev.set(neighbor, node);
        if (neighbor === to) {
          const path = [to];
          for (let cur = to; cur !== from; ) {
            const p = prev.get(cur);
            if (p === undefined) return undefined; // недостижимо по построению
            path.unshift(p);
            cur = p;
          }
          return path;
        }
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return undefined;
}

/**
 * Один budget-parent (§4.2, §13.7): при parent(source→target), где source имеет
 * orbis/budget и target — orbis/financial, у target не может быть другой живой
 * parent-связи от сущности с orbis/budget. Row-lock строки target сериализует
 * конкурентов: проигравший увидит зафиксированную связь победителя и получит INVARIANT.
 * Применимость (аспекты source/target) проверяет вызывающая сторона.
 */
export async function assertSingleBudgetParent(
  tx: Tx,
  sourceId: string,
  targetId: string,
  virtual?: VirtualGraphEffects,
): Promise<void> {
  // Блокировка строки транзакции — SQL дословно из задачи (§13.7)
  await tx.execute(sql`SELECT id FROM entities WHERE id = ${targetId} FOR UPDATE`);

  // Живые budget-parent'ы target в БД (aspects ? 'orbis/budget' — признак конверта)
  const rows = (await tx.execute(sql`
    SELECT r.source_id FROM relations r
    JOIN entities e ON e.id = r.source_id
    WHERE r.target_id = ${targetId} AND r.relation_type = 'parent'
      AND e.aspects ? 'orbis/budget'
  `)) as unknown as Array<{ source_id: string }>;

  const deletedInBatch = (virtual?.deleted ?? []).filter(
    (d) => d.relationType === 'parent' && d.targetId === targetId,
  );
  const liveDb = rows
    .map((r) => r.source_id)
    .filter((src) => !deletedInBatch.some((d) => d.sourceId === src));
  const liveVirtual = (virtual?.created ?? [])
    .filter((c) => c.relationType === 'parent' && c.targetId === targetId && c.sourceHasBudget)
    .map((c) => c.sourceId);

  // Свой повтор той же тройки — территория rel_uniq (duplicate_relation), не этого инварианта
  const existing = [...liveDb, ...liveVirtual].find((src) => src !== sourceId);
  if (existing !== undefined) {
    throw new ExecError(
      'INVARIANT',
      'у сущности уже есть budget-parent: транзакция списывается максимум из одного конверта (§4.2); перенос — batch «удалить старую + создать новую»',
      { invariant: 'single_budget_parent', targetId, existingSourceId: existing },
    );
  }
}

/** Структурированный отказ повтора тройки (rel_uniq, §4.2) — общий для 23505 и превентивной проверки. */
export function duplicateRelationError(key: RelationKey): ExecError {
  return new ExecError(
    'INVARIANT',
    `связь ${key.relationType} между этими сущностями уже существует (rel_uniq, §4.2)`,
    { invariant: 'duplicate_relation', ...key },
  );
}

/**
 * Превентивная проверка rel_uniq для batch: весь batch валидируется ДО первой записи,
 * поэтому дубль (в БД или среди связей, создаваемых тем же batch) должен быть найден
 * на стадии 4, а не отловлен 23505 на стадии 5.
 */
export async function assertNoDuplicateRelation(
  tx: Tx,
  key: RelationKey,
  virtual?: VirtualGraphEffects,
): Promise<void> {
  if ((virtual?.created ?? []).some((c) => sameKey(c, key))) throw duplicateRelationError(key);
  // Строка в БД, удаляемая более ранней операцией batch, дублем не считается
  if ((virtual?.deleted ?? []).some((d) => sameKey(d, key))) return;
  const rows = (await tx.execute(sql`
    SELECT 1 AS one FROM relations
    WHERE source_id = ${key.sourceId} AND target_id = ${key.targetId}
      AND relation_type = ${key.relationType}
    LIMIT 1
  `)) as unknown as Array<{ one: number }>;
  if (rows.length > 0) throw duplicateRelationError(key);
}
