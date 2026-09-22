// apps/server/src/registry/rules.ts
/**
 * ВАЛИДАТОР ДЕКЛАРАЦИИ ПРАВИЛА (§Б4-1, §Б4-3) — НА ЗАПИСИ, не на чтении. Дом и порядок ступеней — по
 * `assertSubscription` (докблок subscriptions/registry.ts), и это не подражание: развилка та же.
 * `applyDeltas`/`loadRegistryRows` отказывают fail-closed на КАЖДОМ чтении реестра — проверка смысла там
 * заперла бы владельца снаружи собственного графа после пересева (Р-И-7 Б-1); на чтении — только ФОРМА.
 * `reg` — снимок-ПРОБА ПОСЛЕ правки, где это правило уже лежит на своей строке (Р-И-21): иначе «id занят»
 * и «два писателя одного события» спрашивались бы двумя разными способами.
 * КОЛОНКИ `rules` ЕЩЁ НЕТ (задача 2) — валидатор обязан существовать раньше хранения, иначе первая
 * посеянная строка легла бы непроверенной; поле читается структурно — сырым у валидатора (`rawRulesOf`) и
 * разобранным у читателей (`rulesFieldOf`).
 */
import {
  type RuleCarrier,
  type RuleDefinition,
  type RuleScope,
  type RuleTemplate,
  ruleDefinitionSchema,
} from '@orbis/shared';
import { SECOND_LANGUAGE } from '@orbis/shared/expr';
import { ExecError } from '../errors';
import type { RegistrySnapshot } from './load';

export type { RuleCarrier } from '@orbis/shared'; // Р-К-53: форма { kind: 'aspect'|'property'|'role'; id } объявлена в rule-type.ts (0c)
export interface RuleCheckScope {
  reg: RegistrySnapshot;
  carrier: RuleCarrier;
  systemSeed: boolean;
}

/** Событие `on_enter_class` — обе формы (Р-И-37): вход класса слота и вход значения свойства. */
type RuleEnterEvent = Extract<RuleDefinition, { template: 'on_enter_class' }>['params']['enter'];

/** Отказ формы: VALIDATION с ПРИЧИНОЙ в details — как у подписок (`bad()` subscriptions/registry.ts). */
function bad(
  reason: string,
  rule: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new ExecError('VALIDATION', message, { reason, rule, ...details });
}
/** Три словаря-носителя ОДНИМ обходом: состав и порядок у читателя и у валидатора обязаны совпасть. */
function* carrierRows(reg: RegistrySnapshot): Generator<{ carrier: RuleCarrier; row: unknown }> {
  for (const [kind, dict] of [
    ['aspect', reg.aspects],
    ['property', reg.properties],
    ['role', reg.roles],
  ] as const) {
    for (const [id, row] of dict) yield { carrier: { kind, id }, row };
  }
}
/**
 * СЫРОЙ массив правил строки — вход ВАЛИДАТОРА. Колонку `rules` заводит задача 2, до неё поля у строки нет,
 * поэтому читается оно структурно. Именно сырое: форму называет `assertRule` (`RULE_MALFORMED`), и читатель,
 * отфильтровавший неразобравшееся, сделал бы врезку слепой ровно к тому, что она обязана ловить.
 */
function rawRulesOf(row: unknown): readonly unknown[] {
  const v = (row as { rules?: unknown } | undefined)?.rules;
  return Array.isArray(v) ? v : [];
}
/**
 * РАЗОБРАННЫЕ правила строки — вход ЧИТАТЕЛЕЙ (`rulesOf` → конфликты, граф, `RULE_ID_TAKEN`).
 *
 * Разбор ОБЯЗАТЕЛЕН, а не косметика: у `enabled` и `undo` есть УМОЛЧАНИЯ схемы, а и `ruleConflictsOf`, и
 * ветка `'rule'` графа пропускают правило по `!rule.enabled` — на сырой input-форме (`enabled` отсутствует)
 * оба читателя молча пропускали бы КАЖДОЕ правило, и ни `RULE_CONFLICT`, ни `REGISTRY_CYCLE` не сработали
 * бы никогда.
 *
 * `safeParse`, а не `parse`: снимок-проба содержит и НЕГАТИВНЫЕ фикстуры (`RULE_FIXTURES`) и ручную порчу
 * строки, а читатель реестра не вправе бросать — fail-closed на чтении запер бы владельца снаружи
 * собственного графа (Р-И-7 Б-1). Неразобравшееся здесь ПРОПУСКАЕТСЯ, и потери нет: его ловит `assertRule`
 * формой раньше (ступень 2), а в БД оно не доедет — `load.ts` разбирает строку `.parse`'ом (задача 2).
 */
function rulesFieldOf(row: unknown): readonly RuleDefinition[] {
  const out: RuleDefinition[] = [];
  for (const raw of rawRulesOf(row)) {
    const parsed = ruleDefinitionSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
/**
 * ВСЕ правила снимка с носителями — МЕМО ПО СНИМКУ (образец `bindingsOf`, subscriptions/budget.ts): перечень
 * спрашивают на каждой ступени и на каждой сборке графа, а `effectiveRegistry` отдаёт кешированный объект —
 * новая версия реестра есть новый объект.
 */
const RULES_BY_SNAPSHOT = new WeakMap<
  object,
  readonly { rule: RuleDefinition; carrier: RuleCarrier }[]
>();
export function rulesOf(
  reg: RegistrySnapshot,
): readonly { rule: RuleDefinition; carrier: RuleCarrier }[] {
  const cached = RULES_BY_SNAPSHOT.get(reg);
  if (cached !== undefined) return cached;
  const out: { rule: RuleDefinition; carrier: RuleCarrier }[] = [];
  for (const { carrier, row } of carrierRows(reg)) {
    for (const rule of rulesFieldOf(row)) out.push({ rule, carrier });
  }
  RULES_BY_SNAPSHOT.set(reg, out);
  return out;
}
/** Умолчание области — строка-носитель (§Б4-1): правило без `scope` живёт там, где написано. */
export function effectiveRuleScope(rule: RuleDefinition, carrier: RuleCarrier): RuleScope {
  if (rule.scope !== undefined) return rule.scope;
  return carrier.kind === 'aspect'
    ? { aspect: carrier.id }
    : carrier.kind === 'property'
      ? { property: carrier.id }
      : { role: carrier.id };
}
/**
 * КАКИЕ НОСИТЕЛИ ЗАКОННЫ ДЛЯ ШАБЛОНА (§Б4-3): ролевые шаблоны описывают РЕБРО (их параметры — в
 * `role.constraints`), параметрические носители — АСПЕКТ (у него носимые свойства и опубликованные
 * величины), C/T — аспект либо свойство, `assign_level` — что угодно (он о ВЫЗОВЕ, а не о записи).
 */
const CARRIERS_BY_TEMPLATE: Readonly<Record<RuleTemplate, readonly RuleCarrier['kind'][]>> = {
  requires_when: ['aspect', 'property'],
  forbidden_when: ['aspect', 'property'],
  on_enter_class: ['aspect', 'property'],
  default: ['aspect', 'property'],
  unique_among: ['aspect', 'property'],
  target_max_incoming: ['role'],
  acyclic: ['role'],
  mirror_relation: ['role'],
  nearest_ancestor: ['aspect'],
  materialize: ['aspect'],
  rollover: ['aspect'],
  assign_level: ['aspect', 'property', 'role'],
};

/**
 * E-ПОЗИЦИИ по СЫРОМУ объекту — вход ступени (1), где схемы ещё нет и быть не должно: строка в E-позиции
 * схемой отвергается, и после разбора её уже не отличить от любой другой порчи формы. Перечень тот же,
 * что у `ruleExprSitesOf` после разбора: `when`, `params.value` (`default`), `params.set.value`
 * (`on_enter_class`) — третьего места, где правило несёт выражение, у каталога нет.
 */
function rawExprSites(raw: unknown): Array<{ path: string; value: unknown }> {
  const rec = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  const rule = rec(raw);
  if (rule === undefined) return [];
  const out: Array<{ path: string; value: unknown }> = [];
  if ('when' in rule) out.push({ path: 'when', value: rule.when });
  const params = rec(rule.params);
  if (params !== undefined && 'value' in params) {
    out.push({ path: 'params.value', value: params.value });
  }
  const set = rec(params?.set);
  if (set !== undefined && 'value' in set) out.push({ path: 'params.set.value', value: set.value });
  return out;
}

/**
 * ПОЛНАЯ ПРОВЕРКА ДЕКЛАРАЦИИ ПЕРЕД ЗАПИСЬЮ. Порядок — не косметика (Р-И-21): (1) строка в E-позиции —
 * ДО разбора формы; (2) форма; (3) тождество; (4) область резолвится; (5) шаблон против носителя;
 * (6) ссылки параметров — поимённо, без обхода дерева; (7) типы выражений в области правила — здесь же
 * гейт глубины E (`assertExprChecked`); (8) понижающий уровень называет актора; (9) два писателя одного
 * события. Круг «свойство → правило → свойство» — свойство ВСЕГО графа, его спрашивает врезка
 * `assertRulesOfRow` после валидатора.
 */
export function assertRule(raw: unknown, scope: RuleCheckScope): RuleDefinition {
  const { reg, carrier } = scope;
  const id =
    typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : '<без id>';
  // (1) Строка в E-позиции — ДО разбора формы: после него строки нет (zod её отверг), и владелец получил бы
  // «поле не разобралось» вместо «здесь язык E». Позиции берутся по СЫРОМУ объекту (`rawExprSites`).
  for (const site of rawExprSites(raw)) {
    if (typeof site.value === 'string') {
      throw new ExecError(
        SECOND_LANGUAGE,
        `${id}: в позиции ${site.path} ожидается выражение E, а не текст`,
        { rule: id, path: site.path },
      );
    }
  }
  const parsed = ruleDefinitionSchema.safeParse(raw); // (2) форма
  if (!parsed.success) {
    bad('RULE_MALFORMED', id, `декларация правила ${id} не разобрана`, {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const rule = parsed.data;
  // (3) Тождество: id — адрес правила в журнале, в «отключить» и в графе (§Б4-1), один на весь снимок
  // (система ∪ владелец). Проба уже содержит это правило, поэтому «занят» значит «их два».
  if (rulesOf(reg).filter((r) => r.rule.id === rule.id).length > 1) {
    bad('RULE_ID_TAKEN', rule.id, `правило с id «${rule.id}» в реестре уже есть`);
  }
  const s = effectiveRuleScope(rule, carrier); // (4) область
  const known =
    'aspect' in s
      ? reg.aspects.has(s.aspect)
      : 'property' in s
        ? reg.properties.has(s.property)
        : 'role' in s
          ? reg.roles.has(s.role)
          : reg.contracts.has(s.contract);
  if (!known)
    bad('RULE_SCOPE_UNKNOWN', rule.id, `области правила ${rule.id} нет в реестре`, { scope: s });
  if (!CARRIERS_BY_TEMPLATE[rule.template].includes(carrier.kind)) {
    // (5) носитель
    bad(
      'RULE_TEMPLATE_CARRIER',
      rule.id,
      `шаблон ${rule.template} не живёт на носителе рода ${carrier.kind}`,
      {
        template: rule.template,
        carrier: carrier.id,
        allowed: CARRIERS_BY_TEMPLATE[rule.template],
      },
    );
  }
  assertReferences(rule, scope); // (6)
  assertExprTypes(rule, scope); // (7)
  assertLevelScoped(rule); // (8)
  assertNoConflict(rule, reg); // (9)
  return rule;
}

/** Свойство реестра по id — либо `RULE_UNKNOWN_PROPERTY` с адресом. */
function propertyOf(reg: RegistrySnapshot, rule: RuleDefinition, id: string) {
  const def = reg.properties.get(id);
  if (def === undefined) {
    bad('RULE_UNKNOWN_PROPERTY', rule.id, `свойства ${id} нет в реестре`, { property: id });
  }
  return def;
}
function assertEnterEvent(
  reg: RegistrySnapshot,
  rule: RuleDefinition,
  enter: RuleEnterEvent,
): void {
  if ('property' in enter) {
    propertyOf(reg, rule, enter.property);
    return;
  }
  const c = reg.contracts.get(enter.contract);
  const slot = (c?.slots ?? []).find((x) => x.name === enter.slot);
  const classes = new Set((c?.classes ?? []).map((x) => x.key));
  if (c === undefined || slot === undefined || !enter.in.every((k) => classes.has(k))) {
    bad(
      'RULE_UNKNOWN_CONTRACT_SLOT',
      rule.id,
      `событие правила ${rule.id} адресует ${enter.contract}.${enter.slot} и классы ${enter.in.join(',')}`,
      { contract: enter.contract, slot: enter.slot, in: enter.in },
    );
  }
}
/**
 * (6) ССЫЛКИ ПАРАМЕТРОВ — поимённо по путям шаблона, без обхода дерева (принцип `assertReferences`
 * подписок): адрес параметра стоит на известном месте, и обход ради него был бы вторым входом дерева.
 * Свойства, которые правило ЧИТАЕТ в выражениях, называет чекер E на ступени (7) — со своим путём.
 */
function assertReferences(rule: RuleDefinition, { reg, carrier }: RuleCheckScope): void {
  switch (rule.template) {
    case 'requires_when':
    case 'forbidden_when':
    case 'default':
      propertyOf(reg, rule, rule.params.property);
      return;
    // `UNIQUE_ON_MANY` (свойство `cardinality: many`) — задача 12, вместе с движком шаблона.
    case 'unique_among':
      for (const p of rule.params.properties) propertyOf(reg, rule, p);
      return;
    case 'on_enter_class':
      assertEnterEvent(reg, rule, rule.params.enter);
      if (rule.params.set !== undefined) propertyOf(reg, rule, rule.params.set.property);
      for (const p of rule.params.on_leave?.unset ?? []) propertyOf(reg, rule, p);
      return;
    case 'nearest_ancestor':
      propertyOf(reg, rule, rule.params.targets.parent);
      propertyOf(reg, rule, rule.params.targets.root);
      return;
    case 'materialize':
      for (const p of rule.params.trigger_properties) propertyOf(reg, rule, p);
      for (const [aspectId, ids] of Object.entries(rule.params.inherit)) {
        if (!reg.aspects.has(aspectId)) {
          bad('RULE_SCOPE_UNKNOWN', rule.id, `аспекта ${aspectId} нет`, { aspect: aspectId });
        }
        for (const p of ids) propertyOf(reg, rule, p);
      }
      if (!reg.roles.has(rule.params.origin_role)) {
        bad('RULE_SCOPE_UNKNOWN', rule.id, `роли ${rule.params.origin_role} нет`, {
          role: rule.params.origin_role,
        });
      }
      return;
    case 'rollover': {
      // Словарь допустимого `carry.agg` — реестр `published` носителя (§Б5-5, `aspect.aggregations`):
      // второго списка «что можно переносить» не заводится.
      const published =
        carrier.kind === 'aspect' ? (reg.aspects.get(carrier.id)?.aggregations ?? {}) : {};
      if (published[rule.params.carry.agg]?.published !== true) {
        bad(
          'RULE_ROLLOVER_AGG_UNPUBLISHED',
          rule.id,
          `величина «${rule.params.carry.agg}» не опубликована аспектом ${carrier.id}`,
          { agg: rule.params.carry.agg, carrier: carrier.id },
        );
      }
      return;
    }
    default:
      return; // ролевые метки и assign_level параметров-ссылок не несут
  }
}
function assertExprTypes(_rule: RuleDefinition, _scope: RuleCheckScope): void {
  return;
}
function assertLevelScoped(_rule: RuleDefinition): void {
  return;
}
function assertNoConflict(_rule: RuleDefinition, _reg: RegistrySnapshot): void {
  return;
}
