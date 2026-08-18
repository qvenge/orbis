// apps/server/src/executor/invariants.ts
// Доменные инварианты стадии 4 — всё ДО первой записи: граф связей (§4.2) и те инварианты
// аспектов, которым нужна БД (живой грант в назначении, С4/С7). Чистые нормализации аспектов
// без обращения к БД живут в normalize.ts.
//
// Все проверки принимают опциональные «виртуальные» эффекты batch (§7.8): связи,
// создаваемые/удаляемые предыдущими операциями того же batch, ещё не записаны в БД,
// но обязаны быть видимы проверкам последующих операций.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { agentGrants } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from './errors';
import type { AspectsMap } from './normalize';
import type { MutationSource } from './types';

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

/**
 * Живой грант в назначении (С4/С7): `orbis/assignment` с `executor=agent` обязан указывать
 * на НЕОТОЗВАННЫЙ грант ВЛАДЕЛЬЦА сущности. Схема аспекта этого не выражает: `grant_id` лежит
 * в jsonb, внешнего ключа туда нет, а `.refine` зода исчезает при генерации JSON Schema — ajv
 * (стадия 2) проверяет только форму uuid. Поэтому связь «назначение → грант» держит executor,
 * и это единственное место, где она держится: обойти его нечем — мутации графа идут только
 * здесь.
 *
 * Проверяется в МОМЕНТ установки назначения, а не при каждой правке сущности: отзыв гранта
 * закрывает доступ агенту (verifyBearer), но не обязан замораживать уже назначенные тикеты —
 * иначе после отзыва их нельзя было бы даже переименовать. Вызывающая сторона зовёт эту
 * проверку ровно тогда, когда аспект назначения появляется или меняется.
 *
 * Чтение agent_grants идёт под `SET LOCAL ROLE authenticated` (withIdentity): политика
 * owner_owns_row показывает только строки владельца, но условие на owner_id всё равно
 * оставлено явным — оно же служит фильтром «грант чужой» на любых иных ролях.
 * Чужой и несуществующий грант неразличимы намеренно (единый NOT_FOUND, как у сущностей):
 * иначе назначение стало бы оракулом чужих grant_id.
 */
export async function assertAssignment(tx: Tx, ownerId: string, next: AspectsMap): Promise<void> {
  const a = next['orbis/assignment'];
  if (!a) return;
  if (a.executor === 'agent') {
    if (typeof a.grant_id !== 'string') {
      throw new ExecError('VALIDATION', 'назначение агенту требует grant_id', {
        aspect: 'orbis/assignment',
      });
    }
    const rows = await tx
      .select({ id: agentGrants.id })
      .from(agentGrants)
      .where(
        and(
          eq(agentGrants.id, a.grant_id),
          eq(agentGrants.ownerId, ownerId),
          isNull(agentGrants.revokedAt),
        ),
      );
    if (rows.length === 0) {
      throw new ExecError('NOT_FOUND', 'грант исполнителя не найден или отозван', {
        grant_id: a.grant_id,
      });
    }
  } else if (a.grant_id !== undefined) {
    // executor=human с грантом — не «лишнее поле», а рассогласование: тикет читался бы как
    // назначенный агенту одним кодом и человеку другим.
    throw new ExecError('VALIDATION', 'grant_id допустим только при executor=agent', {
      aspect: 'orbis/assignment',
    });
  }
}

/**
 * Ровно один субъект у прогона (V1.4): `orbis/agent-run` несёт ЛИБО `grant_id` (прогон по
 * тикету, работает внешний исполнитель по гранту), ЛИБО `routine_id` (прогон рутины, его
 * породило расписание). Ни одного — прогон-сирота: непонятно, чьей истории он принадлежит и
 * чем откатывается. Оба — прогон читался бы как тикетный одним кодом (rollback по гранту,
 * очередь исполнителя) и как рутинный другим (бухгалтерия бакета, стоп-кран рутины).
 *
 * Схемой это не выражается: `oneOf` спрятал бы оба поля от каталога грамматики (он читает
 * `properties` верхнего уровня), а `.refine` зода исчезает при генерации JSON Schema — ajv
 * стадии 2 проверил бы только формат uuid. Поэтому правило живёт здесь, как и «живой грант в
 * назначении», и обойти его нечем: мутации графа идут только через executor.
 *
 * Функция чистая (БД не нужна) и МОЛЧИТ, когда аспекта прогона в итоговой карте нет: её
 * зовут на всех трёх путях появления аспектов, и правка тикета без прогона — не её дело.
 */
export function assertRunSubject(next: AspectsMap): void {
  const run = next['orbis/agent-run'];
  if (!run) return;
  // Стадия 2 (ajv по реестру) отрабатывает раньше на всех трёх путях, поэтому здесь поле
  // либо отсутствует, либо содержит uuid-строку: отдельная ветка на null была бы мёртвой.
  const subjects = [run.grant_id, run.routine_id].filter((v) => v !== undefined);
  if (subjects.length !== 1) {
    throw new ExecError(
      'VALIDATION',
      'у прогона должен быть ровно один субъект: grant_id или routine_id',
      { aspect: 'orbis/agent-run', reason: 'run_subject' },
    );
  }
}

/**
 * Запрет по объекту для источника `routine` (V1.10, инвариант 6): рутина не меняет рутины и
 * не раздаёт назначения. Запрет сформулирован по ОБЪЕКТУ, а не по глаголу: неважно, каким
 * тулом рутина дотянулась до `orbis/routine` или `orbis/assignment` — create, update, attach,
 * связь — отказ один. Иначе рутина в режиме `act` могла бы расширить себе белый список
 * `allowed_tools`, снять паузу с себя или соседней рутины и завести исполнителю новую работу:
 * доверенность, выданную владельцем, нельзя переписывать её же руками.
 *
 * Точка проверки — стадия 4 executor'а, после чтения строки под `FOR UPDATE` и ДО первой
 * записи, рядом с `assertAssignment`. Это единственный рубеж, который нельзя обойти: гейт
 * режима в dispatch (V1.2) видит только имя тула, а `orbis_propose` — только форму
 * предложения; обе проверки — до конвейера, а мутации графа идут только здесь.
 *
 * Смотрит РОВНО на `source === 'routine'`. Прогон рутины (`orbis/agent-run` с `routine_id`)
 * рутиной НЕ является: его создание, шаги и связь `parent` рутина→прогон — бухгалтерия
 * источником `system` (Р-7), и инвариант на ней молчит. Внутренний undo (§7.8) идёт тем же
 * `system` — отдельного гейта `internalUndo` здесь поэтому нет.
 *
 * @param before аспекты строки ДО операции (update/attach; у create строки ещё нет)
 * @param next аспекты после операции
 * @param touched аспекты, которых операция касается (у create — весь вход, у attach — его аспект)
 */
export function assertRoutineUntouchable(
  source: MutationSource,
  args: { before?: AspectsMap; next: AspectsMap; touched: readonly string[] },
): void {
  if (source !== 'routine') return;
  // Рутина запрещена и как ОБЪЕКТ правки (сущность уже рутина либо ею становится), и как
  // затронутый аспект: detach `orbis/routine` в `next` не виден, но в `touched` — да.
  const hitsRoutine =
    args.before?.['orbis/routine'] !== undefined ||
    args.next['orbis/routine'] !== undefined ||
    args.touched.includes('orbis/routine');
  // Назначение — только по `touched`: рутина вправе править СВОЙ тикет (титул, статус),
  // но не переназначать его исполнителю.
  const hitsAssignment = args.touched.includes('orbis/assignment');
  if (!hitsRoutine && !hitsAssignment) return;
  throw routineUntouchableError();
}

/**
 * Тот же запрет по объекту для связей (V1.10, инвариант 6): рутина не привязывает ничего к
 * рутине и не отвязывает от неё. Достаточно ОДНОГО конца с `orbis/routine` — направление
 * связи ничего не меняет: и `parent` рутина→сущность, и обратная правят граф вокруг рутины.
 *
 * `ends.source`/`ends.target` — аспекты обоих концов, прочитанные под `FOR UPDATE`
 * (`loadBothEndsForUpdate`): без замка проверка сверяла бы состояние, которое конкурент
 * успел бы поменять до записи.
 */
export function assertRoutineRelationUntouchable(
  source: MutationSource,
  ends: { source: AspectsMap; target: AspectsMap },
): void {
  if (source !== 'routine') return;
  if (ends.source['orbis/routine'] === undefined && ends.target['orbis/routine'] === undefined) {
    return;
  }
  throw routineUntouchableError();
}

/**
 * Единый отказ обоих запретов по объекту: код `FORBIDDEN_LEVEL` (§7.10 «forbidden» — не
 * INVARIANT: граф остался бы целостным, отказано именно источнику), причина в `details` —
 * потребитель различает её полем, а не разбором текста.
 */
function routineUntouchableError(): ExecError {
  return new ExecError('FORBIDDEN_LEVEL', 'рутина не может менять рутины и назначения (V1.10)', {
    reason: 'routine_untouchable',
  });
}
