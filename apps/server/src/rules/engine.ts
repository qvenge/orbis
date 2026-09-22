// apps/server/src/rules/engine.ts
/**
 * ДВИЖОК КАТАЛОГА ПРАВИЛ C/T (§Б4-2, §Б4-3) — исполнитель четырёх шаблонов записи сущности по строкам
 * реестра: `requires_when`/`forbidden_when` (C — ограничения, стадия 4 исполнителя) и
 * `on_enter_class`/`default` (T — переходы, до стадии 2). Движок не знает ни одного аспекта по имени:
 * встроенные строки и строки владельца он исполняет одинаково, и это и есть обещание §А7-2 «инвариант —
 * декларацией, а не кодом».
 *
 * Врезан в исполнитель на ТРЁХ путях записи (create / update / attach). С задачи 4 он — ЕДИНСТВЕННЫЙ
 * исполнитель двух доменных инвариантов §А7-2: системные строки `builtin-rules.ts` (financial —
 * `requires_when`/`forbidden_when`, task — `on_enter_class`) заменили код, стоявший рядом с движком
 * на время двойной проверки (Р-К-18); корпус близнецов — `registry/invariants-golden.test.ts`.
 *
 * `unique_among` входит в род `constraint`, но исполняется с задачи 12 (РЧ-3-2): встреченное включённое
 * правило этого шаблона — отказ `RULE_TEMPLATE_UNSUPPORTED`, а не пропуск. Правило, которое нельзя
 * исполнить, молчать не должно (Р-И-13).
 */
import {
  type BindingIndex,
  entityClassOf,
  type GraphId,
  type RuleCarrier,
  type RuleDefinition,
} from '@orbis/shared';
import { type ExprScalar, propertyNamesInExpr } from '@orbis/shared/expr';
import { defaultCurrencyOf } from '../budget/binding';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import type { BatchState } from '../executor/executor';
import { carrierAspects, type EntityState, type PropsPatch } from '../executor/props';
import type { MutationMechanism } from '../executor/types';
import { type ExprEvalScope, evalExpr, present } from '../expr/eval';
import { ownerTimeZone, todayInTimeZone } from '../query/context';
import type { RegistrySnapshot } from '../registry/load';
import { effectiveRuleScope, rulesOf } from '../registry/rules';
import { bindingsOf } from '../subscriptions/budget';
import {
  CORE_PROJECTION,
  type EntityScopeInput,
  entityEvalScope,
  relationFactsOf,
  relationRolesUsed,
  ruleParamsUsed,
} from './scope';

export interface RuleWriteInput {
  ctx: {
    tx: Tx;
    registry: RegistrySnapshot;
    graphId: GraphId;
    clock: () => Date;
    mechanism: MutationMechanism;
    internalUndo: boolean;
  };
  entityId: string;
  before: EntityState;
  /** Состояние ПОСЛЕ патча; T-правила мутируют его `props` на месте. */
  state: EntityState;
  patch: PropsPatch;
  /** Колонки ядра; `updatedAt` — ТОТ штамп, что запишется этой операцией (Р-И-3). */
  core: EntityScopeInput['core'];
  batch?: BatchState;
  /**
   * Только правка БЕЗ свойств (`entity_update` ядра, рулинг 3-4): изменённые поля ядра
   * (`coreFieldsChanged`). Заданное поле сужает C-правила до тех, чей набор чтения его пересекает;
   * отсутствие — все применимые (правка свойств, create, attach). Необязательный член — расширение
   * формы §1.5, прежние вызовы законны.
   */
  touchedCore?: ReadonlySet<string>;
}

type Applicable = { rule: RuleDefinition; carrier: RuleCarrier };
type EnterRule = Extract<RuleDefinition, { template: 'on_enter_class' }>;
type EnterEvent = EnterRule['params']['enter'];

const TRANSITION_TEMPLATES: ReadonlySet<string> = new Set(['on_enter_class', 'default']);
const CONSTRAINT_TEMPLATES: ReadonlySet<string> = new Set([
  'requires_when',
  'forbidden_when',
  'unique_among',
]);

/**
 * Применимые правила записи (Р-И-13): включённые, шаблон своего рода, область подходит записи.
 * Область `{contract}` формой принимается, а исполняется в V2 (Р-25): встреченное включённое правило
 * такой области на записи-члене контракта — ОТКАЗ, а не пропуск; правило, которое нельзя применить,
 * молчать не должно. На нечлене оно молчит законно: область его не касается.
 *
 * Область `{role}` у шаблона записи (C/T) — тоже отказ `RULE_SCOPE_UNSUPPORTED`: валидатор задачи 1
 * такую пару принимает (ступени области и носителя смотрят каждая своё), а у записи СУЩНОСТИ роли нет
 * — роль описывает ребро. Какой записи правило «касалось бы», решает его НОСИТЕЛЬ — строка, в которой
 * оно написано: аспект стоит на записи либо свойство на ней есть или его несёт её аспект (та же мерка,
 * что у области `{property}`). Носитель-роль у C/T законным путём недостижим (`RULE_TEMPLATE_CARRIER`
 * задачи 1); доедь он ручной строкой — отказ при первой же встрече на любой записи: касательства
 * такой строки к записи не определить, а молчать ей нельзя.
 */
export function applicableRules(
  reg: RegistrySnapshot,
  kind: 'transition' | 'constraint',
  state: EntityState,
): readonly Applicable[] {
  const family = kind === 'transition' ? TRANSITION_TEMPLATES : CONSTRAINT_TEMPLATES;
  const out: Applicable[] = [];
  for (const { rule, carrier } of rulesOf(reg)) {
    if (!rule.enabled || !family.has(rule.template)) continue;
    const scope = effectiveRuleScope(rule, carrier);
    if ('aspect' in scope) {
      if (!state.aspects.includes(scope.aspect)) continue;
    } else if ('property' in scope) {
      const carriers = carrierAspects(reg, scope.property);
      if (!(scope.property in state.props) && !carriers.some((a) => state.aspects.includes(a))) {
        continue;
      }
    } else if ('role' in scope) {
      if (!carrierTouches(reg, carrier, state)) continue;
      throw new ExecError(
        'VALIDATION',
        `область правила «роль» у шаблона записи не исполняется: правило «${rule.id}» описывает ребро, а не запись`,
        { reason: 'RULE_SCOPE_UNSUPPORTED', rule: rule.id, role: scope.role },
      );
    } else if (
      bindingsOf(reg)
        .byContract(scope.contract)
        .some((b) => state.aspects.includes(b.aspectId))
    ) {
      throw new ExecError(
        'VALIDATION',
        `область правила «контракт» исполняется в V2 (Р-25): правило «${rule.id}» применить нечем`,
        { reason: 'RULE_SCOPE_UNSUPPORTED', rule: rule.id, contract: scope.contract },
      );
    } else {
      continue;
    }
    out.push({ rule, carrier });
  }
  return out;
}

/** Касается ли носитель правила записи (для области, которая сама этого не решает, — `{role}`). */
function carrierTouches(reg: RegistrySnapshot, carrier: RuleCarrier, state: EntityState): boolean {
  if (carrier.kind === 'aspect') return state.aspects.includes(carrier.id);
  if (carrier.kind === 'property') {
    return (
      carrier.id in state.props ||
      carrierAspects(reg, carrier.id).some((a) => state.aspects.includes(a))
    );
  }
  return true;
}

/**
 * День и зона владельца — МЕМО по транзакции: правила спрашивают их на каждой операции, а импорт в
 * сотни операций платил бы SELECT'ом по `user_settings` за каждую. «Сегодня» — от часов операции, а не
 * от `new Date()`: вердикт правила обязан быть детерминированным вместе со всей транзакцией.
 */
const CLOCK_BY_TX = new WeakMap<object, Promise<{ today: string; timeZone: string }>>();
function ownerClockOf(ctx: RuleWriteInput['ctx']): Promise<{ today: string; timeZone: string }> {
  let cached = CLOCK_BY_TX.get(ctx.tx);
  if (cached === undefined) {
    cached = ownerTimeZone(ctx.tx, ctx.graphId).then((timeZone) => ({
      timeZone,
      today: todayInTimeZone(timeZone, ctx.clock()),
    }));
    CLOCK_BY_TX.set(ctx.tx, cached);
  }
  return cached;
}

/**
 * Параметры движка (`RULE_PARAMS`) — ЛЕНИВО (Р-И-18): читается только названный правилом параметр.
 * Имя вне `RULE_PARAMS` сюда не доезжает — его отверг чекер задачи 1 (Р-К-24); а доедь оно ручной
 * порчей строки, интерпретатор ответит `EXPR_SCOPE` («параметра нет в области»), а не пустотой.
 */
async function ruleParamsOf(
  input: RuleWriteInput,
  rules: readonly RuleDefinition[],
): Promise<Record<string, ExprScalar>> {
  const params: Record<string, ExprScalar> = {};
  if (ruleParamsUsed(rules).has('default_currency')) {
    params.default_currency = await defaultCurrencyOf(input.ctx.tx, input.ctx.graphId);
  }
  return params;
}

/**
 * Одна оценочная область на вызов движка: роли `has_relation` → рёбра (в БД — только если правила их
 * читают) → ленивые параметры → день и зона владельца. Все `when` и значения одного вызова считаются
 * над ОДНИМ состоянием «после патча»: T-правило не видит правок соседнего T-правила — это и делает
 * исход независимым от порядка обхода (§Б4 конфлюэнтность).
 */
async function writeScope(
  input: RuleWriteInput,
  rules: readonly RuleDefinition[],
): Promise<ExprEvalScope> {
  const { tx, registry, graphId } = input.ctx;
  const batch = input.batch;
  const relations = await relationFactsOf(
    tx,
    input.entityId,
    relationRolesUsed(rules),
    batch === undefined
      ? undefined
      : {
          created: batch.createdRelations,
          deleted: batch.deletedRelations,
          declaredDerivedFromTargets: batch.declaredDerivedFromTargets,
          // Строки, тронутые пачкой (create/update/attach кладут их в `BatchState.entities`).
          archivedOf: (id) => batch.entities.get(id)?.archived,
        },
  );
  const params = await ruleParamsOf(input, rules);
  const { today, timeZone } = await ownerClockOf(input.ctx);
  return entityEvalScope({
    reg: registry,
    state: input.state,
    core: input.core,
    today,
    timeZone,
    relations,
    params,
    owner: graphId,
  });
}

/** `when` отсутствует — правило безусловно; иначе срабатывает только ИСТИНА (отсутствие — ложь, §Б3-4). */
function whenHolds(rule: RuleDefinition, scope: ExprEvalScope): boolean {
  return rule.when === undefined || evalExpr(rule.when, scope) === true;
}

function refusalText(
  rule: Extract<RuleDefinition, { template: 'requires_when' | 'forbidden_when' }>,
): string {
  return rule.template === 'requires_when'
    ? `правило «${rule.id}»: свойство ${rule.params.property} обязательно, когда выполнено условие правила (§Б4-3)`
    : `правило «${rule.id}»: свойство ${rule.params.property} запрещено, когда выполнено условие правила (§Б4-3)`;
}

/**
 * C-правила (§Б4-3): `requires_when` — условие истинно И свойства нет → отказ; `forbidden_when` —
 * условие истинно И свойство есть → отказ. Отказ — `INVARIANT` с `details.invariant = rule.id` (Р-К-1):
 * близнецы кода и строки сида совпадают по нему без второго словаря.
 */
export async function assertConstraintRules(input: RuleWriteInput): Promise<void> {
  // Порядок — по (носитель, id правила), как у T: при двух нарушенных правилах на разных носителях
  // `details.invariant` отказа обязан быть одним и тем же при любом порядке строк реестра, а порядок
  // `rulesOf` — это порядок строк снимка, который внутри половины реестра не гарантирован.
  const rules = [...applicableRules(input.ctx.registry, 'constraint', input.state)].sort(
    byCarrierThenId,
  );
  // Отнесение к откату — по ЭКЗЕМПЛЯРУ, а не по шаблону (Р-И-2, рамка §1: льгота несимметрична):
  // `undo: 'skip'` пропускает откат, чьё восстановленное состояние правило нарушает; `check` — нет.
  // Правка без свойств (рулинг 3-4) — только правила, чей набор чтения пересекает изменённые поля ядра:
  // состояние свойств не менялось, и вердикт остальных правил тот же, что до правки.
  const touchedCore = input.touchedCore;
  const live = rules.filter(
    ({ rule }) =>
      (!input.ctx.internalUndo || rule.undo === 'check') &&
      (touchedCore === undefined || [...ruleReadSet(rule)].some((p) => touchedCore.has(p))),
  );
  if (live.length === 0) return;
  const scope = await writeScope(
    input,
    live.map((r) => r.rule),
  );
  for (const { rule, carrier } of live) {
    if (rule.template === 'unique_among') {
      // Ветку и строку сида кладёт задача 12; до неё уникальность держит `assertEnvelopeUnique`.
      // Включённое правило этого шаблона в снимке — дефект, а не повод промолчать (fail-closed).
      throw new ExecError('VALIDATION', `шаблон «${rule.template}» исполняется с задачи 12`, {
        reason: 'RULE_TEMPLATE_UNSUPPORTED',
        rule: rule.id,
        template: rule.template,
      });
    }
    if (rule.template !== 'requires_when' && rule.template !== 'forbidden_when') continue;
    if (!whenHolds(rule, scope)) continue;
    const has = present(input.state.props[rule.params.property]);
    if (rule.template === 'requires_when' ? has : !has) continue;
    throw new ExecError('INVARIANT', refusalText(rule), {
      invariant: rule.id,
      rule_template: rule.template,
      property: rule.params.property,
      scope: effectiveRuleScope(rule, carrier),
    });
  }
}

/**
 * НАБОР ЧТЕНИЯ C-правила — свойства (и core-проекции), от которых зависит его вердикт: имена в `when`
 * (`propertyNamesInExpr` — `{prop}`, `{has}`, база `{deref}`) плюс параметр-свойство шаблона. У
 * `unique_among` — его набор и НЕЯВНЫЙ `orbis/archived`: уникальность «среди неархивных» (задача 12),
 * и разархивация возвращает запись в множество, где дубль возможен. По набору отбираются правила
 * правки без свойств: правило, которое ядро не читает, её вердикта не меняет.
 */
function ruleReadSet(rule: RuleDefinition): Set<string> {
  const names = rule.when === undefined ? new Set<string>() : propertyNamesInExpr(rule.when);
  if (rule.template === 'requires_when' || rule.template === 'forbidden_when') {
    names.add(rule.params.property);
  } else if (rule.template === 'unique_among') {
    for (const p of rule.params.properties) names.add(p);
    names.add(CORE_PROJECTION.archived);
  }
  return names;
}

/**
 * Событие входа — две формы (Р-И-37): класс слота контракта либо ЗНАЧЕНИЕ свойства (состояния, у
 * которого своего класса нет, — `waiting` внутри класса `active`).
 *
 * `slot` формы `{contract, slot, in}` здесь ИНФОРМАЦИОННЫЙ: класс записи под контрактом один
 * (`entityClassOf`, §Б2-2), и слот-статус, по которому он считается, у каждого встроенного контракта
 * ровно один; валидатор задачи 1 требует, чтобы названный слот был статусом (`not_status`).
 * Контракт с ДВУМЯ слотами-статусами — именованный остаток: схема контракта его не запрещает, и
 * событие такого контракта смотрело бы на класс первого слота с картой, а не на названный.
 */
function enteredBy(
  enter: EnterEvent,
  state: EntityState,
  idx: BindingIndex,
  rank: (aspectId: string) => number,
): boolean {
  if ('contract' in enter) {
    const cls = entityClassOf(idx, state, enter.contract, rank);
    return cls !== null && enter.in.includes(cls);
  }
  const raw = state.props[enter.property];
  return present(raw) && enter.in.some((v) => v === raw);
}

/** Порядок обхода — по (носитель, id правила): детерминированность важнее удобства (§Б4 конфлюэнтность). */
function byCarrierThenId(a: Applicable, b: Applicable): number {
  if (a.carrier.id !== b.carrier.id) return a.carrier.id < b.carrier.id ? -1 : 1;
  return a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0;
}

/**
 * T-правила (§Б4-3): `on_enter_class` и `default`. Под внутренним undo НЕ исполняются вовсе — как
 * и снятый задачей 4 код штампа завершения (ветка `internalUndo === undefined` в
 * `prepareEntityUpdate`): откат
 * восстанавливает зафиксированное состояние, и «поправить» его значило бы разойтись с журналом (Р-И-2).
 *
 * ТРИ ФАЗЫ, И ПОРЯДОК ФАЗ — РЕШЕНИЕ, а не удобство (рулинг 1-3 координатора):
 *  1) `on_leave.unset` покидаемых классов;
 *  2) `set` входа;
 *  3) `default` — заполняет то, что осталось отсутствующим.
 * Почему уход раньше входа: ключ `RULE_CONFLICT` (задача 1) не ловит пару «set при входе в A» +
 * «unset при уходе из B» ОДНОГО свойства — обе законно срабатывают на одном переходе B→A. Исход
 * такого перехода обязан быть одним при любом порядке строк реестра, и победить должен вход: запись
 * ПРИШЛА в A, и её штамп — факт этого перехода, а снятие — всего лишь уборка за B. Обход единым
 * списком по (носитель, id) отдал бы победу тому, чей id лексикографически позже. Почему `default`
 * последним: он «значение, когда его нет», и решать это до переходов значило бы опередить `set` входа
 * (тот не перетирает присутствующее, РЧ-3-3) либо дать уходу стереть только что поставленное умолчание.
 *
 * События (было/стало) снимаются для ВСЕХ правил до первой правки — фазы не влияют на то, какие
 * правила сработали; `when` и значения считаются над одним состоянием «после патча» (`writeScope`).
 *
 * ИМЕНОВАННЫЙ ОСТАТОК — снятие аспекта-носителя. Правило с областью-аспект применимо к состоянию
 * ПОСЛЕ патча, поэтому при `aspects.detach` носителя его `on_leave` (и C-правила того же носителя)
 * не исполняются, а значения по Р9 detach переживают. Паритет со снятым кодом: `applyTaskCompletion`
 * гейтился тем же `state.aspects.includes('orbis/task')`; область снята — правило её больше не
 * касается (задача 14 знает это для `waiting_for`).
 */
export async function applyTransitionRules(input: RuleWriteInput): Promise<void> {
  if (input.ctx.internalUndo) return;
  const rules = applicableRules(input.ctx.registry, 'transition', input.state);
  if (rules.length === 0) return;
  const ordered = [...rules].sort(byCarrierThenId);
  const reg = input.ctx.registry;
  const idx = bindingsOf(reg);
  const rank = (id: string) => reg.aspects.get(id)?.rank ?? Number.MAX_SAFE_INTEGER;
  const scope = await writeScope(
    input,
    ordered.map((r) => r.rule),
  );
  const leaving: EnterRule[] = [];
  const entering: EnterRule[] = [];
  const defaults: Extract<RuleDefinition, { template: 'default' }>[] = [];
  for (const { rule } of ordered) {
    if (rule.template === 'default') {
      defaults.push(rule);
      continue;
    }
    if (rule.template !== 'on_enter_class') continue;
    const was = enteredBy(rule.params.enter, input.before, idx, rank);
    const now = enteredBy(rule.params.enter, input.state, idx, rank);
    if (!was && now) entering.push(rule);
    else if (was && !now) leaving.push(rule);
  }
  // Фаза 1 — уход.
  for (const rule of leaving) {
    for (const propertyId of rule.params.on_leave?.unset ?? [])
      delete input.state.props[propertyId];
  }
  // Фаза 2 — вход.
  for (const rule of entering) {
    const set = rule.params.set;
    if (set === undefined || !whenHolds(rule, scope)) continue;
    // «Ещё не задано» — то же присутствие, что у `has` (РЧ-3-3): `undefined` и `null` — нет.
    // Значение, пришедшее патчем, правило не перетирает — ЕСЛИ уход другого класса (фаза 1) его
    // не снял. Снятый код штампа спрашивал `=== undefined`, и явный `null` во входе оставался до
    // стадии 2 (отказ `TYPE`); правило ставит на его место штамп — единственное расхождение
    // присутствия, закрытый список корпуса близнецов (`T_SET_NULL_IS_ABSENT`). Снятие уходом
    // смотрит на состояние, а не на патч: паритет со снятым кодом (он снимал `completed_at` при
    // уходе из done, что бы ни принёс патч).
    if (!present(input.state.props[set.property]))
      assignPresent(input.state, set.property, evalExpr(set.value, scope));
  }
  // Фаза 3 — умолчания. Применяются на ВСЕХ трёх путях, когда свойства нет после патча, — как
  // `normalizeEnvelopeCurrency` сегодня, а не только на create (§1.5).
  for (const rule of defaults) {
    if (present(input.state.props[rule.params.property])) continue;
    if (!whenHolds(rule, scope)) continue;
    assignPresent(input.state, rule.params.property, evalExpr(rule.params.value, scope));
  }
}

/**
 * Запись значения T-правила — только ПРИСУТСТВУЮЩЕГО (РЧ-3-3): выражение, отдавшее отсутствие
 * (`{prop}` пустого свойства), не «ставит null», а не ставит ничего — иначе в `props` лёг бы явный
 * `null`, которого по правилу присутствия нет, и следующая запись видела бы два разных «пусто».
 */
function assignPresent(state: EntityState, propertyId: string, value: unknown): void {
  if (present(value)) state.props[propertyId] = value;
}
