/**
 * НОРМАЛИЗАЦИЯ ИМЁН В E-ДЕРЕВЕ: `key` → `id` (§А5-2 «в дереве лежат id, не подписи»).
 *
 * Зачем она нужна E ровно так же, как Q: декларацию пишет владелец через тул, а модели и
 * человеку все поверхности говорят KEY — `property_catalog` отдаёт key, карточка печатает
 * key, каталог контрактов называет контракт ключом. У встроенных записей `key = id`, у
 * СВОИХ — нет (§А2-1: id пользовательской записи — uuid), и без резолва первое же своё
 * свойство в формуле давало бы «нет такого свойства» на сохранении, а свой контракт в
 * `class` — «нет такого контракта» на компиляции набора.
 *
 * НЕИЗВЕСТНОЕ ИМЯ ОСТАЁТСЯ КАК ЕСТЬ — намеренно и по той же причине, что у
 * `normalizeQueryAst`: отказ называет ЧЕКЕР (`EXPR_TYPE` с путём до узла), и второго мнения
 * о том, что такое «нет такой записи», не заводится.
 *
 * ГЛУБИНА ПРОВЕРЯЕТСЯ ПЕРВОЙ СТРОКОЙ. Обход здесь рекурсивный (он ПЕРЕПИСЫВАЕТ дерево, а не
 * читает его), а вход недоверенный: цепочка `not` в 10 000 уровней исчерпала бы стек до
 * того, как до неё дошёл гейт глубины. Поэтому слишком глубокое дерево возвращается КАК
 * ЕСТЬ — отказ принадлежит гейту (`assertExprChecked`), а не нормализации.
 */

import { resolvePropertyFieldId } from '../query/field-ref';
import type { ParseRegistry } from '../query/parse-ast';
import type { ContractDefinition } from '../registry/contract-type';
import { EXPR_TREE_DEPTH_CAP, type ExprNode, exprTreeExceedsDepth } from './ast';

/** Реестр разбора Q ПЛЮС контракты: слоты и наборы живут только у них (§Б1-1). */
export type ExprNormalizeRegistry = ParseRegistry & {
  contracts: ReadonlyMap<string, ContractDefinition>;
};

/**
 * Имя ядра в `deref.read` (Е-3): теги лежат колонкой сущности, а не строкой реестра, и
 * резолвить их как свойство значило бы искать запись, которой нет.
 */
const CORE_TAGS = 'tags';

/** Общая мерка «сначала id, потом key» для словаря контрактов либо ролей. */
function byKeyOrId(name: string, dict: ReadonlyMap<string, { id: string; key?: string }>): string {
  if (dict.has(name)) return name;
  for (const def of dict.values()) {
    if (def.key === name) return def.id;
  }
  return name;
}

function property(name: string, reg: ExprNormalizeRegistry): string {
  return resolvePropertyFieldId(name, reg) ?? name;
}

/**
 * АДРЕС СВОЙСТВА В ФОРМЕ `"<id>" in $touched` (Е-5, Ф-Б2-26) — литерал слева от контекста, иначе
 * `undefined`. Это единственная `{const}` языка E, которая НЕ значение, а адрес строки реестра:
 * `$touched` — множество id свойств, которые трогает вызов, и сравнивать с ним имеет смысл только
 * адрес (чекер требует литерал из реестра — `touchedMembership`). Поэтому читатели имён реестра —
 * нормализация (key → id), перечень держателей (`propertyNamesInExpr`), печать (id → key) и
 * переписывание адресов при слиянии свойств (`rewriteAst` сервера) — обязаны видеть его наравне с
 * `{prop}`/`{has}`: иначе своё свойство, названное ключом, отказывало бы `EXPR_TYPE`, а правило на
 * поглощённом свойстве молча перестало бы срабатывать. Вход — сырой JSON: форма нужна и там, где
 * дерево ещё не разобрано схемой (jsonb реестра).
 */
export function touchedAddressOf(node: unknown): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const rec = node as { op?: unknown; args?: unknown };
  if (rec.op !== 'in' || !Array.isArray(rec.args) || rec.args.length !== 2) return undefined;
  const [left, right] = rec.args as [unknown, unknown];
  if (typeof right !== 'object' || right === null) return undefined;
  if ((right as { ctx?: unknown }).ctx !== '$touched') return undefined;
  if (typeof left !== 'object' || left === null) return undefined;
  const value = (left as { const?: unknown }).const;
  return typeof value === 'string' ? value : undefined;
}

function normalizeNode(node: ExprNode, reg: ExprNormalizeRegistry): ExprNode {
  if ('prop' in node) return { prop: property(node.prop, reg) };
  const touched = touchedAddressOf(node);
  if (touched !== undefined) {
    return { op: 'in', args: [{ const: property(touched, reg) }, { ctx: '$touched' }] };
  }
  // `has` адресует свойство ЛИБО слот контракта: у слота записи в реестре нет, и резолв
  // вернёт имя нетронутым — второй ветки под это не нужно.
  if ('has' in node) return { has: property(node.has, reg) };
  if ('deref' in node) {
    const d = node.deref;
    return {
      deref: {
        ...(d.prop === undefined ? {} : { prop: property(d.prop, reg) }),
        ...(d.slot === undefined ? {} : { slot: d.slot }),
        read: d.read === CORE_TAGS ? d.read : property(d.read, reg),
      },
    };
  }
  if ('class' in node) {
    return { class: { contract: byKeyOrId(node.class.contract, reg.contracts) } };
  }
  if ('has_relation' in node) {
    const h = node.has_relation;
    return {
      has_relation: {
        role: byKeyOrId(h.role, reg.roles),
        ...(h.in_set === undefined
          ? {}
          : {
              in_set: {
                contract: byKeyOrId(h.in_set.contract, reg.contracts),
                // Имя набора — имя ВНУТРИ контракта, а не запись реестра: не резолвится.
                set: h.in_set.set,
              },
            }),
        ...(h.alive === undefined ? {} : { alive: h.alive }),
      },
    };
  }
  if ('op' in node) return { op: node.op, args: node.args.map((a) => normalizeNode(a, reg)) };
  if ('date_add' in node) {
    return {
      date_add: [normalizeNode(node.date_add[0], reg), normalizeNode(node.date_add[1], reg)],
    };
  }
  if ('date_diff' in node) {
    return {
      date_diff: [normalizeNode(node.date_diff[0], reg), normalizeNode(node.date_diff[1], reg)],
    };
  }
  if ('days_inclusive' in node) {
    return {
      days_inclusive: [
        normalizeNode(node.days_inclusive[0], reg),
        normalizeNode(node.days_inclusive[1], reg),
      ],
    };
  }
  // {const}, {duration}, {slot}, {param}, {ctx}, {agg}, {phase}, {agg_via} имён реестра не
  // несут: слот, параметр, величина и фаза — имена ВНУТРИ контракта или ведомости. Единственная
  // `{const}`-адрес — член `$touched` — разобрана выше (`touchedAddressOf`).
  return node;
}

/**
 * Дерево с именами, приведёнными к идентификаторам реестра.
 *
 * Возвращается НОВОЕ дерево, вход не мутируется: то же дерево может лежать в конверте пачки,
 * и нормализация одной операции не должна менять вход соседней.
 */
export function normalizeExpr(expr: ExprNode, reg: ExprNormalizeRegistry): ExprNode {
  if (exprTreeExceedsDepth(expr, EXPR_TREE_DEPTH_CAP)) return expr;
  return normalizeNode(expr, reg);
}

/**
 * ИМЕНА СВОЙСТВ, КОТОРЫЕ ВЫРАЖЕНИЕ АДРЕСУЕТ — вход графа зависимостей правил (Р-И-22, §Б4) и перечня
 * держателей (задача 16). Четыре формы и ровно четыре: `{prop}`, `{has}`, БАЗА разыменования
 * `{deref:{prop}}` и литерал-член `$touched` (`"<id>" in $touched`, Ф-Б2-26 — см. `touchedAddressOf`;
 * графу он рёбер не даёт: `assign_level` ничего не пишет). `deref.read` не входит намеренно — это
 * свойство ЧУЖОЙ записи, и ребро «моё свойство зависит от него» означало бы стратификацию по графу
 * сущностей, которой у реестра нет. `{slot}`/`{agg}`/`{agg_via}`/`{phase}`/`{param}`/`{ctx}` — имена ВНУТРИ
 * контракта или ведомости, строк реестра они не адресуют. Обход ИТЕРАТИВНЫЙ: дерево приезжает из jsonb, и
 * рекурсия была бы вторым местом, чья прочность держится на чужом капе глубины.
 */
export function propertyNamesInExpr(node: unknown): Set<string> {
  const out = new Set<string>();
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (typeof cur !== 'object' || cur === null) continue;
    if (Array.isArray(cur)) {
      for (const child of cur) stack.push(child);
      continue;
    }
    const rec = cur as Record<string, unknown>;
    if (typeof rec.prop === 'string') out.add(rec.prop);
    if (typeof rec.has === 'string') out.add(rec.has);
    const touched = touchedAddressOf(rec);
    if (touched !== undefined) out.add(touched);
    const deref = rec.deref as { prop?: unknown } | undefined;
    if (deref !== undefined && typeof deref.prop === 'string') out.add(deref.prop);
    // Внутрь `deref` не спускаемся: единственное, что там ещё есть, — `read` чужой записи.
    for (const [key, child] of Object.entries(rec)) if (key !== 'deref') stack.push(child);
  }
  return out;
}
