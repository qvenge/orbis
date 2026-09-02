/**
 * НОРМАЛИЗАЦИЯ ИМЁН В ДЕРЕВЕ Q-AST: `key` → `id` (§А5-2 «в дереве лежат id, не подписи»).
 *
 * ЗАЧЕМ ОНА ПОЯВИЛАСЬ. Дерево приезжает на четыре модель-фейсинговых входа МИМО разбора
 * текста — `entity_query.ast`, значение `orbis/progress_source.query`, `scope` строки
 * реестра и `type.target` ссылочного свойства, — а компилятор адресует узлы СТРОГО по id
 * (`propertyOrFail`: «такого id нет в реестре владельца»). У встроенного свойства `id`
 * совпадает с `key`, у СВОЕГО — нет (Р3: id — uuid, key — `user/…`), и все поверхности,
 * которые видит модель, говорят ей key: `props` печатаются по key, `property_catalog`
 * отдаёт key «им и пиши значение», текст запроса адресует свойство только ключом. Пока
 * резолва не было, первое же своё свойство давало `UNKNOWN_FIELD` на `entity_query.ast` и —
 * что хуже — МОЛЧА ложилось в цель: `progress_source` с key записывался успешно и на каждом
 * чтении отвечал `invalid_query`, то есть пустой полосой прогресса навсегда.
 *
 * ПОЧЕМУ РЕЗОЛВ, А НЕ ПРАВКА ПРОМПТА. Развернуть модель на id значило бы менять адресное
 * пространство посреди одного вызова (props — key, дерево — id) и не закрыть тихий
 * сценарий вовсе: цель, написанная key, всё равно записалась бы. Расширение же безопасно по
 * построению — адресные пространства не пересекаются (`orbis/…` у встроенных, uuid у своих
 * id, `user/…` у своих key), поэтому «сначала id, потом key» однозначен.
 *
 * НЕИЗВЕСТНОЕ ИМЯ ОСТАЁТСЯ КАК ЕСТЬ — намеренно: отказ по-прежнему называет компилятор
 * (`UNKNOWN_FIELD` с адресом, который прислал вызывающий), и второго мнения о том, что
 * такое «нет такого свойства», не заводится.
 *
 * ГЛУБИНА ПРОВЕРЯЕТСЯ ПЕРВОЙ СТРОКОЙ. Обход здесь рекурсивный (он ПЕРЕПИСЫВАЕТ дерево, а не
 * читает его), а вход недоверенный: цепочка `not` в 10 000 уровней исчерпала бы стек до
 * того, как до неё дошёл гейт глубины. Поэтому дерево глубже капа возвращается КАК ЕСТЬ —
 * отказывать здесь нельзя (нормализация не гейт, и второго ответа на «сколько уровней
 * законно» не заводится), а гейт, которому этот отказ принадлежит, стоит следом.
 */
import type { QueryAst, QueryFilterNode, QueryRelPredicate } from './ast';
import { QUERY_TREE_DEPTH_CAP, queryTreeExceedsDepth } from './ast';
import { resolvePropertyFieldId } from './field-ref';
import type { ParseRegistry } from './parse-ast';

/** Общая мерка «сначала id, потом key» для словаря аспектов либо ролей. */
function resolveByKeyOrId(
  name: string,
  dict: ReadonlyMap<string, { id: string; key?: string }>,
): string {
  if (dict.has(name)) return name;
  for (const def of dict.values()) {
    if (def.key === name) return def.id;
  }
  return name;
}

function normalizeProperty(name: string, reg: ParseRegistry): string {
  return resolvePropertyFieldId(name, reg) ?? name;
}

function normalizeRel(rel: QueryRelPredicate, reg: ParseRegistry): QueryRelPredicate {
  const out = { ...rel } as QueryRelPredicate & {
    via?: string;
    sourceNotIn?: { prop: string; values: unknown[] };
  };
  if (typeof out.via === 'string') out.via = resolveByKeyOrId(out.via, reg.roles);
  if (out.sourceNotIn !== undefined) {
    out.sourceNotIn = {
      ...out.sourceNotIn,
      prop: normalizeProperty(out.sourceNotIn.prop, reg),
    };
  }
  return out as QueryRelPredicate;
}

function normalizeNode(node: QueryFilterNode, reg: ParseRegistry): QueryFilterNode {
  if ('and' in node) return { and: node.and.map((n) => normalizeNode(n, reg)) };
  if ('or' in node) return { or: node.or.map((n) => normalizeNode(n, reg)) };
  if ('not' in node) return { not: normalizeNode(node.not, reg) };
  if ('prop' in node) return { ...node, prop: normalizeProperty(node.prop, reg) };
  if ('has' in node) return { has: normalizeProperty(node.has, reg) };
  if ('aspect' in node) return { aspect: resolveByKeyOrId(node.aspect, reg.aspects) };
  if ('rel' in node) return { rel: normalizeRel(node.rel, reg) };
  return node;
}

/**
 * Дерево с именами, приведёнными к идентификаторам реестра.
 *
 * Возвращается НОВОЕ дерево, вход не мутируется: то же дерево может лежать в конверте
 * пачки, а нормализация одной операции не должна менять вход соседней.
 *
 * Дерево глубже `QUERY_TREE_DEPTH_CAP` возвращается нетронутым — см. шапку файла.
 */
export function normalizeQueryAst(ast: QueryAst, reg: ParseRegistry): QueryAst {
  if (queryTreeExceedsDepth(ast, QUERY_TREE_DEPTH_CAP)) return ast;
  const sortBy = ast.sortBy?.map((s) => ({ ...s, field: normalizeProperty(s.field, reg) }));
  return {
    ...ast,
    filter: ast.filter === null ? null : normalizeNode(ast.filter, reg),
    ...(sortBy === undefined ? {} : { sortBy }),
  };
}
