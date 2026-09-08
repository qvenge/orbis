// ВАЛИДАТОР ДЕКЛАРАЦИИ ПОДПИСКИ (§Б5-1, §Б5-2) — НА ЗАПИСИ, не на чтении.
// `applyDeltas`/`loadRegistryRows` отказывают fail-closed на КАЖДОМ чтении реестра: проверка смысла
// там означала бы владельца, запертого снаружи графа после пересева, изменившего контракт (Р-И-7).
// На чтении разбирается только ФОРМА, смысл — здесь, у сида, тула и дельты.
import type { SubscriptionDefinition } from '@orbis/shared';
import type { ExprScope, ExprType } from '@orbis/shared/expr';
import type { RegistrySnapshot } from '../registry/load';

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

/** Прямой адрес свойства: `{prop}` и `{deref:{prop}}`. */
const isRawNode = (n: Record<string, unknown>): boolean =>
  typeof n.prop === 'string' || typeof rec(n.deref)?.prop === 'string';

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
