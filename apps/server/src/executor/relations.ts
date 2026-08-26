// apps/server/src/executor/relations.ts
// Ролевой слой графа связей (§А4-3): идентичность ребра, виртуальные эффекты batch и
// GENERIC-ограничения реестра ролей — `acyclic`, `target_max_incoming`, `created_by`.
//
// Почему отдельный модуль. До реформы каждое ограничение графа было ОТДЕЛЬНЫМ доменным
// правилом с зашитым значением типа: «ацикличность blocks», «один budget-parent». Роль
// сделала их одним механизмом с параметром — правило описано СТРОКОЙ РЕЕСТРА
// (`relation_role_definitions.constraints`), и код обязан быть один на все роли, включая
// собственные роли владельца (§А4-2). Держать этот механизм в `invariants.ts` рядом с
// «живым грантом в назначении» значило бы смешать доменные правила аспектов с языком графа:
// у них разные читатели, и разъезжаются они по-разному.
//
// Чего здесь НЕТ: конвейера стадий (`prepareRelationCreate`/`prepareRelationDelete`). Он
// остался в `executor.ts` и не переехал сюда намеренно: ему нужны десять приватных символов
// executor'а (`ExecCtx`, `PreparedOp`, `BatchState`, `loadEntityForUpdate`, `parseEnvelope`,
// `gateEntitlements`…), и вынос стадий превратил бы одностороннюю зависимость в цикл
// `executor ⇄ relations`. Переехало то, что действительно самостоятельно — язык ролей.
import { RELATION_ROLE_IDS, type RelationRoleDefinition, type RelationRoleId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';
import type { RegistrySnapshot } from '../registry/load';
import { ExecError } from './errors';
import { resolveEntityTitles } from './invariants';
import { projectLegacyRelationType } from './legacy-form';
import type { MutationMechanism } from './types';

/**
 * Идентичность связи (§А4-3): пара концов и РОЛЬ. Прежняя тройка с `relation_type` держалась
 * на закрытом списке из четырёх значений; роль пришла из реестра и расширяема владельцем.
 */
export interface RelationKey {
  sourceId: string;
  targetId: string;
  role: string;
}

/**
 * Создаваемая batch'ем связь плюс признак «источник — конверт».
 *
 * Признак ЖИВЁТ до 0017 и только ради `assertSingleLegacyBudgetParent`: старая колонка
 * различает конверт-родителя по аспекту ИСТОЧНИКА, а у виртуального ребра источник — строка,
 * которой ещё нет в БД. Роль этого признака не заменяет: `subitem` от конверта и `subitem` от
 * проекта — одна роль и разный смысл для агрегатов. Уходит вместе с колонкой.
 */
export interface VirtualRelationCreate extends RelationKey {
  sourceHasBudget: boolean;
}

/** Виртуальные эффекты batch над графом связей (операции 1..N−1 для проверки операции N). */
export interface VirtualGraphEffects {
  created: ReadonlyArray<VirtualRelationCreate>;
  /** Удаляемые связи (например, перенос привязки батчем «удалить + создать»). */
  deleted: ReadonlyArray<RelationKey>;
  /** Титул виртуальной сущности, созданной тем же batch (для сообщений об ошибках). */
  titleOf?: (id: string) => string | undefined;
}

/**
 * Роли, которые код ядра называет ПОИМЁННО. Литералы собраны в одно место и типизованы
 * `RelationRoleId`: переименование роли в реестре обязано валить сборку, а не молча менять
 * поведение бюджета, повторений и прогонов.
 */
export const ROLE_INSTANCE_OF = 'instance-of' satisfies RelationRoleId;
export const ROLE_ENVELOPE_BINDING = 'envelope-binding' satisfies RelationRoleId;
export const ROLE_RUN = 'run' satisfies RelationRoleId;

/**
 * Роли, которые ПЕРЕХОДНАЯ колонка `relation_type` видит как `parent`. Список ВЫВЕДЕН из
 * проекции, а не написан второй раз: разъехавшись с ней, он открыл бы дыру ровно там, где
 * закрывает её — на непереведённых читателях старой колонки (бюджет, компилятор запросов,
 * agent-loop, импорт). Уходит вместе с колонкой в 0017.
 */
export const LEGACY_PARENT_ROLES: readonly RelationRoleId[] = RELATION_ROLE_IDS.filter(
  (role) => projectLegacyRelationType(role) === 'parent',
);

export function sameRelationKey(a: RelationKey, b: RelationKey): boolean {
  return a.sourceId === b.sourceId && a.targetId === b.targetId && a.role === b.role;
}

function withRole<T extends RelationKey>(keys: ReadonlyArray<T> | undefined, role: string): T[] {
  return (keys ?? []).filter((k) => k.role === role);
}

/** Человекочитаемое имя роли для текста отказа; без русской подписи — свой id. */
function roleName(def: RelationRoleDefinition | undefined, role: string): string {
  return def?.label.ru ?? role;
}

/**
 * Единственный вход стадии 4 для ролевых ограничений (§А4-2): существование роли, гейт
 * механизма и все объявленные `constraints`. Вызывается ТОЛЬКО из `relation_create` —
 * удаление ребра ни одного из этих правил не нарушает, а гейт `created_by` на удалении
 * запер бы владельцу уборку собственного графа (снять привязку к конверту руками).
 *
 * `ctx` собран в объект, а не разложен по позиционным аргументам, ровно потому, что все три
 * его поля отвечают на один вопрос — «от чьего имени идёт запись»: владелец графа (замок
 * ацикличности берётся на него), механизм (гейт `created_by`) и признак отката.
 */
export async function assertRoleConstraints(
  tx: Tx,
  reg: RegistrySnapshot,
  key: RelationKey,
  effects: VirtualGraphEffects | undefined,
  ctx: {
    ownerId: string;
    mechanism: MutationMechanism;
    /**
     * Внутренний режим undo (§7.8): гейт `created_by` спрашивает, кто ребро ПОРОДИЛ, а не
     * кто вернул его на место. Откат проигрывает СВОЙ ЖЕ записанный inverse — отказ здесь
     * означал бы, что законно созданную хуком привязку нельзя отменить. Ровно так же откат
     * пропускает гейт флагов свойств (см. `InternalUndoMode`).
     */
    undoReplay: boolean;
  },
): Promise<void> {
  const def = reg.roles.get(key.role);
  if (def === undefined) {
    // Не INVARIANT: граф ничего не нарушил — назван несуществующий предмет разговора.
    throw new ExecError('VALIDATION', `неизвестная роль связи «${key.role}» (§А4-3)`, {
      role: key.role,
    });
  }
  // ИНТЕРВАЛ 7a→0017. Колонка `relation_type` ещё NOT NULL, и записать её можно только
  // проекцией встроенной роли — у собственной роли владельца проекции нет по построению.
  // Отказ ЯВНЫЙ: без него `projectLegacyRelationType` уронил бы стадию 5 голым Error, то
  // есть 500 вместо ответа. Снимает 0017 вместе с колонкой (роли владельца — Задача 15).
  if (!(RELATION_ROLE_IDS as readonly string[]).includes(key.role)) {
    throw new ExecError(
      'VALIDATION',
      `собственные роли рёбер станут доступны после contract-миграции 0017: у роли «${key.role}» нет проекции в переходную колонку типа`,
      { role: key.role, legacyInterval: true },
    );
  }

  if (def.constraints.created_by === 'system' && ctx.mechanism === 'user' && !ctx.undoReplay) {
    throw new ExecError(
      'ROLE_SYSTEM_ONLY',
      `связь роли «${roleName(def, key.role)}» ставит сервер, а не пользователь (§А4-4)`,
      { role: key.role, mechanism: ctx.mechanism },
    );
  }

  if (def.constraints.acyclic === true) {
    await assertAcyclic(tx, ctx.ownerId, key, def, effects);
  }

  const max = def.constraints.target_max_incoming;
  if (max !== undefined) {
    await assertTargetMaxIncoming(tx, key, def, max, effects);
  }
}

/**
 * Ацикличность роли (§А4-2, `constraints.acyclic`): перед вставкой ребра role(source→target)
 * проверить, достижим ли source из target по существующим рёбрам ТОЙ ЖЕ роли; если да —
 * вставка замкнула бы цикл → INVARIANT с details.path = [$source, …найденный путь…]
 * в порядке «A → B → C → A» (титулы — в сообщении).
 *
 * Обобщение прежней `assertAcyclicBlocks`: правило то же, зашитый `blocks` заменён ролью из
 * реестра. Ролей с этим ограничением в v1 две — `dependency` (бывший `blocks`) и
 * `category-parent` (НОВОЕ поведение: сегодня циклы в дереве категорий не запрещены).
 *
 * ownerId сериализует записи владельца ПО ЭТОЙ РОЛИ advisory-lock'ом (как approve/reject в
 * policy/pending). Без него проверка страдает write-skew: FOR UPDATE берётся лишь на два
 * конца нового ребра, а обход графа идёт в READ COMMITTED — две транзакции, добавляющие
 * A→B и C→D при существующих B→C и D→A, друг друга не видят и вместе замыкают цикл.
 * Ключ замка — `<owner>:<role>`, а не `<owner>:blocks`: две разные роли ацикличны
 * независимо, и общий замок сериализовал бы правку дерева категорий с правкой зависимостей.
 * Лок реентерабелен: batch с несколькими рёбрами роли берёт его повторно без вреда.
 */
export async function assertAcyclic(
  tx: Tx,
  ownerId: string,
  key: RelationKey,
  def: RelationRoleDefinition | undefined,
  virtual?: VirtualGraphEffects,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ownerId}:${key.role}`}, 0))`,
  );
  const edges = roleEdgesCte(
    key.role,
    withRole(virtual?.created, key.role),
    withRole(virtual?.deleted, key.role),
  );

  // Достижимость по МНОЖЕСТВУ вершин: UNION дедупит уже посещённые, обход линеен по
  // числу рёбер. Прежний обход по path-массивам перечислял все простые пути и
  // взрывался экспоненциально на сходящихся путях (ромбовидный граф, ревью 2026-07-09).
  const hit = (await tx.execute(sql`
    WITH RECURSIVE edges (source_id, target_id) AS (${edges}),
    reach (id) AS (
      SELECT e.target_id FROM edges e WHERE e.source_id = ${key.targetId}
      UNION
      SELECT e.target_id FROM edges e JOIN reach ON e.source_id = reach.id
    )
    SELECT 1 AS hit FROM reach WHERE id = ${key.sourceId} LIMIT 1
  `)) as unknown as Array<{ hit: number }>;
  if (hit.length === 0) return;

  // Цикл найден: путь для сообщения восстанавливается ВТОРЫМ запросом только на
  // ошибочном пути — достижимые рёбра (каждое ровно один раз, UNION) + BFS в JS.
  const reachableEdges = (await tx.execute(sql`
    WITH RECURSIVE edges (source_id, target_id) AS (${edges}),
    walk (source_id, target_id) AS (
      SELECT e.source_id, e.target_id FROM edges e WHERE e.source_id = ${key.targetId}
      UNION
      SELECT e.source_id, e.target_id FROM edges e JOIN walk ON e.source_id = walk.target_id
    )
    SELECT source_id, target_id FROM walk
  `)) as unknown as Array<{ source_id: string; target_id: string }>;
  const tail = shortestPath(reachableEdges, key.targetId, key.sourceId);
  if (!tail) {
    // Недостижимо: та же tx, advisory-lock сериализует записи владельца по этой роли
    throw new Error('assertAcyclic: цикл обнаружен, но путь не восстановлен');
  }

  // Путь цикла: [$source, target, …, $source] — порядок «A → B → C → A»
  const path = [key.sourceId, ...tail];
  const titles = await resolveEntityTitles(tx, path, virtual?.titleOf);
  const rendered = path.map((id) => `«${titles.get(id) ?? id}»`).join(' → ');
  throw new ExecError(
    'INVARIANT',
    `связь роли «${roleName(def, key.role)}» замкнула бы цикл: ${rendered} (§А4-2: роль объявлена acyclic)`,
    {
      invariant: 'relation_cycle',
      role: key.role,
      path,
      titles: path.map((id) => titles.get(id) ?? id),
    },
  );
}

/**
 * CTE-фрагмент рёбер РОЛИ: БД-строки (минус удаляемые тем же batch) плюс виртуальные рёбра
 * batch (§7.8). Без виртуальных эффектов — чистый SELECT по relations.
 */
function roleEdgesCte(role: string, vCreated: RelationKey[], vDeleted: RelationKey[]) {
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
    WHERE r.role = ${role} ${deletedCond}
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
 * Максимум входящих рёбер роли (§А4-2, `constraints.target_max_incoming`): у цели не может
 * быть больше N живых входящих связей ЭТОЙ роли. Row-lock строки цели сериализует
 * конкурентов: проигравший увидит зафиксированную связь победителя и получит INVARIANT.
 *
 * Это ПЕРЕЕЗД доменного инварианта «один budget-parent» (§4.2/§13.7) из кода в реестр —
 * единственный инвариант, переезжающий уже в части А. Проверка аспектов концов исчезла
 * вместе с догадкой: «конверт считает транзакцию» теперь написано ролью ребра, а не выведено
 * из `orbis/budget` у источника и `orbis/financial` у цели.
 *
 * Рёбра ОТ ТОГО ЖЕ источника не считаются: повтор той же пары с той же ролью — территория
 * `rel_uniq` (duplicate_relation), и два разных отказа на одну ошибку читались бы как два
 * разных правила.
 */
export async function assertTargetMaxIncoming(
  tx: Tx,
  key: RelationKey,
  def: RelationRoleDefinition | undefined,
  max: number,
  virtual?: VirtualGraphEffects,
): Promise<void> {
  // Блокировка строки цели — как у прежнего «одного budget-parent» (§13.7)
  await tx.execute(sql`SELECT id FROM entities WHERE id = ${key.targetId} FOR UPDATE`);

  const rows = (await tx.execute(sql`
    SELECT r.source_id FROM relations r
    WHERE r.target_id = ${key.targetId} AND r.role = ${key.role}
  `)) as unknown as Array<{ source_id: string }>;

  const deletedInBatch = withRole(virtual?.deleted, key.role).filter(
    (d) => d.targetId === key.targetId,
  );
  const liveDb = rows
    .map((r) => r.source_id)
    .filter((src) => !deletedInBatch.some((d) => d.sourceId === src));
  const liveVirtual = withRole(virtual?.created, key.role)
    .filter((c) => c.targetId === key.targetId)
    .map((c) => c.sourceId);

  const others = [...new Set([...liveDb, ...liveVirtual])].filter((src) => src !== key.sourceId);
  if (others.length < max) return;
  const existing = others[0];
  throw new ExecError(
    'INVARIANT',
    `у записи уже есть входящая связь роли «${roleName(def, key.role)}», а роль допускает не больше ${max} (§А4-2); перенос — batch «удалить старую + создать новую»`,
    {
      invariant: 'target_max_incoming',
      role: key.role,
      max,
      targetId: key.targetId,
      existingSourceId: existing,
    },
  );
}

/**
 * ИНТЕРВАЛ 7a→0017: «транзакция списывается максимум из одного конверта» (§4.2/§13.7) на
 * множестве СТАРОЙ колонки.
 *
 * Почему этого мало — `target_max_incoming` роли `envelope-binding`. Ограничение роли считает
 * рёбра СВОЕЙ роли, а роль эта системная: владелец её не ставит вовсе. Зато агрегаты бюджета
 * до contract-миграции считают детей конверта по переходной колонке (`spentByEnvelope`:
 * `relation_type='parent'`, без роли) — то есть считают и `subitem`, и `ticket`, и любую
 * другую роль владельца с той же проекцией. Ребро `subitem` от второго конверта проходило бы
 * все ролевые проверки, а владелец увидел бы ОДНУ трату в ДВУХ конвертах.
 *
 * Поэтому счёт входящих идёт ровно по тому множеству, по которому считают агрегаты:
 * `LEGACY_PARENT_ROLES` с источником, несущим `orbis/budget`. Порог берётся из строки реестра
 * (`target_max_incoming` роли конверта) — правило одно, и ослабив роль, владелец ослабляет обе
 * его половины.
 *
 * Применимость (аспекты концов) проверяет ВЫЗЫВАЮЩАЯ сторона — как и у прежнего
 * `assertSingleBudgetParent`: у пути создания это аспекты нового ребра, у ретроспективного
 * пути — сущность, которая конвертом становится.
 *
 * Рёбра ОТ ТОГО ЖЕ источника не считаются: повтор той же пары — территория `rel_uniq`, а
 * второй конверт по определению другой.
 *
 * Умирает вместе с колонкой: с 0017 «конверт-родитель» выражается ровно ролью, и остаётся
 * одно ограничение реестра (перевод — правило Б-2).
 */
export async function assertSingleLegacyBudgetParent(
  tx: Tx,
  reg: RegistrySnapshot,
  key: RelationKey,
  virtual?: VirtualGraphEffects,
): Promise<void> {
  const def = reg.roles.get(ROLE_ENVELOPE_BINDING);
  const max = def?.constraints.target_max_incoming;
  if (max === undefined) return;
  const parentRoles = LEGACY_PARENT_ROLES as readonly string[];

  // Row-lock строки цели сериализует конкурентов: проигравший увидит зафиксированную связь
  // победителя и получит INVARIANT (тот же приём, что у `assertTargetMaxIncoming`).
  await tx.execute(sql`SELECT id FROM entities WHERE id = ${key.targetId} FOR UPDATE`);

  const rows = (await tx.execute(sql`
    SELECT r.source_id, r.role FROM relations r
    JOIN entities e ON e.id = r.source_id
    WHERE r.target_id = ${key.targetId}
      AND r.role IN (${sql.join(
        parentRoles.map((r) => sql`${r}`),
        sql`, `,
      )})
      AND 'orbis/budget' = ANY(e.aspects)
  `)) as unknown as Array<{ source_id: string; role: string }>;

  const deleted = virtual?.deleted ?? [];
  const liveDb = rows
    .filter(
      (r) =>
        !deleted.some(
          (d) => d.sourceId === r.source_id && d.targetId === key.targetId && d.role === r.role,
        ),
    )
    .map((r) => r.source_id);
  const liveVirtual = (virtual?.created ?? [])
    .filter((c) => c.targetId === key.targetId && c.sourceHasBudget && parentRoles.includes(c.role))
    .map((c) => c.sourceId);

  const others = [...new Set([...liveDb, ...liveVirtual])].filter((src) => src !== key.sourceId);
  if (others.length < max) return;
  throw new ExecError(
    'INVARIANT',
    `у записи уже есть конверт-родитель: транзакция списывается максимум из одного конверта (§4.2); до contract-миграции 0017 конвертом её считает ЛЮБАЯ связь от конверта, а не только роль «${roleName(def, ROLE_ENVELOPE_BINDING)}»; перенос — batch «удалить старую + создать новую»`,
    {
      invariant: 'single_budget_parent',
      legacyInterval: true,
      targetId: key.targetId,
      existingSourceId: others[0],
    },
  );
}

/** Структурированный отказ повтора связи (rel_uniq, §4.2) — общий для 23505 и пре-чека. */
export function duplicateRelationError(
  key: RelationKey,
  def: RelationRoleDefinition | undefined,
): ExecError {
  return new ExecError(
    'INVARIANT',
    `связь роли «${roleName(def, key.role)}» между этими сущностями уже существует (rel_uniq, §4.2)`,
    { invariant: 'duplicate_relation', ...key },
  );
}

/**
 * ИНТЕРВАЛ 7a→0017 (находка 55). До contract-миграции `rel_uniq` стоит на тройке со СТАРЫМ
 * типом, а не с ролью, — значит две роли, проецирующиеся в один тип (`subitem`+`ticket`,
 * `subitem`+`envelope-binding`, `mention`+`supersedes`…), на одной паре сущностей
 * невыразимы. Это ограничение интервала, а не правило графа: 0017 переставляет уникальность
 * на роль, и обе связи станут законны.
 *
 * Отдельный отказ, а не общий `duplicate_relation`, ровно потому, что владельцу нужно
 * различить «такая связь уже есть» и «пока нельзя — реформа не доехала». Полагаться на
 * 23505 здесь нельзя: после нарушения ограничения транзакция ABORTED, и назвать роль
 * помешавшей связи уже нечем — запрос из catch не выполнится.
 */
function legacyIntervalError(key: RelationKey, existingRole: string): ExecError {
  const legacy = projectLegacyRelationType(key.role);
  return new ExecError(
    'INVARIANT',
    `на этой паре сущностей уже есть связь роли «${existingRole}», и до contract-миграции 0017 уникальность стоит на старом типе «${legacy}», общем у обеих ролей — вторая связь пока невыразима (интервал реформы)`,
    {
      invariant: 'duplicate_relation',
      legacyInterval: true,
      legacyRelationType: legacy,
      existingRole,
      ...key,
    },
  );
}

/**
 * Пре-чек уникальности связи — на ВСЕХ путях, а не только в batch. Раньше одиночный
 * `relation_create` полагался на 23505: связь одна, ловить её после вставки было дёшево.
 * С реформой этого мало — под `rel_uniq` теперь попадают ДВЕ РАЗНЫЕ роли (см.
 * `legacyIntervalError`), и различить их случаи можно только ДО вставки, пока транзакция
 * жива. Ловля 23505 остаётся второй линией под гонкой.
 *
 * Один запрос по паре концов вместо двух по разным ключам: префикс (source_id, target_id)
 * уникального индекса `rel_uniq` обслуживает его целиком.
 */
export async function assertNoDuplicateRelation(
  tx: Tx,
  reg: RegistrySnapshot,
  key: RelationKey,
  virtual?: VirtualGraphEffects,
): Promise<void> {
  const def = reg.roles.get(key.role);
  const legacy = projectLegacyRelationType(key.role);
  const onPair: string[] = [];

  const rows = (await tx.execute(sql`
    SELECT role FROM relations
    WHERE source_id = ${key.sourceId} AND target_id = ${key.targetId}
  `)) as unknown as Array<{ role: string }>;
  for (const row of rows) {
    // Строка в БД, удаляемая более ранней операцией batch, дублем не считается
    const removed = (virtual?.deleted ?? []).some(
      (d) => d.sourceId === key.sourceId && d.targetId === key.targetId && d.role === row.role,
    );
    if (!removed) onPair.push(row.role);
  }
  for (const c of virtual?.created ?? []) {
    if (c.sourceId === key.sourceId && c.targetId === key.targetId) onPair.push(c.role);
  }

  if (onPair.includes(key.role)) throw duplicateRelationError(key, def);
  const collision = onPair.find((role) => projectLegacyRelationType(role) === legacy);
  if (collision !== undefined) {
    throw legacyIntervalError(key, roleName(reg.roles.get(collision), collision));
  }
}
