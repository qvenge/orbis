// apps/server/src/registry/deps-graph.ts
//
// ГРАФ ЗАВИСИМОСТЕЙ РЕЕСТРА (§А3-5, §С1-3 п.10): «кто на этом свойстве стоит» — ЧЕСТНЫМ
// ответом из данных, а не рукописным списком в коде.
//
// Зачем вообще. §А3-5 разрешает владельцу скрыть встроенное свойство из аспекта, слить два
// свойства в одно и форкнуть тип — и каждый из этих жестов кому-то ломает жизнь. Прежде
// «кому» знал только автор правки; список в коде устаревал бы на первом же сохранённом
// запросе владельца, потому что половина зависимостей — ЕГО, а не наша.
//
// НАПРАВЛЕНИЕ РЕБРА ОДНО НА ВЕСЬ ГРАФ: `from` ЗАВИСИТ ОТ `to`. Из этого и получается
// `dependantsOf` — «кто указывает на этот узел». Смешать направления (аспект → свойство, но
// свойство → аспект) значило бы граф, в котором `dependantsOf` отвечает то одно, то другое;
// поэтому `scope` и `ref.target` дают ребро ОТ свойства (оно зависит от аспекта, который
// называет), а объявление аспекта — ребро ОТ аспекта.
//
// Чистая функция от снимка и списка держателей: БД здесь нет намеренно — тот же граф считает
// и сервер (ручка `registry.dependants`), и, когда дойдёт очередь, экран настроек (§С4,
// срез Б-3), а два экземпляра правил разошлись бы на первом же новом роде зависимости.
import type { PropertyType } from '@orbis/shared';
import { ExecError } from '../errors';
import type { RegistrySnapshot } from './load';

/**
 * Род зависимости — не украшение выдачи, а объяснение владельцу, ПОЧЕМУ он не может
 * тронуть свойство: «его объявляет аспект» и «на него ссылается сохранённый запрос» — это
 * разные разговоры и разные способы развязаться.
 */
export type DependencyEdgeKind = 'aspect' | 'scope' | 'ref.target' | 'query' | 'merged_into';

export interface DependencyEdge {
  /** Кто зависит: id аспекта, свойства либо держателя запроса (сущности). */
  from: string;
  /** От кого: id свойства либо аспекта. */
  to: string;
  kind: DependencyEdgeKind;
}

export interface DependencyGraph {
  edges: DependencyEdge[];
}

/**
 * Держатели сохранённых запросов: id держателя → имена свойств, которые он называет.
 *
 * Карта, а не список пар: у одного держателя ссылок обычно несколько, и пары дали бы
 * вызывающему повод собрать их в карту у себя — то есть второе место, где решается, что
 * считать одним держателем. Собирает её `collectQueryHolders` (`registry/ops.ts`), она же
 * кормит переписывание ссылок при слиянии: один обход на оба вопроса.
 */
export interface DependencyUsages {
  queryRefs: Map<string, string[]>;
}

/** Имена, которыми свойство адресуют: id (в дереве) и key (в тексте запроса, §А5-3а). */
function aliasIndex(reg: RegistrySnapshot): Map<string, string> {
  const byAlias = new Map<string, string>();
  for (const def of reg.properties.values()) {
    byAlias.set(def.id, def.id);
    // Своё определение перекрывает встроенное — то же правило, что у `resolvePropertyRef`:
    // строки идут `ORDER BY owner_id NULLS FIRST`, значит последняя запись и есть своя.
    byAlias.set(def.key, def.id);
  }
  return byAlias;
}

/** Аспекты, названные Q-AST: в срезе А `scope` и `ref.target` состоят из них и тегов. */
function aspectsNamedBy(value: unknown, out: Set<string>): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null) continue;
    if (!Array.isArray(node)) {
      const aspect = (node as Record<string, unknown>).aspect;
      if (typeof aspect === 'string') out.add(aspect);
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push(child);
  }
}

function targetsOf(type: PropertyType): unknown[] {
  if (type.kind !== 'ref' || type.target === undefined) return [];
  return Array.isArray(type.target) ? type.target : [type.target];
}

/**
 * Граф зависимостей реестра владельца (§А3-5).
 *
 * ПЯТЬ РОДОВ РЁБЕР — полный перечень для среза А, и каждый ловит свой способ «встать на
 * свойство»:
 *  - `aspect` — аспект объявляет свойство (`aspect.properties`); самая частая зависимость
 *    и та, из-за которой §А3-5 запрещает «просто удалить встроенное»;
 *  - `scope` — свойство показывается на записях аспекта (§А2-1, Р15);
 *  - `ref.target` — множество цели ссылочного свойства (§А6-1);
 *  - `query` — сохранённый запрос владельца: источник прогресса цели и блок `{{query:…}}`
 *    в теле. Именно эта половина и не могла быть списком в коде;
 *  - `merged_into` — поглощённое свойство указывает на своего преемника (Р10). Ребро нужно
 *    не отчёту, а проверке ацикличности: цепочка указателей — единственный способ замкнуть
 *    граф реестра в срезе А, и компактация (§А10-2) держится ровно на нём.
 *
 * Имена держателей запросов резолвятся в id через `aliasIndex`: в дереве §А5-7 лежит id, но
 * дерево приезжает и снаружи — входом `ast:` тула, где резолвер границы принимает и key, — а
 * ответ владельцу обязан быть один.
 */
export function dependencyGraph(reg: RegistrySnapshot, usages: DependencyUsages): DependencyGraph {
  const edges: DependencyEdge[] = [];
  const byAlias = aliasIndex(reg);

  for (const aspect of reg.aspects.values()) {
    for (const ref of aspect.properties) {
      edges.push({ from: aspect.id, to: ref.propertyId, kind: 'aspect' });
    }
  }

  for (const def of reg.properties.values()) {
    if (def.scope !== null) {
      const named = new Set<string>();
      aspectsNamedBy(def.scope, named);
      for (const aspectId of named) edges.push({ from: def.id, to: aspectId, kind: 'scope' });
    }
    for (const target of targetsOf(def.type)) {
      const named = new Set<string>();
      aspectsNamedBy(target, named);
      for (const aspectId of named) {
        edges.push({ from: def.id, to: aspectId, kind: 'ref.target' });
      }
    }
    if (def.mergedInto !== null) {
      edges.push({ from: def.id, to: def.mergedInto, kind: 'merged_into' });
    }
  }

  for (const [holder, names] of usages.queryRefs) {
    const seen = new Set<string>();
    for (const name of names) {
      const id = byAlias.get(name);
      // Имени, которого в реестре нет, ребра не достаётся, и таких имён здесь ДВА РОДА.
      // Первый — законные соседи по индексу `query_refs`: id аспекта, id роли, uuid цели
      // связи (`children_of=<id>`); они адресуют не свойство, и ребро «свойство → …» из них
      // не строится. Второй — опечатка владельца; рисовать её зависимостью значило бы
      // обещать, что она на что-то влияет. Отличать их здесь нечем и незачем: граф отвечает
      // на вопрос «кто стоит на СВОЙСТВЕ».
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      edges.push({ from: holder, to: id, kind: 'query' });
    }
  }
  return { edges };
}

/**
 * «Кто на нём стоит» (§А3-5) — узлы, зависящие от этого напрямую, без дублей и в
 * стабильном порядке.
 *
 * Порядок наблюдаем (ручка `registry.dependants` отдаёт список владельцу), и «как легли
 * рёбра» означало бы «как вернул SELECT»: держатели запросов приходят из БД.
 */
export function dependantsOf(graph: DependencyGraph, propertyId: string): string[] {
  const out = new Set<string>();
  for (const edge of graph.edges) if (edge.to === propertyId) out.add(edge.from);
  return [...out].sort();
}

/**
 * Замкнутый круг зависимостей — отказ `REGISTRY_CYCLE` с ПУТЁМ (§С7-11).
 *
 * В СРЕЗЕ А ЦИКЛОВ БЫТЬ НЕ МОЖЕТ, и это утверждение, а не надежда. Рёбра идут от аспекта к
 * свойству, от свойства к аспекту и от свойства к его преемнику; замкнуться могло бы только
 * последнее, и цепочку `merged_into` держат в один шаг ДВА правила сразу — компактация
 * (§А10-2 переводит указатели на поглощённое) и отказ `MERGE_ALREADY_MERGED`
 * (`registry/ops.ts`: ни источником, ни целью слияния не может быть уже поглощённая строка).
 * Одной компактации мало, и это найдено пробой: она выпрямляет только порядок «слили в то,
 * что потом слили дальше», а обратный («слить в уже поглощённое») давал `a → b → c` в два
 * шага. Проверка заведена сейчас потому, что первое ребро «свойство → правило → свойство»
 * приезжает с частью Б (§Б4), и заводить сторожа ВМЕСТЕ с тем, что он сторожит, — это
 * заводить его после первой аварии.
 *
 * Путь в `details` — не украшение: сообщение «где-то цикл» по графу в сотню рёбер
 * неотличимо от «разбирайтесь сами».
 */
export function assertAcyclicGraph(graph: DependencyGraph): void {
  const out = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = out.get(edge.from);
    if (list === undefined) out.set(edge.from, [edge.to]);
    else list.push(edge.to);
  }
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];

  const visit = (node: string): void => {
    const seen = state.get(node);
    if (seen === 'done') return;
    if (seen === 'open') {
      const from = path.indexOf(node);
      throw new ExecError(
        'REGISTRY_CYCLE',
        `зависимости реестра замкнулись: ${[...path.slice(from), node].join(' → ')}`,
        { cycle: [...path.slice(from), node] },
      );
    }
    state.set(node, 'open');
    path.push(node);
    for (const next of out.get(node) ?? []) visit(next);
    path.pop();
    state.set(node, 'done');
  };

  // Обход ИТЕРАТИВНЫМ входом по всем узлам, но рекурсивным спуском: глубина здесь — длина
  // цепочки зависимостей реестра (единицы), а не вложенность недоверенного дерева, и цена
  // явного стека тут была бы платой без покупки.
  for (const node of out.keys()) visit(node);
}
