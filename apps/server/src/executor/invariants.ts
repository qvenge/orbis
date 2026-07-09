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
  const vCreated = blocksOnly(virtual?.created);
  const vDeleted = blocksOnly(virtual?.deleted);

  let found: { path: string[] } | undefined;
  if (vCreated.length === 0 && vDeleted.length === 0) {
    // SQL дословно из задачи (§4.2)
    const rows = (await tx.execute(sql`
      WITH RECURSIVE walk AS (
        SELECT r.target_id, ARRAY[r.source_id, r.target_id] AS path
        FROM relations r WHERE r.source_id = ${targetId} AND r.relation_type = 'blocks'
        UNION ALL
        SELECT r.target_id, walk.path || r.target_id
        FROM relations r JOIN walk ON r.source_id = walk.target_id
        WHERE r.relation_type = 'blocks' AND NOT r.target_id = ANY(walk.path)
      )
      SELECT path FROM walk WHERE target_id = ${sourceId} LIMIT 1
    `)) as unknown as Array<{ path: string[] }>;
    found = rows[0];
  } else {
    // Гибридный граф batch: БД-рёбра (минус удаляемые тем же batch) + виртуальные
    // рёбра batch — тот же обход, но по CTE edges вместо таблицы relations.
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
    const rows = (await tx.execute(sql`
      WITH RECURSIVE edges (source_id, target_id) AS (
        SELECT r.source_id, r.target_id FROM relations r
        WHERE r.relation_type = 'blocks' ${deletedCond}
        ${createdUnion}
      ),
      walk AS (
        SELECT e.target_id, ARRAY[e.source_id, e.target_id] AS path
        FROM edges e WHERE e.source_id = ${targetId}
        UNION ALL
        SELECT e.target_id, walk.path || e.target_id
        FROM edges e JOIN walk ON e.source_id = walk.target_id
        WHERE NOT e.target_id = ANY(walk.path)
      )
      SELECT path FROM walk WHERE target_id = ${sourceId} LIMIT 1
    `)) as unknown as Array<{ path: string[] }>;
    found = rows[0];
  }
  if (!found) return;

  // Путь цикла: [$source, target, …, $source] — порядок «A → B → C → A»
  const path = [sourceId, ...found.path];
  const titles = await resolveEntityTitles(tx, path, virtual?.titleOf);
  const rendered = path.map((id) => `«${titles.get(id) ?? id}»`).join(' → ');
  throw new ExecError(
    'INVARIANT',
    `blocks-связь замкнула бы цикл: ${rendered} (§4.2, граф blocks обязан оставаться ацикличным)`,
    { invariant: 'blocks_cycle', path, titles: path.map((id) => titles.get(id) ?? id) },
  );
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
