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
  SECOND_LANGUAGE,
} from '@orbis/shared/expr';
import { ExecError } from '../errors';
import { assertExprChecked } from '../expr/check';
import type { ExprSite } from '../subscriptions/registry';
import { assertAcyclicGraph, dependencyGraph } from './deps-graph';
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
    case 'unique_among':
      // СПИСОЧНОЕ свойство (`cardinality: many`) в наборе запрещено кодом §С1-2 `UNIQUE_ON_MANY`: у
      // списка нет «того же значения» — сравнение зависело бы от порядка элементов, то есть правило
      // либо не срабатывало бы никогда, либо срабатывало бы на перестановке. Статическая проверка по
      // типу — ступень ссылок, а не движка (перенос из задачи 12, рулинг Ф-Б2-14).
      for (const p of rule.params.properties) {
        const def = propertyOf(reg, rule, p);
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
  if (rule.template === 'assign_level') {
    return { allowDeref: true, allowSensitivity: true, params: {} };
  }
  return { derefDenied: true, params: RULE_PARAM_TYPES };
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
 * (7) ТИПЫ ВЫРАЖЕНИЙ в области правила — через единственный гейт записи E (`assertExprChecked`): там же
 * кап глубины дерева и перевод `ExprCheckError` → `ExecError` тем же кодом (`DEREF_IN_CONSTRAINT`,
 * `EXPR_TYPE`, …). `when` — boolean; значение T-правила — типа свойства-цели.
 */
function assertExprTypes(rule: RuleDefinition, { reg, carrier }: RuleCheckScope): void {
  for (const site of ruleExprSitesOf(rule, reg, carrier)) {
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
 * Зовут: тест системных строк (`assertBuiltinRules` ниже — тот же порядок над снимком из кода) и тулы
 * `rule_set`/`rule_remove` над `probeSnapshot` (задача 16).
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
    ownerVersion: 0,
    systemVersion: 0,
  };
  for (const { carrier, row } of carrierRows(reg)) {
    for (const raw of rawRulesOf(row)) assertRule(raw, { reg, carrier, systemSeed: true });
  }
  assertAcyclicGraph(dependencyGraph(reg, { queryRefs: new Map() }));
}
