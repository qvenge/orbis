// ВАЛИДАТОР ДЕКЛАРАЦИИ ПОДПИСКИ (§Б5-1, §Б5-2) — НА ЗАПИСИ, не на чтении.
// `applyDeltas`/`loadRegistryRows` отказывают fail-closed на КАЖДОМ чтении реестра: проверка смысла
// там означала бы владельца, запертого снаружи графа после пересева, изменившего контракт (Р-И-7).
// На чтении разбирается только ФОРМА, смысл — здесь, у сида, тула и дельты.
import {
  type BindingIndex,
  type BudgetSubscription,
  bindingIndexOf,
  EXPR_RECURSION,
  EXPR_TYPE,
  SECOND_LANGUAGE,
  SLOT_KEY_RE,
  SURFACE_ENGINE,
  SURFACES,
  type SubscriptionDefinition,
  type SurfaceName,
  subscriptionDefinitionSchema,
} from '@orbis/shared';
import type { ExprScope, ExprType } from '@orbis/shared/expr';
import { ExecError } from '../errors';
import { assertExprChecked } from '../expr/check';
import type { RegistrySnapshot, SubscriptionRow } from '../registry/load';

export interface SubscriptionCheckScope {
  reg: RegistrySnapshot;
  systemSeed: boolean;
}
export interface ExprSite {
  path: string;
  value: unknown;
  scope: Omit<ExprScope, 'reg'>;
  expect: readonly ExprType['kind'][] | null;
}

const DATE_KINDS = ['date', 'timestamp'] as const;
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** Параметры движков типизированы датой: окна и границы периодов — единственный их род. */
function paramTypes(params: unknown, fallback: readonly string[] = []): Record<string, ExprType> {
  const out: Record<string, ExprType> = {};
  for (const p of Array.isArray(params) ? params : fallback) {
    if (typeof p === 'string') out[p] = { kind: 'date' };
  }
  return out;
}

/**
 * ПОЗИЦИИ ЯЗЫКА E — одним перечнем, а не разбором по месту: он нужен ТРИЖДЫ. Строка вместо выражения
 * ловится ДО разбора формы (после него строки нет — zod её отверг, и владелец получил бы «поле не
 * разобралось» вместо «здесь язык E»); тип каждой позиции проверяется в СВОЕЙ области (у ведомости и
 * у окна разные слоты и параметры); сырые ссылки ищутся только внутри выражений. Три обхода по трём
 * копиям путей разъехались бы на первом новом поле декларации.
 * Вход — `unknown` НАМЕРЕННО: функцию зовут и на сырой строке, и на разобранной.
 */
export function exprSitesOf(raw: unknown): readonly ExprSite[] {
  const d = rec(raw);
  if (d === undefined) return [];
  if (d.engine === 'agenda') return agendaSites(d);
  return d.engine === 'budget' ? budgetSites(d) : [];
}

function agendaSites(d: Record<string, unknown>): ExprSite[] {
  const scope = {
    contract: 'orbis/when',
    params: paramTypes(d.params, ['window_from', 'window_to']),
    allowDeref: true,
  } as const;
  const out: ExprSite[] = [];
  const w = rec(rec(d.show)?.window);
  if (w !== undefined) {
    out.push(
      { path: 'show.window.from', value: w.from, scope, expect: DATE_KINDS },
      { path: 'show.window.to', value: w.to, scope, expect: DATE_KINDS },
    );
  }
  const o = rec(d.overdue);
  if (o !== undefined) {
    out.push(
      { path: 'overdue.before', value: o.before, scope, expect: DATE_KINDS },
      { path: 'overdue.where', value: o.where, scope, expect: ['boolean'] },
    );
  }
  return out;
}

function budgetSites(d: Record<string, unknown>): ExprSite[] {
  const params = paramTypes(d.params);
  const phases = rec(d.phases) ?? {};
  const aggregates = rec(d.aggregates) ?? {};
  const phaseKeys = Object.keys(phases);
  // Величины ведомости — decimal ПО ПОСТРОЕНИЮ (§Б5-4: суммы по слоту amount и формулы над ними).
  // Точная типизация требовала бы топологического прохода по {agg} ДО проверки типов; условие, при
  // котором он понадобится: ведомость нефинансового рода.
  const aggs: Record<string, ExprType> = {};
  for (const n of Object.keys(aggregates)) aggs[n] = { kind: 'decimal' };
  const out: ExprSite[] = [];
  // Фаза фаз не видит: {phase} внутри фазы — цикл, и отличать безобидный от порочного дороже, чем
  // запретить род целиком.
  for (const k of phaseKeys) {
    out.push({
      path: `phases.${k}`,
      value: phases[k],
      expect: ['boolean'],
      scope: { contract: 'orbis/envelope', params, aggs, phases: [], allowDeref: true },
    });
  }
  for (const [name, value] of Object.entries(aggregates)) {
    const agg = rec(value);
    if (agg === undefined) continue;
    if (agg.kind === 'formula') {
      const others = { ...aggs };
      delete others[name]; // самоссылка ведомости — EXPR_TYPE у чекера
      out.push({
        path: `aggregates.${name}.expr`,
        value: agg.expr,
        expect: ['decimal'],
        scope: {
          contract: 'orbis/envelope',
          params,
          aggs: others,
          phases: phaseKeys,
          allowDeref: true,
        },
      });
    } else if (agg.where !== undefined) {
      out.push({
        path: `aggregates.${name}.where`,
        value: agg.where,
        expect: ['boolean'],
        scope: { contract: 'orbis/money-movement', params, allowDeref: true },
      });
    }
  }
  for (const [name, value] of Object.entries(rec(d.lists) ?? {})) {
    const list = rec(value);
    if (list === undefined) continue;
    if (list.where !== undefined) {
      out.push({
        path: `lists.${name}.where`,
        value: list.where,
        expect: ['boolean'],
        scope: { contract: 'orbis/money-movement', params, allowDeref: true },
      });
    }
    const w = rec(list.window);
    // У окна списка контракта НЕТ: границы пишутся {param}/{ctx}, и {slot} здесь — честный EXPR_TYPE,
    // а не «работает, но не то».
    if (w !== undefined) {
      out.push(
        { path: `lists.${name}.window.from`, value: w.from, scope: { params }, expect: DATE_KINDS },
        { path: `lists.${name}.window.to`, value: w.to, scope: { params }, expect: DATE_KINDS },
      );
    }
  }
  return out;
}

/**
 * Прямой адрес свойства: `{prop}`, `{deref:{prop}}` и `{has: <id свойства>}`.
 *
 * `has` РАЗДВОЕН по форме имени, потому что узел один, а смысла у него два (`expr/check.ts`): в области
 * с контрактом он принимает и id свойства, и имя слота. Слот — слаг (`SLOT_KEY_RE`), id свойства несёт
 * `/` — по этому и различаются. Пропустить `{has}` значило бы дыру ровно того рода, ради которой
 * перечень и заведён: `and(class in open, has(orbis/…))` — предикат по СВОЙСТВУ, и системному сиду он
 * запрещён (§Б5-2), а у владельца обязан получить пометку `raw_value` в диффе Ш1.
 */
const isRawNode = (n: Record<string, unknown>): boolean =>
  typeof n.prop === 'string' ||
  typeof rec(n.deref)?.prop === 'string' ||
  (typeof n.has === 'string' && !SLOT_KEY_RE.test(n.has));

function walkRaw(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) walkRaw(v, `${path}.${i}`, out);
    return;
  }
  const node = rec(value);
  if (node === undefined) return;
  if (isRawNode(node)) {
    out.push(path);
    return;
  }
  for (const [k, v] of Object.entries(node)) walkRaw(v, `${path}.${k}`, out);
}

/**
 * ПУТИ СЫРЫХ ССЫЛОК — второе названное отклонение §Б5-2: предикат по СВОЙСТВУ вместо класса.
 * Возвращаются пути, а не пары «путь + свойство»: id читается по пути (`valueAt`), и второй экземпляр
 * адреса разъехался бы с первым. `deref.read` сюда не входит — разыменование ЧИТАЕТ свойство по
 * построению (§Б3-3), выбирать между «классом» и «свойством» там не из чего.
 */
export function rawValueRefs(def: SubscriptionDefinition): readonly string[] {
  const out: string[] = [];
  for (const site of exprSitesOf(def)) walkRaw(site.value, site.path, out);
  return out;
}

/**
 * ПОЛНАЯ ПРОВЕРКА ПЕРЕД ЗАПИСЬЮ. Порядок — не косметика: (1) поверхность (дешевле всего и решает, кому
 * декларация адресована); (2) строка в E-позиции — ДО разбора формы; (3) форма; (3а) движок против
 * поверхности (`SURFACE_ENGINE`) — сразу после формы, пока путей ещё нет; (4) поимённые ссылки по
 * фиксированным путям, без обхода дерева; (5) типы выражений — здесь же срабатывает кап глубины дерева E
 * (`assertExprChecked`); (6) круги между ведомостями; (7) глубокие обходы (аспект вне prefer, сырые
 * предикаты) — ПОСЛЕ капа шага 5: обход дерева без гейта глубины был бы вторым входом дерева без гейта.
 */
export function assertSubscription(
  row: SubscriptionRow,
  scope: SubscriptionCheckScope,
): SubscriptionDefinition {
  if (!(SURFACES as readonly string[]).includes(row.surface)) {
    throw new ExecError(
      'SURFACE_UNKNOWN',
      `поверхности «${row.surface}» нет: подписке ${row.id} некого обслуживать`,
      { subscription: row.id, surface: row.surface, known: [...SURFACES] },
    );
  }
  for (const site of exprSitesOf(row.definition)) {
    if (typeof site.value !== 'string') continue;
    throw new ExecError(
      SECOND_LANGUAGE,
      `${row.id}: в позиции ${site.path} ожидается выражение E, а не текст`,
      { subscription: row.id, path: site.path },
    );
  }
  const parsed = subscriptionDefinitionSchema.safeParse(row.definition);
  if (!parsed.success) {
    throw new ExecError('VALIDATION', `декларация подписки ${row.id} не разобрана`, {
      reason: 'SUBSCRIPTION_MALFORMED',
      subscription: row.id,
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const def = parsed.data;
  // Движок обязан совпасть с тем, что поверхность умеет показывать: иначе её движок получил бы чужую
  // форму на ИСПОЛНЕНИИ — у владельца, а не у автора декларации. Поверхность к этому месту уже в
  // словаре (проверка первой ступенью), поэтому ответа `undefined` у таблицы здесь не бывает.
  const engine = SURFACE_ENGINE[row.surface as SurfaceName];
  if (engine !== def.engine) {
    bad(
      'SUBSCRIPTION_ENGINE_SURFACE',
      row.id,
      `поверхность ${row.surface} обслуживает движок ${engine}, а декларация объявлена для ${def.engine}`,
      { surface: row.surface, expected: engine, actual: def.engine },
    );
  }
  assertReferences(row.id, def, scope.reg);
  assertExprTypes(row.id, def, scope.reg);
  if (def.engine === 'budget') assertAggregatesAcyclic(row.id, def);
  assertNoAspectRefs(row.id, def, scope.reg);
  if (scope.systemSeed) assertNoRawValues(row.id, def);
  return def;
}

/** Отказ формы декларации: VALIDATION с ПРИЧИНОЙ в details — как у дельт (`deltas.ts`). */
function bad(
  reason: string,
  subscription: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new ExecError('VALIDATION', message, { reason, subscription, ...details });
}

function contractOf(reg: RegistrySnapshot, id: string, sub: string) {
  const c = reg.contracts.get(id);
  if (c === undefined)
    bad('SUBSCRIPTION_UNKNOWN_CONTRACT', sub, `контракта ${id} нет в реестре`, {
      contract: id,
    });
  return c;
}
const slotNames = (reg: RegistrySnapshot, id: string, sub: string) =>
  new Set((contractOf(reg, id, sub).slots ?? []).map((s) => s.name));
const setNames = (reg: RegistrySnapshot, id: string, sub: string) =>
  new Set(Object.keys(contractOf(reg, id, sub).sets ?? {}));
function assertRole(reg: RegistrySnapshot, sub: string, role: string): void {
  if (!reg.roles.has(role))
    bad('SUBSCRIPTION_UNKNOWN_ROLE', sub, `роли ${role} нет в реестре`, {
      role,
    });
}

/** Поимённые ссылки декларации — по фиксированным путям; дерево здесь не обходится. */
function assertReferences(id: string, def: SubscriptionDefinition, reg: RegistrySnapshot): void {
  const idx = bindingIndexOf(reg);
  const known = (name: string, set: ReadonlySet<string>, reason: string, path: string): void => {
    if (!set.has(name)) {
      bad(reason, id, `${path}: имени «${name}» в реестре или декларации нет`, { path, name });
    }
  };
  if (def.engine === 'agenda') {
    known(
      def.hide.set,
      setNames(reg, 'orbis/recurrence', id),
      'SUBSCRIPTION_UNKNOWN_SET',
      'hide.set',
    );
    const prefer = (list: readonly string[], slots: readonly string[], path: string): void => {
      for (const a of list) {
        if (!reg.aspects.has(a)) {
          bad('SUBSCRIPTION_UNKNOWN_ASPECT', id, `аспекта ${a} нет`, { aspect: a, path });
        }
        // Аспект в prefer, не реализующий спорный слот, — мёртвая строка: приоритет, который никогда
        // не сработает, а SLOT_AMBIGUOUS при этом продолжит падать.
        if (!slots.some((s) => idx.slotOf(a, 'orbis/when', s) !== undefined)) {
          bad('SUBSCRIPTION_PREFER_UNBOUND', id, `${a} не реализует слот секции ${path}`, {
            aspect: a,
            path,
          });
        }
      }
    };
    prefer(def.show.prefer, [def.show.slot], 'show.prefer');
    prefer(def.overdue.prefer, def.overdue.slots, 'overdue.prefer');
    return;
  }
  const mSets = setNames(reg, def.sources.movement.contract, id);
  const mSlots = slotNames(reg, def.sources.movement.contract, id);
  const eSlots = slotNames(reg, def.sources.envelope.contract, id);
  const aggNames = new Set(Object.keys(def.aggregates));
  const phaseKeys = new Set(Object.keys(def.phases));
  known(
    def.sources.movement.counted_set,
    mSets,
    'SUBSCRIPTION_UNKNOWN_SET',
    'sources.movement.counted_set',
  );
  assertRole(reg, id, def.sources.envelope.binding_role);
  assertRole(reg, id, def.rollup.role);
  // Ключ `active` обязателен: прочие фазы — условия, активная — ОСТАТОК; без неё `if(phase=active, …)`
  // в daily_pace молча считался бы всегда null.
  if (!phaseKeys.has('active'))
    bad('SUBSCRIPTION_PHASE_ACTIVE_MISSING', id, 'у Budget нет фазы active');
  for (const n of def.rollup.applies_to) {
    known(n, aggNames, 'SUBSCRIPTION_UNKNOWN_AGG', 'rollup.applies_to');
  }
  for (const p of def.alerts.skip_phases) {
    known(p, phaseKeys, 'SUBSCRIPTION_UNKNOWN_PHASE', 'alerts.skip_phases');
  }
  known(def.rollover.carry.agg, aggNames, 'SUBSCRIPTION_UNKNOWN_AGG', 'rollover.carry.agg');
  for (const [n, agg] of Object.entries(def.aggregates)) {
    if (agg.kind !== 'sum') continue;
    known(agg.of.slot, mSlots, 'SUBSCRIPTION_UNKNOWN_SLOT', `aggregates.${n}.of.slot`);
    if (agg.group_by !== undefined) {
      known(agg.group_by.slot, mSlots, 'SUBSCRIPTION_UNKNOWN_SLOT', `aggregates.${n}.group_by`);
    }
    for (const r of [agg.bound_via, agg.unbound_via]) if (r !== undefined) assertRole(reg, id, r);
  }
  for (const [n, list] of Object.entries(def.lists)) {
    known(list.counted_set, mSets, 'SUBSCRIPTION_UNKNOWN_SET', `lists.${n}.counted_set`);
    for (const r of [list.requires_relation, list.excludes_relation]) {
      if (r !== undefined) assertRole(reg, id, r.role);
    }
    for (const o of list.order_by) {
      if ('slot' in o) known(o.slot, mSlots, 'SUBSCRIPTION_UNKNOWN_SLOT', `lists.${n}.order_by`);
    }
  }
  for (const o of def.cards.order_by) {
    if ('slot' in o) known(o.slot, eSlots, 'SUBSCRIPTION_UNKNOWN_SLOT', 'cards.order_by');
    if (!('deref' in o)) continue;
    known(o.deref.slot, eSlots, 'SUBSCRIPTION_UNKNOWN_SLOT', 'cards.order_by.deref');
    if (!reg.properties.has(o.deref.read)) {
      bad('SUBSCRIPTION_UNKNOWN_PROPERTY', id, `свойства ${o.deref.read} нет`, {
        property: o.deref.read,
      });
    }
  }
}

function walkAspectRefs(
  v: unknown,
  path: string,
  inPrefer: boolean,
  aspects: ReadonlyMap<string, unknown>,
  out: string[],
): void {
  if (typeof v === 'string') {
    if (!inPrefer && aspects.has(v)) out.push(path);
    return;
  }
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) {
      walkAspectRefs(x, `${path}.${i}`, inPrefer, aspects, out);
    }
    return;
  }
  const node = rec(v);
  if (node === undefined) return;
  for (const [k, x] of Object.entries(node)) {
    walkAspectRefs(x, path === '' ? k : `${path}.${k}`, inPrefer || k === 'prefer', aspects, out);
  }
}

/** §Б5-2: ссылка на id аспекта законна ТОЛЬКО в `prefer`; везде иначе — SUBSCRIPTION_RAW_REF. */
function assertNoAspectRefs(id: string, def: SubscriptionDefinition, reg: RegistrySnapshot): void {
  const found: string[] = [];
  walkAspectRefs(def, '', false, reg.aspects, found);
  const path = found[0];
  if (path === undefined) return;
  throw new ExecError('SUBSCRIPTION_RAW_REF', `${id}: ссылка на аспект вне prefer (${path})`, {
    subscription: id,
    path,
    ref: valueAt(def, path),
  });
}

/**
 * СИСТЕМНОМУ СИДУ СЫРОЙ ПРЕДИКАТ ЗАПРЕЩЁН. Пометить его нечем: `raw_value` — вывод валидатора для
 * диффа Ш1, а не поле декларации, и «немаркированное сырое значение в системном сиде» (§Б5-2) значит
 * ровно «любое»: встроенная подписка обязана ссылаться на контракт и набор. У владельца тот же
 * предикат законен и уезжает в дифф пометкой.
 */
function assertNoRawValues(id: string, def: SubscriptionDefinition): void {
  const path = rawValueRefs(def)[0];
  if (path === undefined) return;
  const node = rec(valueAt(def, path));
  throw new ExecError(
    'SUBSCRIPTION_RAW_REF',
    `${id}: системный сид ссылается на свойство (${path})`,
    {
      subscription: id,
      path,
      ref: node?.prop ?? rec(node?.deref)?.prop ?? node?.has ?? null,
    },
  );
}

function valueAt(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split('.')) {
    cur = Array.isArray(cur) ? cur[Number(key)] : rec(cur)?.[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function assertExprTypes(id: string, def: SubscriptionDefinition, reg: RegistrySnapshot): void {
  for (const site of exprSitesOf(def)) {
    // `allowSensitivity` не выставляется НИГДЕ: {ctx:'$sensitivity'} живёт только в assign_level правил
    // (§Б3-2а, Б-2), и подписка его видеть не должна.
    const type = assertExprChecked(site.value, { reg, ...site.scope });
    if (site.expect === null || site.expect.includes(type.kind)) continue;
    throw new ExecError(
      EXPR_TYPE,
      `${id}: в позиции ${site.path} ожидался ${site.expect.join('|')}, получен ${type.kind}`,
      { subscription: id, path: site.path, expected: site.expect.join('|'), actual: type.kind },
    );
  }
}

/** Имена ведомостей, названные выражением через `{agg}`. */
function aggRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const v of node) aggRefs(v, out);
    return;
  }
  const o = rec(node);
  if (o === undefined) return;
  if (typeof o.agg === 'string') {
    out.add(o.agg);
    return;
  }
  for (const v of Object.values(o)) aggRefs(v, out);
}

/**
 * КРУГ МЕЖДУ ВЕДОМОСТЯМИ — EXPR_RECURSION (§С8-28 «рекурсия невыразима»). Чекер выражения его не видит:
 * он знает ИМЕНА доступных величин, но не их тела, и круг `remaining → daily_pace → remaining`
 * собирается из двух законных по отдельности формул. Без проверки движок ведомостей ушёл бы в
 * бесконечный обход на первом же конверте.
 */
function assertAggregatesAcyclic(id: string, def: BudgetSubscription): void {
  const edges = new Map<string, Set<string>>();
  for (const [name, agg] of Object.entries(def.aggregates)) {
    const refs = new Set<string>();
    if (agg.kind === 'formula') aggRefs(agg.expr, refs);
    edges.set(name, refs);
  }
  const state = new Map<string, 'open' | 'done'>();
  const walk = (name: string, trail: readonly string[]): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'open') {
      throw new ExecError(
        EXPR_RECURSION,
        `${id}: ведомости ссылаются по кругу: ${[...trail, name].join(' → ')}`,
        { subscription: id, path: `aggregates.${name}`, cycle: [...trail, name] },
      );
    }
    state.set(name, 'open');
    for (const next of edges.get(name) ?? []) walk(next, [...trail, name]);
    state.set(name, 'done');
  };
  for (const name of edges.keys()) walk(name, []);
}

export interface SlotHost {
  id?: string;
  aspects: readonly string[];
  props: Record<string, unknown>;
}

/**
 * ЗНАЧЕНИЕ СЛОТА КОНТРАКТА У СУЩНОСТИ (§Б5-6, §С8-21). Конфликт SLOT_AMBIGUOUS живёт ЗДЕСЬ, а не в
 * валидаторе декларации: две привязки одного слота — свойство СУЩНОСТИ (свой аспект + orbis/schedule на
 * одной записи), в реестре обе законны по отдельности. Проверка на декларации была бы либо ложной
 * тревогой (аспекты никогда не встретятся вместе), либо молчанием (встретятся — а декларация принята).
 * ПУСТОЙ СЛОТ — НЕ РЕАЛИЗАЦИЯ (§Б2-3): иначе событие без начала спорило бы за слот, которого у него нет.
 *
 * `details` ЗДЕСЬ БЕЗ `subscription` — и это не потеря поля §1.1, а разделение того, кто что знает: функция
 * зовётся движком и подписки не видит (шестым параметром её пришлось бы протаскивать через каждый вызов ради
 * одной строки отказа). Имя дописывает ВЫЗЫВАЮЩИЙ: `rowOf` движка Agenda (задача 6) ловит `SLOT_AMBIGUOUS`,
 * дописывает `{ subscription: AGENDA_SUBSCRIPTION_ID }` в `details` и перебрасывает — у пользователя отказ
 * приходит полным (`{subscription, contract, slot, entityId, aspects}`), а у чистой функции остаётся один
 * источник правды о конфликте.
 */
export function resolveSlotOnEntity(
  idx: BindingIndex,
  entity: SlotHost,
  contract: string,
  slot: string,
  prefer: readonly string[],
): { aspectId: string; value: unknown } | null {
  const on = new Set(entity.aspects);
  const live: { aspectId: string; value: unknown }[] = [];
  for (const binding of idx.byContract(contract)) {
    if (!on.has(binding.aspectId)) continue;
    const bound = idx.slotOf(binding.aspectId, contract, slot);
    if (bound === undefined) continue;
    const value = 'fixed' in bound ? bound.fixed : entity.props[bound.prop];
    if (value === undefined || value === null) continue;
    live.push({ aspectId: binding.aspectId, value });
  }
  const only = live[0];
  if (only === undefined) return null;
  if (live.length === 1) return only;
  // Порядок prefer И ЕСТЬ приоритет: первый совпавший, а не «самый ранний аспект по rank».
  for (const aspectId of prefer) {
    const hit = live.find((c) => c.aspectId === aspectId);
    if (hit !== undefined) return hit;
  }
  // `subscription` в details дописывает движок (задача 6, `rowOf`) — см. докблок выше.
  throw new ExecError(
    'SLOT_AMBIGUOUS',
    `слот ${contract}.${slot} реализуют ${live.length} аспекта сущности — подписке нужен prefer`,
    {
      contract,
      slot,
      entityId: entity.id ?? null,
      aspects: live.map((c) => c.aspectId).sort(),
    },
  );
}
