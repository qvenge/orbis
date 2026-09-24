// apps/server/src/registry/rules.ts
/**
 * ВАЛИДАТОР ДЕКЛАРАЦИИ ПРАВИЛА (§Б4-1, §Б4-3) — НА ЗАПИСИ, не на чтении. Дом и порядок ступеней — по
 * `assertSubscription` (докблок subscriptions/registry.ts), и это не подражание: развилка та же.
 * `applyDeltas`/`loadRegistryRows` отказывают fail-closed на КАЖДОМ чтении реестра — проверка смысла там
 * заперла бы владельца снаружи собственного графа после пересева (Р-И-7 Б-1); на чтении — только ФОРМА.
 * `reg` — снимок-ПРОБА ПОСЛЕ правки, где это правило уже лежит на своей строке (Р-И-21): иначе «id занят»
 * и «два писателя одного события» спрашивались бы двумя разными способами.
 * Колонка `rules` — с 0022 (задача 2); валидатор заведён РАНЬШЕ хранения, чтобы первая посеянная строка
 * не легла непроверенной. Поле читается структурно — сырым у валидатора (`rawRulesOf`) и разобранным у
 * читателей (`rulesFieldOf`): снимок-проба несёт и строки из базы, уже разобранные `load.ts`, и сырой вход
 * тула или фикстуры, где форма правила ещё не проверена.
 */
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  RULE_PARAMS,
  type RuleCarrier,
  type RuleDefinition,
  type RuleScope,
  type RuleTemplate,
  ruleDefinitionSchema,
} from '@orbis/shared';
import {
  EXPR_TYPE,
  type ExprScope,
  type ExprType,
  exprTypeOfKind,
  propertyNamesInExpr,
  SECOND_LANGUAGE,
} from '@orbis/shared/expr';
import { ExecError } from '../errors';
import { assertExprChecked } from '../expr/check';
import type { ExprSite } from '../subscriptions/registry';
import { assertAcyclicGraph, dependencyGraph } from './deps-graph';
import type { RegistrySnapshot } from './load';
import { validateEntityProps } from './validate-props';

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
 * СЫРОЙ массив правил строки — вход ВАЛИДАТОРА. Колонка `rules` есть с 0022 (задача 2), но читается поле
 * структурно: снимок-проба несёт и сырой вход тула или фикстуры, у которого поля может не быть вовсе. Именно
 * сырое: форму называет `assertRule` (`RULE_MALFORMED`), и читатель, отфильтровавший неразобравшееся, сделал
 * бы врезку слепой ровно к тому, что она обязана ловить.
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
/**
 * Род `constraint` каталога (§Б4-3, C — ограничения записи): кортеж один на движок (`rules/engine.ts`
 * выводит из него тип диспетчера) и на границу C-6 валидатора ниже.
 */
export const CONSTRAINT_TEMPLATE_LIST = [
  'requires_when',
  'forbidden_when',
  'unique_among',
] as const;

/** Шаблоны ЗАПИСИ сущности (C и T) — те, чьи параметры и область движок читает по `state.props`. */
const WRITE_TEMPLATES: ReadonlySet<string> = new Set([
  ...CONSTRAINT_TEMPLATE_LIST,
  'on_enter_class',
  'default',
]);

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
 * ДО разбора формы; (2) форма; (3) тождество; (4) область резолвится; (4а) носитель и область не поглощены
 * слиянием; (5) шаблон против носителя; (6) ссылки параметров — поимённо, без обхода дерева (адреса
 * шаблонов записи — только `props`); (7) типы выражений в области правила — здесь же гейт глубины E
 * (`assertExprChecked`), адреса поглощённых и роли `has_relation`; (7а) литералы значения T-правила — по
 * схеме свойства; (8) понижающий уровень называет актора; (9) два писателя одного
 * события; (10) у правила ВЛАДЕЛЬЦА — граница C-6 (ограничение не читает пользовательские рёбра). Круг «свойство → правило → свойство» — свойство ВСЕГО графа, его спрашивает врезка
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
  // (4а) Носитель и область — не поглощённые слиянием (финал Б-2 E-3 (б), `refuseMerged`).
  if (carrier.kind === 'property') refuseMerged(reg, rule, carrier.id, 'носитель');
  if ('property' in s) refuseMerged(reg, rule, s.property, 'область');
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
  // `unique_among` уникален СРЕДИ носителей (§Б4-3): множество, внутри которого набор уникален, задаёт
  // аспект, и правило без области-аспекта искало бы дубль среди всех записей владельца. Носитель-свойство
  // законен (таблица выше), но область тогда обязана быть названа явно — `scope: {aspect}` (РЧ-12-3).
  if (rule.template === 'unique_among' && !('aspect' in s)) {
    bad(
      'RULE_TEMPLATE_CARRIER',
      rule.id,
      `правилу «${rule.id}» нужна область-аспект: ${rule.template} уникален СРЕДИ носителей (§Б4-3)`,
      { template: rule.template, scope: s },
    );
  }
  // `when` у `unique_among` отвергается (рулинг 12-3): §Б4-3 — функциональная зависимость «среди
  // неархивных владельца», а условие сделало бы вердикт зависимым от порядка записей (запись, где
  // условие ложно, занимает набор; где истинно — упирается). Подмножество выражается областью-аспектом.
  // Причина своя, `RULE_WHEN_UNSUPPORTED`: ни одна из прежних не про «условие не допускается шаблоном».
  if (rule.template === 'unique_among' && rule.when !== undefined) {
    bad(
      'RULE_WHEN_UNSUPPORTED',
      rule.id,
      `правило «${rule.id}»: у ${rule.template} условия when нет — набор уникален среди ВСЕХ неархивных записей области, подмножество задаётся аспектом-областью (§Б4-3)`,
      { template: rule.template },
    );
  }
  assertReferences(rule, scope); // (6)
  assertExprTypes(rule, scope); // (7)
  assertValueLiterals(rule, reg); // (7а)
  assertLevelScoped(rule); // (8)
  assertNoConflict(rule, reg); // (9)
  if (!scope.systemSeed) assertRelationReadsGuarded(rule, reg); // (10)
  return rule;
}

/**
 * (10) ГРАНИЦА C-6 — ТОЛЬКО У ПРАВИЛ ВЛАДЕЛЬЦА. Ограничение (род `constraint`) может читать рёбра своей
 * записи узлом `has_relation`, а правила записи спрашивает только запись САМОЙ сущности
 * (create/update/attach): `relation_create`/`relation_delete` C-правила концов не перепроверяют
 * (`executor/relations.ts`, докблок `assertRoleConstraints`). Ребро роли, которую ставит и снимает
 * сам владелец (`created_by` не `system`), меняло бы вердикт конца мимо проверки — запись оставалась бы
 * нарушенной до следующей своей правки и там «застревала» бы отказом.
 *
 * Выбран ОТКАЗ при записи, а не перепроверка на рёберных тулах: перепроверка — это вызов движка правил
 * по двум концам внутри рёберных стадий (новая стадия исполнителя, её замки и её цена на каждом ребре),
 * а отказ закрывает дыру целиком там, где она открывалась, — у писателя правил владельца (задача 16).
 * Системную строку граница не касается: `financial_recurring_requires_recurrence` читает `instance-of`
 * (`created_by: system`), пользовательский путь к ребру закрыт гейтом с обеих сторон, а сид —
 * `systemSeed: true`. Переходы и `assign_level` рёбра читать МОГУТ: они не делают запись нарушенной —
 * переход сработает на следующем событии, уровень спрашивается на вызове. Роль, которой нет в реестре,
 * считается пользовательской (fail-closed); до этой ступени её не пропускает ступень (7) (`refuseUnknownRoles`).
 *
 * Флаг `alive` — тот же механизм с другой стороны, и отказ ему — при ЛЮБОЙ роли (финал Б-2, B1 M-2): он читает
 * архивность ДАЛЬНЕГО конца (`rules/scope.ts`, `alive: !archived`), а архивация конца C-правила ближнего не
 * перепроверяет — `entity_update {archived}` дальнего конца оставил бы ближнюю запись нарушенной так же, как
 * снятое ребро. Системные строки `alive` не несут.
 */
function assertRelationReadsGuarded(rule: RuleDefinition, reg: RegistrySnapshot): void {
  if (!(CONSTRAINT_TEMPLATE_LIST as readonly string[]).includes(rule.template)) return;
  const stack: unknown[] = [rule.when];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null) continue;
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    const rec = node as Record<string, unknown>;
    const h = rec.has_relation as { role?: unknown; alive?: unknown } | undefined;
    if (h !== undefined && typeof h.role === 'string') {
      const role = h.role;
      if (h.alive !== undefined) {
        bad(
          'RULE_RELATION_UNCHECKED',
          rule.id,
          `правило «${rule.id}» читает живость дальнего конца ребра роли «${role}» (has_relation.alive): архивацию конца правила записи ближнего не перепроверяют, и она оставила бы запись нарушенной до её следующей правки — такое условие выражается переходом или уровнем подтверждения, не ограничением`,
          { template: rule.template, role, alive: h.alive },
        );
      }
      if (reg.roles.get(role)?.constraints.created_by !== 'system') {
        bad(
          'RULE_RELATION_UNCHECKED',
          rule.id,
          `правило «${rule.id}» читает рёбра роли «${role}» (has_relation), а их ставит и снимает сам владелец: рёберные тулы правила записи концов не перепроверяют, и ребро оставило бы запись нарушенной до её следующей правки — такое условие выражается переходом или уровнем подтверждения, не ограничением`,
          { template: rule.template, role },
        );
      }
    }
    for (const child of Object.values(rec)) stack.push(child);
  }
}

/**
 * АДРЕС, ПОГЛОЩЁННЫЙ СЛИЯНИЕМ, — ОТКАЗ (финал Б-2 E-3 (б), рулинг Ф-Б2-32); мерка и форма — `assertImplements`
 * (`ops.ts`: `reason` + `cause: 'merged'`). Строка такого свойства жива (§А10-3), но значения переехали в
 * `merged_into`, а запись нового отвергает стадия 2 (`DEPRECATED`): правило, названное по нему, либо не
 * касается ни одной записи (носитель, область), либо требует значения, которое записать нельзя
 * (`requires_when`), либо читает вечное «нет» (`when`). Молчаливого перевода на преемника нет — выбор
 * `MERGE_ALREADY_MERGED`: владелец видит, во что слито, и называет цель сам. Снятие (`rule_remove`)
 * валидатор не проходит — выход открыт.
 */
function refuseMerged(reg: RegistrySnapshot, rule: RuleDefinition, id: string, at: string): void {
  // `?? null`: строка пробы из фикстуры может нести поле без умолчания схемы — отсутствие не есть слияние.
  const successor = reg.properties.get(id)?.mergedInto ?? null;
  if (successor === null) return;
  bad(
    'RULE_UNKNOWN_PROPERTY',
    rule.id,
    `свойство «${id}» поглощено слиянием (значения переехали в «${successor}») — в позиции «${at}» правила ${rule.id} назовите «${successor}»`,
    { property: id, cause: 'merged', successor, at },
  );
}
/** Свойство реестра по id — либо `RULE_UNKNOWN_PROPERTY` с адресом (нет в реестре или поглощено). */
function propertyOf(reg: RegistrySnapshot, rule: RuleDefinition, id: string) {
  const def = reg.properties.get(id);
  if (def === undefined) {
    bad('RULE_UNKNOWN_PROPERTY', rule.id, `свойства ${id} нет в реестре`, { property: id });
  }
  refuseMerged(reg, rule, id, 'параметр');
  return def;
}
/**
 * Свойство-АДРЕС параметра шаблона записи — только из `props` (§А1-3). Движок читает и пишет параметры
 * шаблонов по `state.props` (`rules/engine.ts`: присутствие C-параметра, набор `unique_among`, событие по
 * значению, цели `set`/`default`/`on_leave.unset`, область `{property}`), а core-проекция (`storage: 'core'` —
 * `orbis/title`, `orbis/archived`, `orbis/created_at`, `orbis/updated_at`) живёт колонкой записи, и в `props`
 * её не бывает (стадия 2 — `CORE_IN_PROPS`). Принятое такое правило молчало бы всегда или отказывало бы всегда.
 * В `when` и в значении core законна: её кладёт в область `entityEvalScope` (Р-И-3). Причина — та же, что у
 * отсутствующего свойства, с уточнением `cause` (приём `not_status` ниже): адреса в `props` у правила нет.
 */
function propsAddressOf(reg: RegistrySnapshot, rule: RuleDefinition, id: string) {
  const def = propertyOf(reg, rule, id);
  if (def.storage !== 'props') {
    bad(
      'RULE_UNKNOWN_PROPERTY',
      rule.id,
      `правило ${rule.id}: «${id}» — core-проекция (колонка записи), параметр правила адресует только свойства props (читать core можно в when и в значении)`,
      { property: id, cause: 'core', storage: def.storage },
    );
  }
  return def;
}
function assertEnterEvent(
  reg: RegistrySnapshot,
  rule: RuleDefinition,
  enter: RuleEnterEvent,
): void {
  if ('property' in enter) {
    propsAddressOf(reg, rule, enter.property);
    // Значения `in` формы по значению — по схеме свойства, той же функцией стадии 2, что литералы значения
    // (ступень (7а)) и шагов действий (`assertStepLiterals`): опечатка варианта (`'waitng'`) дала бы событие,
    // которое не наступает никогда, а правило — «успех» (финал Б-2, B1 M-6).
    for (const value of enter.in) {
      const violations = validateEntityProps(
        reg,
        { props: { [enter.property]: value }, aspects: [] },
        new Set(),
      );
      if (violations.length > 0) {
        bad(
          'RULE_VALUE_TYPE',
          rule.id,
          `событие правила ${rule.id}: значение ${JSON.stringify(value)} не проходит тип свойства ${enter.property}`,
          { property: enter.property, value, violations },
        );
      }
    }
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
  // Слот события обязан быть СТАТУСОМ: класс записи под контрактом считается по слоту-статусу
  // (§Б2-2, `entityClassOf`), и событие на прочем слоте движок молча считал бы по классу статуса —
  // адрес правила врал бы о том, что оно слушает. Код — тот же, что у соседних отказов адреса
  // события; уточнение — полем `cause` (приём `ops.ts`: `reason` + `cause`).
  if (!slot.status) {
    bad(
      'RULE_UNKNOWN_CONTRACT_SLOT',
      rule.id,
      `событие правила ${rule.id}: слот ${enter.contract}.${enter.slot} — не статус, класса у него нет`,
      { contract: enter.contract, slot: enter.slot, in: enter.in, cause: 'not_status' },
    );
  }
}
/**
 * (6) ССЫЛКИ ПАРАМЕТРОВ — поимённо по путям шаблона, без обхода дерева (принцип `assertReferences`
 * подписок): адрес параметра стоит на известном месте, и обход ради него был бы вторым входом дерева.
 * Свойства, которые правило ЧИТАЕТ в выражениях, называет чекер E на ступени (7) — со своим путём.
 */
function assertReferences(rule: RuleDefinition, { reg, carrier }: RuleCheckScope): void {
  // Область `{property}` правила ЗАПИСИ — тоже адрес по `props` (`ruleTouchesRecord`: `in state.props` либо
  // аспект-носитель); у core-проекции нет ни того, ни другого, и правило не касалось бы ни одной записи.
  const s = effectiveRuleScope(rule, carrier);
  if (WRITE_TEMPLATES.has(rule.template) && 'property' in s) propsAddressOf(reg, rule, s.property);
  switch (rule.template) {
    case 'requires_when':
    case 'forbidden_when':
    case 'default':
      propsAddressOf(reg, rule, rule.params.property);
      return;
    case 'unique_among':
      // СПИСОЧНОЕ свойство (`cardinality: many`) в наборе запрещено кодом §С1-2 `UNIQUE_ON_MANY`: у
      // списка нет «того же значения» — сравнение зависело бы от порядка элементов, то есть правило
      // либо не срабатывало бы никогда, либо срабатывало бы на перестановке. Статическая проверка по
      // типу — ступень ссылок, а не движка (перенос из задачи 12, рулинг Ф-Б2-14).
      // Свойство `kind: 'json'` набор ПРИНИМАЕТ (рулинг 12-1): его значение — ОДИН документ (и у
      // json-массива с `maxItems` тоже), равенство jsonb структурное и детерминированное — порядок
      // ключей не различает, порядок элементов массива — часть документа. `UNIQUE_ON_MANY` — только
      // про `cardinality: many`, где значение — список скаляров, а не документ.
      for (const p of rule.params.properties) {
        const def = propsAddressOf(reg, rule, p);
        if ('cardinality' in def.type && def.type.cardinality === 'many') {
          throw new ExecError(
            'UNIQUE_ON_MANY',
            `свойство «${p}» — список (cardinality: many), и «то же значение» у него не определено: набор уникальности его не принимает (§Б4-3)`,
            { rule: rule.id, property: p },
          );
        }
      }
      return;
    case 'on_enter_class':
      assertEnterEvent(reg, rule, rule.params.enter);
      if (rule.params.set !== undefined) propsAddressOf(reg, rule, rule.params.set.property);
      for (const p of rule.params.on_leave?.unset ?? []) propsAddressOf(reg, rule, p);
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
/**
 * Параметры движка правил, доступные `{param}` (Р-И-18). Словарь ЗАКРЫТ: набор имён задаёт движок, а не
 * декларация, и ссылка на чужое имя — `EXPR_TYPE` чекера с путём (Р-К-24), своего кода у неё нет.
 * Значение — тот же словарь `RULE_PARAMS` shared, что читает движок, а не второй список: два перечня
 * параметров разошлись бы на первом же новом имени, и чекер принимал бы `{param}`, которого движок не знает.
 */
export const RULE_PARAM_TYPES: Readonly<Record<string, ExprType>> = RULE_PARAMS;
/**
 * ОБЛАСТЬ ВЫРАЖЕНИЙ ПРАВИЛА — ДВА рода, а не три (Р-К-13): `assign_level` говорит о ВЫЗОВЕ, и ему видны
 * словарь фактов и сосед; ВСЕ остальные — правила ЗАПИСИ, и читают они только свою запись.
 *
 * Почему T-правила попадают в тот же род, что C, и с тем же флагом. `allowDeref:false` закрывает только
 * `deref`: `agg_via` чекер отказывает ИСКЛЮЧИТЕЛЬНО по `derefDenied` (ветка `agg_via` в `typeOf`), — то
 * есть T-область на `allowDeref:false` пропускала бы чтение опубликованной величины соседа, а Р-К-13
 * закрывает в C/T обоих. Довод один на оба рода: запись чужого состояния в своё через чёрный ход есть тот
 * же чёрный ход, что чтение его в предикате (§Б3-3). Код отказа при этом остаётся `DEREF_IN_CONSTRAINT`, и
 * слово «constraint» здесь читается как ПРАВИЛО ЗАПИСИ, а не как его C-половина: словарь §С1-2 закрыт, и
 * пятнадцатый код ради того же запрета с другой стороны не заводится.
 *
 * Контракта в области НЕТ ни у одного рода (Р-22): состояние цели читается `{prop}`, а `{slot}` здесь —
 * честный `EXPR_TYPE`.
 */
export function ruleExprScope(
  rule: RuleDefinition,
  _reg: RegistrySnapshot,
): Omit<ExprScope, 'reg'> {
  // `listSetsOnly` — у ОБОИХ родов: и `when`/значения записи (`rules/engine.ts`), и `assign_level`
  // (`policy/assign-level.ts`) исполняет TS-интерпретатор, у которого предикатного набора и `in_set` нет.
  if (rule.template === 'assign_level') {
    return { allowDeref: true, allowSensitivity: true, params: {}, listSetsOnly: true };
  }
  return { derefDenied: true, params: RULE_PARAM_TYPES, listSetsOnly: true };
}
/**
 * E-ПОЗИЦИИ ПРАВИЛА одним перечнем — аналог `exprSitesOf` подписок и по той же причине: обход нужен трижды
 * (строка в E-позиции, типы, зависимости графа). `path` несёт НОСИТЕЛЯ: в одном снимке правила лежат на
 * десятках строк, и «в позиции when» без адреса строки не адресует ничего.
 */
export function ruleExprSitesOf(
  rule: RuleDefinition,
  reg: RegistrySnapshot,
  carrier: RuleCarrier,
): readonly ExprSite[] {
  const scope = ruleExprScope(rule, reg);
  const head = `${carrier.kind}:${carrier.id}.rules.${rule.id}`;
  const out: ExprSite[] = [];
  if (rule.when !== undefined) {
    out.push({ path: `${head}.when`, value: rule.when, scope, expect: ['boolean'] });
  }
  const target =
    rule.template === 'default'
      ? { property: rule.params.property, value: rule.params.value, at: 'params.value' }
      : rule.template === 'on_enter_class' && rule.params.set !== undefined
        ? {
            property: rule.params.set.property,
            value: rule.params.set.value,
            at: 'params.set.value',
          }
        : undefined;
  if (target !== undefined) {
    const def = reg.properties.get(target.property);
    // json-свойству скалярного значения не назначить (§6.4) — отказ именной, а не «тип не сошёлся».
    if (def === undefined || def.type.kind === 'json') {
      bad(
        'RULE_VALUE_TYPE',
        rule.id,
        `свойству ${target.property} нельзя проставить значение выражением`,
        { property: target.property },
      );
    }
    out.push({
      path: `${head}.${target.at}`,
      value: target.value,
      scope,
      expect: [exprTypeOfKind(def.type.kind).kind],
    });
  }
  return out;
}
/**
 * Гейт E в позиции правила — отказ чекера получает АДРЕС ПРАВИЛА. Сам гейт кладёт в `details` только путь
 * ВНУТРИ выражения (`['args','0']`), а в снимке правила лежат на десятках строк: без `rule`, `template` и
 * `site` (носитель + позиция) «deref в args.0» не адресует ничего. Форма `DEREF_IN_CONSTRAINT`
 * `{path, rule?, template}` — договор докблока члена `ExecErrorCode` (0b), и держит её это место: код и
 * текст отказа не меняются, `details` только дополняются.
 */
function checkedAt(
  rule: RuleDefinition,
  reg: RegistrySnapshot,
  site: ExprSite,
  want: ExprType | undefined,
): ExprType {
  try {
    return assertExprChecked(site.value, { reg, ...site.scope }, want);
  } catch (e) {
    if (!(e instanceof ExecError)) throw e;
    throw new ExecError(e.code, e.message, {
      ...(e.details as Record<string, unknown> | undefined),
      rule: rule.id,
      template: rule.template,
      site: site.path,
    });
  }
}
/**
 * РОЛЬ `has_relation` — ПО РЕЕСТРУ (финал Б-2, B1 M-6). Чекер E роль не сверяет (у `ExprScope` словаря ролей
 * нет — ребро неизвестной роли просто «не найдётся»), и для правила это молчаливое «никогда»: T-правило и
 * `assign_level` с опечаткой в роли не сработали бы ни разу. Отказ и форма — те же, что у неизвестной
 * `origin_role` параметра движка (`RULE_SCOPE_UNKNOWN` с `role`, ступень (6)); путь — позиция правила.
 */
function refuseUnknownRoles(reg: RegistrySnapshot, rule: RuleDefinition, site: ExprSite): void {
  const stack: unknown[] = [site.value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null) continue;
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    const rec = node as Record<string, unknown>;
    const role = (rec.has_relation as { role?: unknown } | undefined)?.role;
    if (typeof role === 'string' && !reg.roles.has(role)) {
      bad('RULE_SCOPE_UNKNOWN', rule.id, `роли ${role} нет (has_relation в ${site.path})`, {
        role,
        site: site.path,
      });
    }
    for (const child of Object.values(rec)) stack.push(child);
  }
}
/**
 * (7) ТИПЫ ВЫРАЖЕНИЙ в области правила — через единственный гейт записи E (`assertExprChecked`): там же
 * кап глубины дерева и перевод `ExprCheckError` → `ExecError` тем же кодом (`DEREF_IN_CONSTRAINT`,
 * `EXPR_TYPE`, …). `when` — boolean; значение T-правила — типа свойства-цели.
 */
function assertExprTypes(rule: RuleDefinition, { reg, carrier }: RuleCheckScope): void {
  for (const site of ruleExprSitesOf(rule, reg, carrier)) {
    // Адрес поглощённого в выражении (`{prop}`, `{has}`, база `deref`, член `$touched` — Ф-Б2-26) — отказ
    // (финал Б-2 E-3 (б)): читать его — читать вечное «нет».
    for (const name of propertyNamesInExpr(site.value)) refuseMerged(reg, rule, name, site.path);
    refuseUnknownRoles(reg, rule, site);
    // У ОБЕИХ позиций правила `expect` — ровно один kind, и он же ожидаемый тип позиции: по нему
    // приводится корневой литерал (`{const:'0.00'}` в позиции decimal). Форма `ExprSite` при этом не
    // меняется — она общая с подписками, где `expect` перечисляет альтернативы и приведения не нужно.
    const want = site.expect?.length === 1 ? ({ kind: site.expect[0] } as ExprType) : undefined;
    const type = checkedAt(rule, reg, site, want);
    if (site.expect === null || site.expect.includes(type.kind)) continue;
    if (site.path.endsWith('.when')) {
      throw new ExecError(
        EXPR_TYPE,
        `${rule.id}: в позиции ${site.path} ожидался ${site.expect.join('|')}, получен ${type.kind}`,
        { rule: rule.id, path: site.path, expected: site.expect.join('|'), actual: type.kind },
      );
    }
    // Тип ЗНАЧЕНИЯ T-правила — свой словарный отказ: «ожидался decimal» без имени свойства читается как
    // ошибка чекера, а это ошибка ПРАВИЛА.
    bad(
      'RULE_VALUE_TYPE',
      rule.id,
      `значение правила ${rule.id} не сходится с типом свойства-цели`,
      {
        path: site.path,
        expected: site.expect.join('|'),
        actual: type.kind,
      },
    );
  }
}
/**
 * (7а) ЛИТЕРАЛЫ ЗНАЧЕНИЯ T-ПРАВИЛА — ПО СХЕМЕ СВОЙСТВА-ЦЕЛИ, той же функцией, что стадия 2 исполнителя
 * (`validateEntityProps`), — паритет с `assertStepLiterals` двери действий. Чекер E сверяет только РОД
 * (`select`/`ref` → text, дата-литерал приводится к timestamp), а варианты, формат, pattern и границы
 * decimal — нет: `default(task_status, 'Inbox')` принимался бы, а стадия 2 отказывала бы каждой записи, где
 * умолчание срабатывает. Литерал — то, что движок может записать БУКВАЛЬНО: корень значения и плечи `if`;
 * `null` движок не пишет (`assignPresent`). `touched` пуст: запись T-правила не входит в патч, и стадия 2
 * `DEPRECATED` по ней не спрашивает. Выражение (`{prop}`, `{param}`) судится родом — остаток.
 */
function literalLeaves(node: unknown, out: unknown[] = []): unknown[] {
  if (typeof node !== 'object' || node === null) return out;
  const rec = node as { const?: unknown; op?: unknown; args?: unknown[] };
  if ('const' in rec) {
    if (rec.const !== null) out.push(rec.const);
  } else if (rec.op === 'if' && Array.isArray(rec.args)) {
    literalLeaves(rec.args[1], out);
    literalLeaves(rec.args[2], out);
  }
  return out;
}
function assertValueLiterals(rule: RuleDefinition, reg: RegistrySnapshot): void {
  const target =
    rule.template === 'default'
      ? rule.params
      : rule.template === 'on_enter_class'
        ? rule.params.set
        : undefined;
  if (target === undefined) return;
  for (const literal of literalLeaves(target.value)) {
    const violations = validateEntityProps(
      reg,
      { props: { [target.property]: literal }, aspects: [] },
      new Set(),
    );
    if (violations.length > 0) {
      bad(
        'RULE_VALUE_TYPE',
        rule.id,
        `значение правила ${rule.id} не проходит тип свойства ${target.property}`,
        { property: target.property, violations },
      );
    }
  }
}
/**
 * ПОНИЖАЮЩЕЕ ПРАВИЛО ОБЯЗАНО НАЗЫВАТЬ АКТОРА (Р-27, В-2). «Понижающее» в Б-2 — ровно `level:'silent'`: ниже
 * любого ряда таблицы, дающего подтверждение, только «исполнить молча», а `show`/`discuss` против таблицы
 * могут быть и повышением (сложение — V2). Без актора правило сняло бы подтверждение и у AI, и у фона.
 */
function assertLevelScoped(rule: RuleDefinition): void {
  if (rule.template === 'assign_level' && rule.level === 'silent' && rule.actor === undefined) {
    bad(
      'RULE_LOWERING_UNSCOPED',
      rule.id,
      `правило ${rule.id} понижает уровень до «исполнить молча», не называя актора`,
      { level: rule.level },
    );
  }
}
/**
 * Головы ключа события — ПО ОДНОЙ НА КАЖДЫЙ элемент `in`, для ОБЕИХ форм (Р-И-37/Р-К-5): вход класса слота
 * и вход значения свойства. Событие — «класс (значение) до ∉ `in`, после ∈ `in`», то есть `in` — МНОЖЕСТВО, и
 * ключ по склеенному списку был бы ключом по записи, а не по смыслу: `['done','cancelled']` против
 * `['cancelled','done']` (перестановка) и `['done']` против `['done','cancelled']` (пересечение) — два писателя
 * на одном переходе `active→done`, которых такой ключ не видел, и движок молча выбрал бы победителя (§Б4,
 * Ф-Б2-15). Значение формы по значению печатается JSON'ом: `true` и `'true'` — разные значения свойства.
 *
 * Эквивалентности МЕЖДУ формами ключ не знает (финал Б-2, B1 M-1): вариант свойства, отнесённый к классу
 * (`task_status in ['done']`), и тот же класс по контракту (`completable.status in ['done']`) — два разных
 * ключа, и два писателя одного перехода проходят без отказа. Остаток — строка 110 реестра остатков Б-2.
 */
const enterHeads = (e: RuleEnterEvent): string[] =>
  'property' in e
    ? e.in.map((v) => `prop:${e.property}=${JSON.stringify(v)}`)
    : e.in.map((k) => `${e.contract}.${e.slot}=${k}`);
/**
 * КЛЮЧИ ПИСАТЕЛЯ: (событие, свойство-цель). Читатели (`requires_when`, `forbidden_when`, `unique_among`,
 * ролевые метки, `assign_level`) ключей не дают — двум предикатам спорить не о чем, оба обязаны выполниться.
 * `default` пишет при отсутствии значения, событие у него одно на свойство; `on_enter_class` даёт по ключу
 * на каждый элемент `in` — на вход (`set`) и на каждое снимаемое свойство ухода (`on_leave.unset`).
 *
 * Ключи ОДНОГО правила дедуплицируются: повтор в `in` или в `unset` — не второй писатель, и правило не
 * должно спорить само с собой (`RULE_CONFLICT {rule:'w', other:'w'}` был бы отказом без выхода).
 */
function eventKeys(rule: RuleDefinition): Array<{ event: string; property: string }> {
  if (rule.template === 'default') {
    return [{ event: `create|${rule.params.property}`, property: rule.params.property }];
  }
  if (rule.template !== 'on_enter_class') return [];
  const keys = new Map<string, string>();
  for (const head of enterHeads(rule.params.enter)) {
    if (rule.params.set !== undefined) {
      keys.set(`enter|${head}|${rule.params.set.property}`, rule.params.set.property);
    }
    for (const p of rule.params.on_leave?.unset ?? []) keys.set(`leave|${head}|${p}`, p);
  }
  return [...keys].map(([event, property]) => ({ event, property }));
}
/**
 * ДВА ПИСАТЕЛЯ ОДНОГО (свойство, событие) — отказ, а не приоритет (§Б4 конфлюэнтность, spec:503): явного
 * приоритета не существует, желание двух писателей — сигнал слить правила либо развести свойства. Это НЕ
 * цикл, поэтому код свой, а не `REGISTRY_CYCLE` (М6 ревью спеки). Выключенные не считаются: «отключить»
 * (§Б4-4) и есть выход из конфликта — конфликтуй оно, выхода бы не было.
 */
export function ruleConflictsOf(
  rules: readonly RuleDefinition[],
): Array<{ a: string; b: string; event: string; property: string }> {
  const seen = new Map<string, string>();
  const out: Array<{ a: string; b: string; event: string; property: string }> = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const { event, property } of eventKeys(rule)) {
      const prev = seen.get(event);
      if (prev === undefined) {
        seen.set(event, rule.id);
        continue;
      }
      out.push({ a: prev, b: rule.id, event, property });
    }
  }
  return out;
}
/** (9) Конфликт, в котором участвует ИМЕННО это правило: чужой конфликт снимка — не его отказ. */
function assertNoConflict(rule: RuleDefinition, reg: RegistrySnapshot): void {
  const c = ruleConflictsOf(rulesOf(reg).map((r) => r.rule)).find(
    (x) => x.a === rule.id || x.b === rule.id,
  );
  if (c === undefined) return;
  // `rule` — ПРОВЕРЯЕМОЕ правило, `other` — его пара, в каком бы порядке они ни лежали в снимке: читатель
  // отказа спрашивает «что не так с моим правилом», и порядок обхода носителей ответом не является.
  throw new ExecError(
    'RULE_CONFLICT',
    `правила «${c.a}» и «${c.b}» пишут ${c.property} на одном событии — приоритета между ними нет`,
    { rule: rule.id, other: c.a === rule.id ? c.b : c.a, event: c.event, property: c.property },
  );
}

/**
 * ВРЕЗКА НА ЗАПИСИ (Р-3, §Б4): все правила тронутой строки — валидатором, затем ацикличность ВСЕГО графа по
 * снимку-пробе. Порядок именно такой: цикл выразим только парой по отдельности законных правил, и
 * спрашивать о нём раньше формы значило бы отвечать «круг» на опечатку. `queryRefs` пуст намеренно —
 * держатели запросов к правилам отношения не имеют, а поход за ними в БД сделал бы функцию асинхронной.
 * Производственных вызывателей у функции НЕТ: тулы `rule_set`/`rule_remove` (задача 16) собирают тот же
 * порядок по месту (`registry/ops.ts`: `assertRule` на правило, затем `assertRuleInvariants` — ацикличность,
 * прирост конфликтов, носители, пары), потому что им нужен снимок «до» для мерки сдвига, а здесь его нет.
 * Функция — эталон порядка «сперва правила строки, затем граф» для тестов (`rules.test.ts`).
 */
export function assertRulesOfRow(
  reg: RegistrySnapshot,
  carrier: RuleCarrier,
  systemSeed: boolean,
): void {
  const dict =
    carrier.kind === 'aspect'
      ? reg.aspects
      : carrier.kind === 'property'
        ? reg.properties
        : reg.roles;
  // СЫРЫЕ элементы, а не разобранные: форму называет `assertRule`, и врезка, читающая через
  // `rulesFieldOf`, пропустила бы неразобравшееся правило молча — ровно то, что она обязана ловить.
  for (const raw of rawRulesOf(dict.get(carrier.id))) assertRule(raw, { reg, carrier, systemSeed });
  assertAcyclicGraph(dependencyGraph(reg, { queryRefs: new Map() }));
}
/**
 * ПРАВИЛА СИДА — ТЕМ ЖЕ ВАЛИДАТОРОМ, ЧТО ПРАВИЛА ВЛАДЕЛЬЦА: системная строка, посеянная с конфликтом,
 * валидировала бы данные молча у всех владельцев сразу. Проба собирается из КОДА (`BUILTIN_*`) — сид на то
 * и сид, что база после него обязана совпасть с кодом. Зовёт её ТЕСТ (`rules.test.ts`), а не сид
 * (Р-К-26): сид ходит сырым postgres.js, снимка у него нет, и прецедент прямой — `assertSubscription` в
 * сиде тоже не зовётся; цена — сид с конфликтом красен тестом в CI, а не на `db:prepare`. Правил в коде
 * пока ноль (первые кладёт задача 4); сторож заведён вместе с валидатором по доводу `assertAcyclicGraph`:
 * заводить его вместе с тем, что он сторожит, — заводить его после первой аварии.
 */
export function assertBuiltinRules(): void {
  const reg: RegistrySnapshot = {
    properties: new Map(BUILTIN_PROPERTY_META.map((d) => [d.id, d])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((d) => [d.id, d])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((d) => [d.id, d])),
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((d) => [d.id, d])),
    subscriptions: new Map(), // правила подписок не адресуют — словарь врезке не нужен
    actions: new Map(), // и действий тоже: носители правил — свойства, аспекты и роли
    ownerVersion: 0,
    systemVersion: 0,
  };
  for (const { carrier, row } of carrierRows(reg)) {
    for (const raw of rawRulesOf(row)) assertRule(raw, { reg, carrier, systemSeed: true });
  }
  assertAcyclicGraph(dependencyGraph(reg, { queryRefs: new Map() }));
}
