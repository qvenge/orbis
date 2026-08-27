/**
 * ПЕРЕХОДНЫЙ мост «старая плоская грамматика §6.1 → канонический Q-AST §А5-7».
 *
 * Зачем он есть. Задача 9b переключает СЕРВЕР на канон, но боевые тексты запросов
 * (тела сидированных смарт-листов, тело проекта, Agenda, конструкторы web) написаны
 * старой грамматикой, и `parseQueryAst` их отвергает: значение с пробелом там не
 * закавычено (`title=Ждут ответа`), а core-свойства названы голым именем (`status=inbox`)
 * — полная опись с адресами и вердиктами лежит в `PRODUCTION_QUERY_TEXTS`
 * (`ast-fixtures.ts`). Перевод этих текстов — Задачи 10c (Agenda, web) и 21 (сиды и
 * остальное); до тех пор серверный разбор принимает ОБЕ формы, иначе смарт-листы,
 * Browser и бюджетные списки красны с первого же коммита 9b.
 *
 * ДАТА СМЕРТИ ФАЙЛА — Задача 21, и это проверяемое утверждение, а не обещание: он целиком
 * состоит из вызовов `parseQuery`/`propertyToLegacyField`, а Задача 21 сносит и старую
 * грамматику (`grammar.ts`/`parse.ts`/`serialize.ts`, РП-11), и переходную карту полей
 * (`legacy-field-map.ts`, РП-3). Признак, по которому следующий читатель поймёт, что
 * момент настал: `PRODUCTION_QUERY_TEXTS` пуст — переводить больше нечего.
 *
 * ЧЕЙ ОТКАЗ ВИДИТ ЧЕЛОВЕК. Ошибку наружу всегда отдаёт НОВАЯ грамматика: старая умирает,
 * и учить по её сообщениям («неизвестное поле 'orbis/task_status'») значит учить неправде.
 * Мост — тихий запасной путь, а не второй язык.
 */
import { propertyToLegacyField } from '../registry/legacy-field-map';
import type { PropertyDefinition } from '../registry/property-type';
import type { QueryAst, QueryBound, QueryFilterNode, QueryScalar, QuerySortField } from './ast';
import { buildCatalogFromRegistry, type FieldCatalog, type FieldInfo } from './catalog';
import type {
  QueryAst as LegacyQueryAst,
  QueryComparableValue,
  QueryFieldValue,
  QueryFilter,
} from './grammar';
import { parseQuery } from './parse';
import {
  isListPropertyType,
  type ParseAstResult,
  type ParseRegistry,
  parseQueryAst,
  type QueryParseCode,
} from './parse-ast';

/**
 * Коды новой грамматики, означающие «текст написан СТАРОЙ формой», — только на них мост и
 * включается. Каждый код здесь стоит потому, что боевые тексты его дают (опись
 * `PRODUCTION_QUERY_TEXTS`, поле `verdict`):
 *  - `UNKNOWN_FIELD` — голое имя core-свойства (`status=inbox`), 33 текста;
 *  - `SYNTAX` — незакавыченное значение с пробелом (`title=Ждут ответа`), 2 текста;
 *  - `RESERVED` — старое имя, ставшее словом грамматики (`sortBy=title:asc`), 2 текста —
 *    оба в бюджетном списке категорий с семью потребителями.
 *
 * Прочие коды (`UNKNOWN_ASPECT`, `TYPE`, `AMBIGUOUS_LABEL`, `QUERY_MULTI_ROLE`,
 * `QUERY_JOIN`, `CLASS_NOT_AVAILABLE`, `UNKNOWN_ROLE`) сюда НЕ входят намеренно: они
 * означают, что имя новая грамматика поняла, а запрос всё равно неверен, — запасной путь
 * такому тексту не поможет и только спрятал бы честный отказ.
 */
const LEGACY_FALLBACK_CODES: ReadonlySet<QueryParseCode> = new Set<QueryParseCode>([
  'UNKNOWN_FIELD',
  'SYNTAX',
  'RESERVED',
]);

/**
 * Core-свойства (§А1-3) под их СТАРЫМИ именами: старый резолв ловил их до каталога
 * (`parse.ts:339-342`), поэтому в каталоге аспектов их нет и через `propertyToLegacyField`
 * они не находятся. `title` попадает сюда только из `sortBy`: в позиции фильтра его ключ
 * занят параметром заголовка (§6.1), и отбор по заголовку старая грамматика делает
 * через `search=`.
 */
const CORE_LEGACY_PROPERTY: Readonly<Record<string, string>> = {
  created_at: 'orbis/created_at',
  updated_at: 'orbis/updated_at',
  title: 'orbis/title',
};

/** Отказ перевода. Наружу не выходит: `parseQueryAny` подменяет его отказом новой грамматики. */
class LegacyBridgeError extends Error {
  override readonly name = 'LegacyBridgeError';
}

function bridgeFail(message: string): never {
  throw new LegacyBridgeError(message);
}

/**
 * Каталог СТАРЫХ имён полей — из реестра свойств, а не из колонки `aspect_definitions.schema`.
 *
 * Источник один и тот же дважды не читается: имена берутся обратным ходом переходной карты
 * (`propertyToLegacyField`) по тем свойствам, которые аспект несёт СЕГОДНЯ, а типы и
 * варианты enum — тем же `buildCatalogFromRegistry`, которым их видит канон. Прямое
 * следствие, названное вслух: поле, которое §А8 УДАЛИЛА (`orbis/agent-run.project_id`),
 * здесь не резолвится вовсе — и это правда, а не пробел. Значение его никто не пишет с
 * вехи A (`agent-loop/verbs.ts`), и блок «Последние прогоны» в заготовке тела проекта
 * отдаёт отказ `UNKNOWN_FIELD` вместо прежнего пустого списка (тело переписывается
 * Задачей 21).
 */
export function legacyCatalogFromRegistry(reg: ParseRegistry): FieldCatalog {
  const byPropertyId = buildCatalogFromRegistry(reg);
  const fields: Record<string, FieldInfo[]> = {};
  for (const aspect of reg.aspects.values()) {
    for (const ref of aspect.properties) {
      const name = propertyToLegacyField(ref.propertyId, aspect.id);
      if (name === undefined) continue;
      const info = byPropertyId.fields[ref.propertyId]?.[0];
      if (info === undefined) continue;
      const list = fields[name];
      // Аспект-носитель здесь ОБЯЗАН быть тем, из которого пришло имя: старый резолв
      // разводит неоднозначные имена (`stage` у проекта и рутины) именно по нему.
      if (list) list.push({ ...info, aspect: aspect.id });
      else fields[name] = [{ ...info, aspect: aspect.id }];
    }
  }
  return { fields };
}

/** Индекс «старое имя → носители»: тот же, что у каталога, но с id свойства под рукой. */
interface LegacyFieldOwner {
  aspect: string;
  propertyId: string;
}

function legacyFieldIndex(reg: ParseRegistry): Map<string, LegacyFieldOwner[]> {
  const index = new Map<string, LegacyFieldOwner[]>();
  for (const aspect of reg.aspects.values()) {
    for (const ref of aspect.properties) {
      const name = propertyToLegacyField(ref.propertyId, aspect.id);
      if (name === undefined) continue;
      const list = index.get(name);
      if (list) list.push({ aspect: aspect.id, propertyId: ref.propertyId });
      else index.set(name, [{ aspect: aspect.id, propertyId: ref.propertyId }]);
    }
  }
  return index;
}

/**
 * Аспекты, НАЗВАННЫЕ запросом, — для резолва неоднозначного имени поля (§А5-3ж, `aspect=`
 * разводит подписи). Обход итеративный, а не рекурсивный: дерево приезжает недоверенным
 * входом `ast:` тула, и рекурсия по нему исчерпала бы стек на том же входе, на котором его
 * исчерпывает zod (см. докблок `queryFilterNodeSchema`).
 *
 * Узлы под `not` СЧИТАЮТСЯ: «покажи не-задачи» тоже называет аспект `orbis/task` — это
 * подсказка о том, про что запрос, а не про то, что попадёт в выдачу. Ровно так же вёл
 * себя старый резолв (`compile.ts`, `aspectsInQuery` — файл снят Задачей 9b, читается по
 * git-истории): он собирал `aspect=` со всего
 * плоского списка, где отрицания как узла не было вовсе.
 */
export function aspectsNamedInQueryAst(ast: QueryAst): Set<string> {
  const found = new Set<string>();
  const stack: QueryFilterNode[] = ast.filter === null ? [] : [ast.filter];
  while (stack.length > 0) {
    const node = stack.pop() as QueryFilterNode;
    if ('aspect' in node) found.add(node.aspect);
    else if ('and' in node) stack.push(...node.and);
    else if ('or' in node) stack.push(...node.or);
    else if ('not' in node) stack.push(node.not);
  }
  return found;
}

/**
 * Старое имя поля → id свойства канона (§А5-2: в дереве лежат id, не подписи).
 *
 * Правила резолва повторяют `resolveField` старого парсера: сначала core-имена, затем
 * каталог, неоднозначность разводится аспектами, названными в запросе. Экспортирован
 * потому, что имя поля приезжает не только из текста запроса: тем же именем адресуют поле
 * агрегата `user_query.field` и источник прогресса цели (`progress_source.field`), и второй
 * резолв разошёлся бы с этим на первом же слитом свойстве (`category_ref` — и в
 * `orbis/financial`, и в `orbis/budget`).
 */
export function resolveLegacyFieldId(
  field: string,
  reg: ParseRegistry,
  aspectsInQuery: ReadonlySet<string> = new Set(),
): string | undefined {
  // Имя может быть уже каноническим — id или key свойства: так его пишут переведённые
  // потребители, и заставлять их говорить по-старому ради моста было бы шагом назад.
  if (reg.properties.has(field)) return field;
  for (const prop of reg.properties.values()) {
    if (prop.key === field) return prop.id;
  }
  const core = CORE_LEGACY_PROPERTY[field];
  if (core !== undefined) return reg.properties.has(core) ? core : undefined;
  const owners = legacyFieldIndex(reg).get(field) ?? [];
  if (owners.length === 1) return (owners[0] as LegacyFieldOwner).propertyId;
  if (owners.length === 0) return undefined;
  const narrowed = owners.filter((o) => aspectsInQuery.has(o.aspect));
  if (narrowed.length === 1) return (narrowed[0] as LegacyFieldOwner).propertyId;
  // Слитые свойства (§А8/В1): у `category_ref` и `currency` носителей два, но свойство
  // одно — такое имя однозначно, хотя аспектов и несколько.
  const ids = new Set(owners.map((o) => o.propertyId));
  return ids.size === 1 ? (owners[0] as LegacyFieldOwner).propertyId : undefined;
}

/** Значение старой формы — всегда ТЕКСТ; канон хочет типизированный скаляр (§А5-7). */
function scalarOf(def: PropertyDefinition, text: string): QueryScalar {
  switch (def.type.kind) {
    case 'number': {
      const n = Number(text);
      if (!Number.isFinite(n)) bridgeFail(`'${text}' не число для свойства '${def.key}'`);
      return n;
    }
    case 'boolean': {
      if (text === 'true') return true;
      if (text === 'false') return false;
      return bridgeFail(`'${text}' не true/false для свойства '${def.key}'`);
    }
    default:
      // decimal остаётся СТРОКОЙ (хвост копеек, §А7-3); text/date/timestamp/time/select/
      // ref/grant/registry_ref — текстовая проекция значения.
      return text;
  }
}

function boundOf(def: PropertyDefinition, value: QueryFieldValue): QueryBound {
  return value.kind === 'date_token' ? { token: value.token } : scalarOf(def, value.value);
}

function comparableOf(def: PropertyDefinition, value: QueryComparableValue): QueryBound {
  return scalarOf(def, value.value);
}

function anyOf(nodes: QueryFilterNode[]): QueryFilterNode {
  if (nodes.length === 0) bridgeFail('пустой список значений');
  return nodes.length === 1 ? (nodes[0] as QueryFilterNode) : { or: nodes };
}

/** Аспект по id, а при промахе — по key: старые тексты называют его id (`aspect=orbis/task`). */
function aspectId(raw: string, reg: ParseRegistry): string {
  if (reg.aspects.has(raw)) return raw;
  for (const aspect of reg.aspects.values()) {
    if (aspect.key === raw) return aspect.id;
  }
  return bridgeFail(`неизвестный аспект '${raw}'`);
}

function propertyOf(field: string, reg: ParseRegistry, aspects: ReadonlySet<string>) {
  const id = resolveLegacyFieldId(field, reg, aspects);
  if (id === undefined) bridgeFail(`поле '${field}' не резолвится в свойство реестра`);
  const def = reg.properties.get(id);
  if (def === undefined) bridgeFail(`свойства '${id}' нет в реестре`);
  return def;
}

/**
 * Узел предиката свойства. Оператор равенства выбирается ТАК ЖЕ, как в новом парсере
 * (`parsePropNode`): у списочного свойства равенства нет, есть вхождение элемента.
 */
function propNode(
  def: PropertyDefinition,
  op: 'eq' | 'gt' | 'lt' | 'contains',
  value: QueryBound,
): QueryFilterNode {
  return { prop: def.id, op, value };
}

function eqOpOf(def: PropertyDefinition): 'eq' | 'contains' {
  return isListPropertyType(def.type) ? 'contains' : 'eq';
}

function tagsNode(values: readonly string[]): QueryFilterNode {
  return anyOf(values.map((v) => ({ tag: v }) as QueryFilterNode));
}

/**
 * `excludeBlocked=true` переводится ЧЕРЕЗ НОВЫЙ ПАРСЕР, а не собирается здесь руками.
 *
 * Сахар — не форма значения, а определение («не заблокировано живой работой»), и живёт оно
 * ровно в одном месте (`parse-ast.ts`, ветка `excludeBlocked`). Собери мост своё дерево
 * рядом — и `isExcludeBlockedSugar` перестала бы узнавать половину запросов, то есть
 * key-печать отдала бы им другой текст, а дифф предложений Ш1 перестал бы видеть правку.
 * Цена — один разбор трёхсловной строки на вхождение сахара в запросе.
 */
function excludeBlockedNode(reg: ParseRegistry): QueryFilterNode {
  const parsed = parseQueryAst('excludeBlocked=true', reg);
  if (!parsed.ok || parsed.ast.filter === null) {
    bridgeFail(
      `сахар excludeBlocked не собрался: ${parsed.ok ? 'пустое дерево' : parsed.error.message}`,
    );
  }
  return parsed.ast.filter;
}

function filterNode(
  f: QueryFilter,
  reg: ParseRegistry,
  aspects: ReadonlySet<string>,
): QueryFilterNode {
  switch (f.kind) {
    case 'tags':
      return tagsNode(f.values);
    case 'excludeTags':
      // Сахар старой грамматики; канон — отрицание над деревом (§А5-7), как и у нового парсера.
      return { not: tagsNode(f.values) };
    case 'aspect':
      return { aspect: aspectId(f.aspect, reg) };
    case 'archived':
      return { archived: f.value };
    case 'children_of':
    case 'parents_of':
      // Без `via`: предикат идёт по СЕМЕЙСТВУ иерархии — ровно то, чем была relation
      // `parent` старой грамматики (§А4-2).
      return { rel: { kind: f.kind, of: f.of.kind === 'this' ? 'this' : f.of.id } };
    case 'excludeBlocked':
      return excludeBlockedNode(reg);
    case 'comparison': {
      const def = propertyOf(f.field, reg, aspects);
      return propNode(def, f.op === '>' ? 'gt' : 'lt', comparableOf(def, f.value));
    }
    case 'range': {
      const def = propertyOf(f.field, reg, aspects);
      return {
        prop: def.id,
        op: 'range',
        value: { from: comparableOf(def, f.min), to: comparableOf(def, f.max) },
      };
    }
    case 'field': {
      const def = propertyOf(f.field, reg, aspects);
      const op = eqOpOf(def);
      const nodes = f.condition.values.map((v) => propNode(def, op, boundOf(def, v)));
      // `noneOf` — «ни одно из»: дерево `not(or(...))`, второго узла канон не заводит.
      return f.condition.kind === 'anyOf' ? anyOf(nodes) : { not: anyOf(nodes) };
    }
  }
}

function sortField(
  s: { field: string; direction: 'asc' | 'desc' },
  reg: ParseRegistry,
  aspects: ReadonlySet<string>,
): QuerySortField {
  return { field: propertyOf(s.field, reg, aspects).id, dir: s.direction };
}

/**
 * Плоский AST старой грамматики → канон §А5-7. Бросает при непереводимом входе (поле без
 * свойства, значение не того типа): наружу этот отказ не выходит — `parseQueryAny`
 * подменяет его отказом новой грамматики.
 *
 * Порядок узлов сохраняется, а `search=` приезжает ПОСЛЕДНИМ — так же, как его дописывал
 * старый компилятор (`compile.ts`, `compileWhere`; файл снят Задачей 9b): дерево читается
 * как тот же запрос.
 */
export function legacyAstToQueryAst(legacy: LegacyQueryAst, reg: ParseRegistry): QueryAst {
  const aspects = new Set<string>();
  for (const f of legacy.filters) {
    if (f.kind === 'aspect') aspects.add(aspectId(f.aspect, reg));
  }
  const nodes = legacy.filters.map((f) => filterNode(f, reg, aspects));
  if (legacy.search !== undefined) nodes.push({ search: legacy.search });
  const ast: QueryAst = {
    filter:
      nodes.length === 0
        ? null
        : nodes.length === 1
          ? (nodes[0] as QueryFilterNode)
          : { and: nodes },
  };
  if (legacy.sortBy !== undefined)
    ast.sortBy = legacy.sortBy.map((s) => sortField(s, reg, aspects));
  if (legacy.limit !== undefined) ast.limit = legacy.limit;
  if (legacy.display !== undefined) ast.display = legacy.display;
  if (legacy.title !== undefined) ast.title = legacy.title;
  return ast;
}

/**
 * Разбор текста, принимающий ОБЕ формы: сначала новая грамматика (§А5-3), при её отказе
 * кодом «текст старой формы» — старая через мост.
 *
 * Отказ, который увидит человек, ВСЕГДА от новой грамматики — и когда мост не позвали, и
 * когда он не справился (см. шапку файла).
 *
 * ЦЕНА ЭТОГО ПРАВИЛА, названная вслух: у текста СТАРОЙ формы с настоящей ошибкой человек
 * увидит не её. `'aspect=orbis/task, status=inbox, display=мозаика'` разбирается мостом до
 * `display`, спотыкается на нём — и наружу уходит отказ новой грамматики про `status`
 * («неизвестное свойство»), потому что именно на нём она остановилась первой. Настоящая
 * причина («display: compact, list или table») не называется никогда.
 *
 * Почему цена принята. Альтернатива — отдавать отказ СТАРОЙ грамматики, когда мост был
 * позван, — учит умирающему языку: человек чинит `display`, получает работающий запрос
 * старой формы и узнаёт о переводе только в Задаче 21, когда мост исчезнет и красным
 * станет уже всё. §А5-3ж при этом не нарушен: отказ есть, он структурный и с позицией,
 * молчаливого нуля нет. Цена конечна по времени (умирает с мостом) и по объёму (49
 * боевых текстов описи, все переводятся Задачами 10c и 21).
 */
export function parseQueryAny(text: string, reg: ParseRegistry): ParseAstResult {
  const fresh = parseQueryAst(text, reg);
  if (fresh.ok || !LEGACY_FALLBACK_CODES.has(fresh.error.code)) return fresh;
  const legacy = parseQuery(text, legacyCatalogFromRegistry(reg));
  if (!legacy.ok) return fresh;
  try {
    return { ok: true, ast: legacyAstToQueryAst(legacy.ast, reg) };
  } catch (e) {
    if (e instanceof LegacyBridgeError) return fresh;
    throw e;
  }
}
