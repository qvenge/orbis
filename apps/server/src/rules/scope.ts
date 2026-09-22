// apps/server/src/rules/scope.ts
/**
 * ОЦЕНОЧНАЯ ОБЛАСТЬ НАД ОДНОЙ ЗАПИСЬЮ (Р-4, Р-И-4) — сборщик `ExprEvalScope` для движка правил C/T
 * (`rules/engine.ts`) и классификатора Б-2.
 *
 * Почему сборщик ОДИН и отдельным модулем: интерпретатор E синхронный (`expr/eval.ts`), значит всё, что
 * правило может спросить о графе — рёбра `$self`, величины соседей, день и зона владельца, параметры
 * движка, — обязано быть прочитано ДО вычисления и положено в поля области. Второй сборщик (у
 * классификатора, у будущего V2) разошёлся бы с этим на первом же новом поле — и одно и то же `when`
 * отвечало бы по-разному в зависимости от того, кто спросил.
 */
import { type GraphId, ROLE_INSTANCE_OF, type RuleDefinition } from '@orbis/shared';
import type { ExprNode, ExprScalar } from '@orbis/shared/expr';
import { and, eq, inArray } from 'drizzle-orm';
import { entities, relations } from '../db/schema';
import type { Tx } from '../db/with-identity';
import type { EntityState } from '../executor/props';
import type { VirtualGraphEffects } from '../executor/relations';
import type { ExprEvalScope, RelationFact } from '../expr/eval';
import type { RegistrySnapshot } from '../registry/load';
import { propertyDefaultsOf } from '../subscriptions/budget';

export interface EntityScopeInput {
  reg: RegistrySnapshot;
  /** Состояние ПОСЛЕ патча: для T-правил — «стало», для C-правил — итог операции. */
  state: EntityState;
  /** Колонки ядра; `updatedAt` — ТОТ штамп, что запишется этой операцией (Р-И-3). */
  core: { id: string; title: string | null; archived: boolean; createdAt: Date; updatedAt: Date };
  today: string;
  timeZone: string;
  relations: readonly RelationFact[];
  /** Параметры движка (`RULE_PARAMS`) — наполняются лениво, только названные правилами (Р-И-18). */
  params?: Record<string, ExprScalar>;
  owner: GraphId;
  /** Только классификатор `assign_level` (задача 15). */
  sensitivity?: readonly string[];
  touched?: readonly string[];
  aggVia?: ReadonlyMap<string, Readonly<Record<string, ExprScalar>>>;
  deref?: (id: string) => Record<string, unknown> | null;
}

/**
 * Core-проекции области записи — id, под которыми колонки ядра видны правилу (`{prop:'orbis/title'}`).
 * ОДИН список на сборщик области и на отбор C-правил правки без свойств (`coreFieldsChanged`):
 * второй перечень разошёлся бы с первым на первой новой проекции.
 */
export const CORE_PROJECTION = {
  title: 'orbis/title',
  archived: 'orbis/archived',
  createdAt: 'orbis/created_at',
  updatedAt: 'orbis/updated_at',
} as const;

/**
 * Поля ядра, которые правка РЕАЛЬНО меняет, — ровно те, что область правила объявляет
 * (`CORE_PROJECTION`). Тело и эмодзи в области не объявлены, и их правка не меняет здесь ничего.
 * `updated_at` меняется на каждой записи (монотонный штамп §5.2 строго растёт), `created_at` — никогда.
 */
export function coreFieldsChanged(
  prev: EntityScopeInput['core'],
  next: EntityScopeInput['core'],
): Set<string> {
  const out = new Set<string>();
  if (prev.title !== next.title) out.add(CORE_PROJECTION.title);
  if (prev.archived !== next.archived) out.add(CORE_PROJECTION.archived);
  if (prev.createdAt.getTime() !== next.createdAt.getTime()) out.add(CORE_PROJECTION.createdAt);
  if (prev.updatedAt.getTime() !== next.updatedAt.getTime()) out.add(CORE_PROJECTION.updatedAt);
  return out;
}

/**
 * Умолчания чтения — МЕМО по снимку: карта строится обходом ВСЕХ свойств реестра, а правила
 * спрашивают её на каждой операции (тот же приём, что `bindingsOf` движка ведомостей).
 */
const DEFAULTS_BY_SNAPSHOT = new WeakMap<object, ReadonlyMap<string, ExprScalar>>();

export function entityEvalScope(input: EntityScopeInput): ExprEvalScope {
  const { core, reg } = input;
  let defaults = DEFAULTS_BY_SNAPSHOT.get(reg);
  if (defaults === undefined) {
    defaults = propertyDefaultsOf(reg);
    DEFAULTS_BY_SNAPSHOT.set(reg, defaults);
  }
  return {
    params: input.params ?? {},
    aggs: {},
    phase: null,
    // core-поля лежат под своими id — ТОТ ЖЕ договор, что у `propsForEval` движка ведомостей:
    // правило пишет `{prop:'orbis/updated_at'}` (Р-И-3), и второго адреса у штампа записи нет.
    props: {
      ...input.state.props,
      [CORE_PROJECTION.title]: core.title,
      [CORE_PROJECTION.archived]: core.archived,
      [CORE_PROJECTION.createdAt]: core.createdAt.toISOString(),
      [CORE_PROJECTION.updatedAt]: core.updatedAt.toISOString(),
    },
    defaults,
    today: input.today,
    timeZone: input.timeZone,
    self: core.id,
    owner: input.owner,
    aspects: input.state.aspects,
    // САМ снимок, а не новый объект `{aspects, contracts}`: индекс привязок интерпретатора — мемо по
    // объекту реестра области (`indexOf` в `expr/eval.ts`), и свежий объект на каждую операцию
    // пересобирал бы индекс на каждом `class` каждой записи. Снимок структурно и есть эта пара.
    reg,
    relations: input.relations,
    aggVia: input.aggVia,
    sensitivity: input.sensitivity,
    touched: input.touched,
    deref: input.deref,
  };
}

/**
 * Все узлы E-позиций правил — `when`, `params.value` (`default`), `params.set.value` (`on_enter_class`):
 * третьего места, где правило несёт выражение, у каталога нет (тот же перечень, что у
 * `ruleExprSitesOf` валидатора). Обход — по всем формам с поддеревом: `op` (включая `if`) и три
 * календарные формы; у `deref` поддерева нет (адрес — имя, а не выражение).
 */
function* ruleExprNodes(rules: readonly RuleDefinition[]): Generator<ExprNode> {
  const stack: ExprNode[] = [];
  for (const rule of rules) {
    if (rule.when !== undefined) stack.push(rule.when);
    if (rule.template === 'default') stack.push(rule.params.value);
    if (rule.template === 'on_enter_class' && rule.params.set !== undefined) {
      stack.push(rule.params.set.value);
    }
  }
  while (stack.length > 0) {
    const node = stack.pop() as ExprNode;
    yield node;
    if ('op' in node) stack.push(...node.args);
    else if ('date_add' in node) stack.push(...node.date_add);
    else if ('date_diff' in node) stack.push(...node.date_diff);
    else if ('days_inclusive' in node) stack.push(...node.days_inclusive);
  }
}

/** Роли `has_relation` в E-позициях правил: по ним `relationFactsOf` решает, ходить ли в БД вообще. */
export function relationRolesUsed(rules: readonly RuleDefinition[]): Set<string> {
  const roles = new Set<string>();
  for (const node of ruleExprNodes(rules)) {
    if ('has_relation' in node) roles.add(node.has_relation.role);
  }
  return roles;
}

/**
 * Имена `{param}` в E-позициях правил: движок читает параметр (`RULE_PARAMS`) только когда его назвало
 * применимое правило (Р-И-18) — иначе каждая запись платила бы SELECT'ом по `user_settings` за валюту,
 * которой никто не спросил. Имя вне `RULE_PARAMS` сюда не доезжает: его отверг чекер (Р-К-24).
 */
export function ruleParamsUsed(rules: readonly RuleDefinition[]): Set<string> {
  const names = new Set<string>();
  for (const node of ruleExprNodes(rules)) {
    if ('param' in node) names.add(node.param);
  }
  return names;
}

/**
 * Состояние пачки, которое видит сборщик рёбер: виртуальные рёбра (`created`/`deleted`), узкий пре-пасс
 * `declaredDerivedFromTargets` и архивность строк, уже тронутых пачкой (`archivedOf` — `undefined`,
 * если пачка строку не трогала). Необязательные члены — расширение формы §1.5, а не замена: вызов без
 * пачки и вызов с одними рёбрами остаются законными.
 */
export type RelationBatchView = VirtualGraphEffects & {
  declaredDerivedFromTargets?: ReadonlySet<string>;
  archivedOf?: (entityId: string) => boolean | undefined;
};

/**
 * Входящие рёбра `$self` нужных ролей: БД ∪ объявленные пачкой − удалённые пачкой (Р-И-7).
 * `alive` — «источник не архивен»; считать его лениво нельзя — интерпретатор синхронный (Р-4).
 *
 * Архивность источника берётся из ПАЧКИ раньше, чем из БД: эффекты операций 1..N−1 пачки обязаны
 * быть видны операции N (договор `BatchState`), и пачка «архивировать блокер; тронуть цель» обязана
 * дать тот же вердикт, что те же операции по очереди. У виртуального ребра приоритет тот же:
 * источник, тронутый пачкой, — по пачке (созданный пачкой лежит там же), нетронутый — по строке БД.
 */
export async function relationFactsOf(
  tx: Tx,
  entityId: string,
  roles: ReadonlySet<string>,
  batch?: RelationBatchView,
): Promise<RelationFact[]> {
  if (roles.size === 0) return []; // ни одного запроса, если правила рёбер не читают
  const archivedIn = (sourceId: string): boolean | undefined => batch?.archivedOf?.(sourceId);
  const rows = await tx
    .select({ role: relations.role, sourceId: relations.sourceId, archived: entities.archived })
    .from(relations)
    .innerJoin(entities, eq(entities.id, relations.sourceId))
    .where(and(eq(relations.targetId, entityId), inArray(relations.role, [...roles])));
  const deleted = batch?.deleted ?? [];
  const live = rows
    .filter(
      (r) =>
        !deleted.some(
          (d) => d.sourceId === r.sourceId && d.targetId === entityId && d.role === r.role,
        ),
    )
    .map((r) => ({
      role: r.role,
      sourceId: r.sourceId,
      alive: !(archivedIn(r.sourceId) ?? r.archived),
    }));
  const virtual = (batch?.created ?? []).filter(
    (v) =>
      v.targetId === entityId &&
      roles.has(v.role) &&
      !live.some((f) => f.role === v.role && f.sourceId === v.sourceId),
  );
  // Источники виртуальных рёбер, которых пачка не трогала, — одним запросом и только если такие есть.
  const untouched = [
    ...new Set(virtual.map((v) => v.sourceId).filter((id) => archivedIn(id) === undefined)),
  ];
  const dbArchived = new Map<string, boolean>();
  if (untouched.length > 0) {
    const sources = await tx
      .select({ id: entities.id, archived: entities.archived })
      .from(entities)
      .where(inArray(entities.id, untouched));
    for (const row of sources) dbArchived.set(row.id, row.archived);
  }
  for (const v of virtual) {
    live.push({
      role: v.role,
      sourceId: v.sourceId,
      alive: !(archivedIn(v.sourceId) ?? dbArchived.get(v.sourceId) ?? false),
    });
  }
  // Узкий пре-пасс пачки (`declaredDerivedFromTargets`, `BatchState` исполнителя): связи, объявленные
  // ЛЮБОЙ операцией, в том числе ещё не подготовленной, — пачка атомарна, и правило легитимируется
  // связью независимо от её позиции. Источник такой связи ещё не известен (операция не подготовлена),
  // поэтому факт — «живое ребро роли»; задача 4 заменит узкий набор общим списком объявленных.
  if (
    batch?.declaredDerivedFromTargets?.has(entityId) === true &&
    roles.has(ROLE_INSTANCE_OF) &&
    !live.some((f) => f.role === ROLE_INSTANCE_OF)
  ) {
    live.push({ role: ROLE_INSTANCE_OF, sourceId: entityId, alive: true });
  }
  return live;
}
