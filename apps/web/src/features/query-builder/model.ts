/**
 * Модель формы-редактора query-блока: что канон §А5-7 позволяет собрать плоским сахаром
 * грамматики v1 и как дерево формы превращается обратно в строку блока.
 *
 * Состояние формы — сам `QueryAst`, а не своя структура: любое отображение «AST → поля формы
 * → AST» теряло бы конструкции, которых в отображении нет (два `tags=`, второе сравнение по
 * тому же свойству). Форма правит узлы на месте, порядок сохраняется, а всё, чего её контролы
 * не покрывают, доезжает до печати нетронутым.
 *
 * ГРАНИЦА ФОРМЫ, названная вслух: блок до Задачи 21 хранит ТЕКСТ, а текст грамматики v1
 * плоский (§А5-3д) — скобок в нём нет. Поэтому форма работает с ВЕРХНИМ уровнем дерева как со
 * списком конструкций, а OR допускает только внутри одного свойства (`{or:[…]}` по значениям).
 * OR между разными свойствами она собрать не даёт вовсе: собранное было бы невыразимо текстом
 * и не сохранилось бы (кнопка «ИЛИ между полями» в `QueryBuilderForm` погашена именно этим).
 *
 * ДВА ИСТОЧНИКА ЗНАНИЯ О СВОЙСТВЕ, и это не дубль. Тип берётся из КАТАЛОГА
 * (`buildCatalogFromRegistry`, поле `kind`): там он приходит из `PropertyType` реестра, без
 * единой эвристики по тексту регэкспа, которой держался старый каталог по JSON Schema.
 * Подпись, ключ и варианты `select` берутся из самой декларации свойства — у каталога подписей
 * нет вовсе (`enumValues` несёт только ключи), а форма обязана показывать человеку подпись, а
 * не машинную ручку. Носители свойства считаются по декларациям аспектов, а НЕ по
 * `FieldInfo.aspect`: то поле заполнено только у свойств с ЕДИНСТВЕННЫМ носителем
 * (`orbis/currency` живёт на двух, и там оно пусто), а видимость строки обязана работать и
 * для них.
 */

import type { PropertyKind } from '@orbis/shared';
import type { QueryAst, QueryBound, QueryFilterNode, QueryScalar } from '@orbis/shared/query';
import {
  acceptsDateTokenKind,
  isListPropertyType,
  isOrderedPropertyKind,
  parseQueryAst,
  printQueryAst,
} from '@orbis/shared/query';
import type { QueryRegistry } from '../../lib/query-blocks/catalog';

/** Оператор строки поля. Пустая строка — «фильтра по этому свойству нет». */
export type Operator = '' | 'anyOf' | 'noneOf' | 'gt' | 'lt' | 'range';

/** Разобранная строка поля: одно свойство, один оператор, его значения. */
export interface FieldNodeView {
  prop: string;
  op: Exclude<Operator, ''>;
  /** Значения списка — только у `anyOf`/`noneOf`. */
  values: QueryBound[];
  /** Левая граница `range` либо единственная граница `gt`/`lt`. */
  from: QueryBound | null;
  /** Правая граница `range`. */
  to: QueryBound | null;
}

/**
 * Верхний уровень фильтра как ПЛОСКИЙ список конструкций — ровно то, что печатается текстом
 * через запятую. `null` — фильтра нет, одиночный узел — список из одного.
 */
export function topNodes(ast: QueryAst): QueryFilterNode[] {
  if (ast.filter === null) return [];
  return 'and' in ast.filter ? [...ast.filter.and] : [ast.filter];
}

/** Обратная сборка: список конструкций → корень фильтра. */
export function withNodes(ast: QueryAst, nodes: QueryFilterNode[]): QueryAst {
  const filter: QueryFilterNode | null =
    nodes.length === 0 ? null : nodes.length === 1 ? (nodes[0] as QueryFilterNode) : { and: nodes };
  return { ...ast, filter };
}

/** id аспектов, названных `aspect=` — по ним видны свойства их носителей. */
export function aspectsOf(nodes: readonly QueryFilterNode[]): string[] {
  return nodes.flatMap((n) => ('aspect' in n ? [n.aspect] : []));
}

// ─────────────────────────── Строка поля ───────────────────────────

/** Лист «свойство равно значению» — из них складываются списки `anyOf`/`noneOf`. */
function eqLeaf(node: QueryFilterNode): { prop: string; value: QueryBound } | null {
  if (!('prop' in node)) return null;
  if (node.op !== 'eq' && node.op !== 'contains') return null;
  return { prop: node.prop, value: node.value as QueryBound };
}

/** `{or:[…]}` по ОДНОМУ свойству — единственная форма OR, выразимая плоским текстом. */
function sameProp(
  nodes: readonly QueryFilterNode[],
): { prop: string; values: QueryBound[] } | null {
  const values: QueryBound[] = [];
  let prop: string | null = null;
  for (const node of nodes) {
    const leaf = eqLeaf(node);
    if (!leaf) return null;
    if (prop !== null && prop !== leaf.prop) return null;
    prop = leaf.prop;
    values.push(leaf.value);
  }
  return prop === null ? null : { prop, values };
}

/** Положительная (не отрицаемая) часть строки поля. */
function positive(node: QueryFilterNode): FieldNodeView | null {
  if ('or' in node) {
    const same = sameProp(node.or);
    if (same === null) return null;
    return { prop: same.prop, op: 'anyOf', values: same.values, from: null, to: null };
  }
  if (!('prop' in node)) return null;
  const base = { prop: node.prop, values: [] as QueryBound[], from: null, to: null };
  switch (node.op) {
    case 'eq':
    case 'contains':
      return { ...base, op: 'anyOf', values: [node.value as QueryBound] };
    // `in` каноничен, но текстом не порождается: его вход — `ast:` тула (§А5-4). Показываем
    // тем же списком, что и `or`, — печать у них одна (`p=a|b`).
    case 'in':
      return { ...base, op: 'anyOf', values: [...(node.value as QueryScalar[])] };
    // `p!=v` и `p=!v` — одно «не равно» с разной текстовой формой. Строка показывает их
    // одинаково, а правка значений печатает `=!v` — ту форму, которую собирает сама форма.
    case 'ne':
      return { ...base, op: 'noneOf', values: [node.value as QueryBound] };
    case 'gt':
      return { ...base, op: 'gt', from: node.value as QueryBound };
    case 'lt':
      return { ...base, op: 'lt', from: node.value as QueryBound };
    default: {
      const range = node.value as { from?: QueryBound; to?: QueryBound };
      return { ...base, op: 'range', from: range.from ?? null, to: range.to ?? null };
    }
  }
}

/** Узел → строка поля; `null` — конструкция не про свойство (аспект, тег, связь, поиск). */
export function fieldNodeView(node: QueryFilterNode): FieldNodeView | null {
  if ('not' in node) {
    const inner = positive(node.not);
    // Отрицание форма выражает только над списком значений: `!(a>5)` плоский текст не
    // печатает, и строки такой узел не получает — он доезжает до печати нетронутым.
    if (inner === null || inner.op !== 'anyOf') return null;
    return { ...inner, op: 'noneOf' };
  }
  return positive(node);
}

// ─────────────────────────── Свойство в терминах формы ───────────────────────────

export interface FieldRef {
  /** id свойства — то, что лежит в узле `{prop}` канона (§А5-7). */
  id: string;
  /** namespaced key — машинная ручка имени в тексте запроса (§А5-3а). */
  key: string;
  /** Подпись в локали владельца — доступное имя контрола (§А2-1). */
  label: string;
  kind: PropertyKind;
  /** Списочное свойство: равенство у него — вхождение элемента (`contains`). */
  list: boolean;
  /** Варианты `select` в порядке `rank`: хранится `key`, показывается `label`. */
  options?: Array<{ key: string; label: string }>;
}

/**
 * Подпись записи реестра в локали читателя: локаль → en → любая (§А2-1). Правило то же, что у
 * `effectiveLabel` разбора, и именно поэтому оно повторено здесь одной строкой, а не позвано:
 * там оно применяется к записи РЕЕСТРА, а форме нужны ещё и подписи ВАРИАНТОВ `select`,
 * которые записью реестра не являются.
 */
export function labelOfText(text: Record<string, string>, locale: string): string {
  return text[locale] ?? text.en ?? (Object.values(text)[0] as string);
}

/**
 * Свойство в терминах формы; `null` — такого id в реестре нет (запрос пережил удаление
 * свойства). Каталог и словарь свойств строятся из одного снимка, поэтому расходиться им
 * негде — но молча подставлять выдуманный тип нельзя, и потому исход именной.
 */
export function fieldRef(id: string, reg: QueryRegistry): FieldRef | null {
  const def = reg.parse.properties.get(id);
  const kind = reg.catalog.fields[id]?.[0]?.kind;
  if (def === undefined || kind === undefined) return null;
  const ref: FieldRef = {
    id,
    key: def.key,
    label: labelOfText(def.label, reg.parse.locale),
    kind,
    list: isListPropertyType(def.type),
  };
  if (def.type.kind === 'select') {
    ref.options = [...def.type.options]
      .sort((a, b) => a.rank - b.rank)
      .map((o) => ({ key: o.key, label: labelOfText(o.label, reg.parse.locale) }));
  }
  return ref;
}

/**
 * Core-проекции (§А1-3), которым форма рисует строку фильтра наравне с доменными свойствами:
 * носителя-аспекта у них нет, и без явного списка они не появились бы ни при одном `aspect=`.
 *
 * Двух других core-проекций здесь нет, и обе отсутствуют НАМЕРЕННО:
 *  - `orbis/archived` — у него в форме свой контрол («Архивные», три состояния грамматики
 *    `archived=true|any`), а вторая строка по тому же свойству дала бы два узла, спорящих
 *    друг с другом в одном запросе;
 *  - `orbis/title` — фильтром он и раньше не предлагался (ключ `title=` в позиции фильтра
 *    занят параметром заголовка выдачи), а отбор по заголовку продукт делает через `search=`
 *    — подстрокой, а не точным равенством. Namespaced key снял ЗАПРЕТ (`orbis/title=Дом`
 *    разбирается), но не сделал точное совпадение заголовка осмысленным выбором в форме.
 *    Сортировке `orbis/title` доступен по-прежнему (`sortableFieldIds`).
 */
const CORE_FIELD_IDS: readonly string[] = ['orbis/created_at', 'orbis/updated_at'];

/** Свойство → аспекты-носители (§А3-1): по ним решается видимость строки. */
function carrierIndex(reg: QueryRegistry): Map<string, Set<string>> {
  const carriers = new Map<string, Set<string>>();
  for (const aspect of reg.aspects) {
    for (const ref of aspect.properties) {
      const set = carriers.get(ref.propertyId);
      if (set) set.add(aspect.id);
      else carriers.set(ref.propertyId, new Set([aspect.id]));
    }
  }
  return carriers;
}

/**
 * Свойства, которым форма рисует строки: core-проекции, свойства выбранных аспектов и те, по
 * которым уже есть узел (снятый аспект не должен прятать живой фильтр — иначе он уехал бы в
 * блок невидимым). Порядок — `rank` реестра.
 *
 * Вложенный объект (`orbis/recurrence`, `orbis/progress_source`) отсеивается: выразимого
 * грамматикой фильтра у него нет, и контрол предлагал бы выбор, который заведомо не
 * сохранится. Списочные свойства (`orbis/aliases`) ОСТАЮТСЯ — у них честный `contains`.
 */
export function visibleFieldIds(
  nodes: readonly QueryFilterNode[],
  reg: QueryRegistry,
  selected: ReadonlySet<string>,
): string[] {
  const used = new Set<string>();
  for (const node of nodes) {
    const view = fieldNodeView(node);
    if (view !== null) used.add(view.prop);
  }
  const carriers = carrierIndex(reg);
  const ids: string[] = [];
  for (const def of reg.properties) {
    const owners = carriers.get(def.id);
    const shown =
      CORE_FIELD_IDS.includes(def.id) ||
      used.has(def.id) ||
      (owners !== undefined && [...owners].some((a) => selected.has(a)));
    if (!shown) continue;
    const ref = fieldRef(def.id, reg);
    if (ref === null || ref.kind === 'json') continue;
    ids.push(def.id);
  }
  return ids;
}

/**
 * Свойства, доступные сортировке (§А5-3): у списка и вложенного объекта линейного порядка нет,
 * и разбор по обоим отказывает («по свойству … сортировать нельзя»). Отсюда асимметрия с
 * фильтрами: списочное свойство там разрешено, здесь — нет.
 *
 * Список НЕ сужается выбранными аспектами — как и раньше: сортировать осмысленно и по
 * свойству, которого нет в `aspect=` (отбор по тегам, порядок по сумме).
 */
export function sortableFieldIds(reg: QueryRegistry): string[] {
  const ids: string[] = [];
  for (const def of reg.properties) {
    const ref = fieldRef(def.id, reg);
    if (ref === null || ref.list || ref.kind === 'json') continue;
    ids.push(def.id);
  }
  return ids;
}

/** Допустим ли оператор сравнения: решает ЯЗЫК (`isOrderedPropertyKind`), а не форма. */
export function isComparable(ref: FieldRef): boolean {
  return !ref.list && isOrderedPropertyKind(ref.kind);
}

/** Значения, которые свойство принимает списком: варианты `select`, у boolean — два флага. */
export function listedValues(ref: FieldRef): Array<{ key: string; label: string }> | null {
  if (ref.options) return ref.options;
  // У boolean вариантов в реестре нет, и подписью служит сам литерал грамматики: он же
  // уезжает в текст блока, и переводить его словом «да» значило бы показать одно, а
  // записать другое.
  return ref.kind === 'boolean'
    ? [
        { key: 'true', label: 'true' },
        { key: 'false', label: 'false' },
      ]
    : null;
}

/** Принимает ли свойство относительное время вместо литерала (§А5-7). */
export function isDateLike(ref: FieldRef): boolean {
  return acceptsDateTokenKind(ref.kind);
}

/**
 * Стартовое значение нового условия: осмысленное для типа и всегда печатаемое.
 *
 * Литералы форма держит СТРОКАМИ, даже у чисел и флагов: в поле ввода лежит текст, и
 * приведение его к числу на каждый набранный символ делало бы «12.» и «-» непечатаемыми
 * посреди набора. Печать строки даёт тот же текст (`orbis/amount>1000`), а тип проверяет
 * обратный разбор — там, где ошибку видно человеку.
 */
export function defaultValue(ref: FieldRef): QueryBound {
  const listed = listedValues(ref);
  if (listed) return listed[0]?.key ?? '';
  if (isDateLike(ref)) return { token: 'today' };
  return '';
}

// ─────────────────────────── Сборка узлов ───────────────────────────

/** Узел списка значений: у списочного свойства равенство — вхождение элемента (§А5-7). */
export function listNode(
  ref: FieldRef,
  op: 'anyOf' | 'noneOf',
  values: readonly QueryBound[],
): QueryFilterNode {
  const eq = ref.list ? ('contains' as const) : ('eq' as const);
  const leaves: QueryFilterNode[] = values.map((value) => ({ prop: ref.id, op: eq, value }));
  const inner: QueryFilterNode =
    leaves.length === 1 ? (leaves[0] as QueryFilterNode) : { or: leaves };
  return op === 'noneOf' ? { not: inner } : inner;
}

/**
 * Узел сахара `excludeBlocked=true` — «скрыть заблокированные живой работой» (§А5-3).
 *
 * Строит его САМ РАЗБОР, а не литералы формы: сахар — это конкретные id роли и свойства из
 * реестра плюс набор значений «закрытая работа», и вторая копия этого знания в web разошлась
 * бы с языком молча (ровно тот довод, по которому печать спрашивает `isExcludeBlockedSugar` у
 * парсера, а не сверяет своими литералами). `null` — в реестре нет роли `dependency` или
 * свойства `orbis/task_status`: тогда контрола в форме нет вовсе, и это честнее галочки,
 * которая записала бы ссылку в никуда.
 */
export function excludeBlockedNode(reg: QueryRegistry): QueryFilterNode | null {
  const r = parseQueryAst('excludeBlocked=true', reg.parse);
  return r.ok ? r.ast.filter : null;
}

/** Узел строгого сравнения (§А5-7: включающая граница выражается `range`). */
export function boundNode(ref: FieldRef, op: 'gt' | 'lt', value: QueryBound): QueryFilterNode {
  return { prop: ref.id, op, value };
}

export function rangeNode(ref: FieldRef, from: QueryBound, to: QueryBound): QueryFilterNode {
  return { prop: ref.id, op: 'range', value: { from, to } };
}

// ─────────────────────────── Печать и разбор ───────────────────────────

export type Printed = {
  /** Строка блока; null — печатать нельзя (см. `error`). */
  text: string | null;
  /** Почему строку нельзя записывать; null — всё в порядке. */
  error: string | null;
};

/**
 * AST формы → текст блока в КЛЮЧЕВОЙ форме (§А5-2: key — канон) с проверкой, что он
 * разберётся обратно НОВОЙ грамматикой.
 *
 * Обратный разбор не лишний: печать ТОТАЛЬНА (`printQueryAst` печатает любое дерево, в том
 * числе скобками), а грамматика v1 плоская — дерево, которое форма собрать не даёт, но
 * которое приехало из блока, обязано быть видно ДО записи, а не красной плашкой после.
 * Разбор здесь СТРОГИЙ (`parseQueryAst`): форма печатает канон, и обратный разбор обязан
 * читать ровно то, что она напечатала. Другой формы текста и не осталось — мост старой
 * грамматики снят Задачей 21b.
 *
 * ПРО `}}` ЗДЕСЬ ПРОВЕРКИ БОЛЬШЕ НЕТ, и это не упущение. Раньше форма отказывалась печатать
 * значение с `}}` — конец обёртки `{{query:…}}` закрыл бы блок на первом вхождении, и хвост
 * запроса уехал бы текстом заметки. Теперь эту половину закрывает САМА ПЕЧАТЬ: `quoteQueryValue`
 * разводит `}` бэкслешем (`query/print.ts`), разбор снимает экран тем же правилом, и `}}` в
 * напечатанной key-форме не появляется в принципе. Барьер остался там, где он ещё нужен, — на
 * СЫРОМ тексте, который до дерева не доехал (`QueryTextEditor`, `QueryWidget.save`).
 */
export function printQuery(ast: QueryAst, reg: QueryRegistry): Printed {
  const text = printQueryAst(ast, reg.parse, 'key');
  const back = parseQueryAst(text, reg.parse);
  return { text, error: back.ok ? null : back.error.message };
}

/**
 * AST для формы: текст обязан и разобраться, и напечататься обратно. Не напечатался — форма
 * таким блоком не управляет, и вызывающий обязан открыть строковый редактор (иначе первое же
 * сохранение молча потеряло бы конструкцию).
 *
 * Разбор СТРОГИЙ: тела сидированных смарт-листов переведены в key-форму (Задача 21b), и
 * мост старой грамматики, который держал «Настроить» открытым на них формой, а не текстовым
 * редактором, удалён вместе с ней.
 */
export function parseForForm(initial: string, reg: QueryRegistry): QueryAst | null {
  const r = parseQueryAst(initial.trim(), reg.parse);
  if (!r.ok) return null;
  return printQuery(r.ast, reg).text === null ? null : r.ast;
}
