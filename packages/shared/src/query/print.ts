/**
 * Печать канонического Q-AST (§А5-2: «печать — проекция при чтении: key для машин, label
 * для человека — два рендера одного AST»). После переименования подписи устаревать нечему:
 * в дереве лежат id, а имя подставляется на печати.
 *
 * Key-форма КАНОНИЧЕСКАЯ: по ней меряет дифф Ш1 (§А5-2), и она обратима — `parse(print(a))`
 * даёт то же дерево (доказано `print.test.ts`, а не обещано докблоком).
 *
 * «Детерминированный порядок узлов» здесь означает: одно и то же дерево ВСЕГДА печатается
 * одним и тем же текстом. Порядок детей `and`/`or` печать НЕ переставляет — он часть
 * дерева: сортировка сделала бы `parse(print(a)) ≡ a` неверным для любого дерева, собранного
 * формой не в алфавитном порядке. Проекция печатается фиксированным хвостом
 * (`sortBy`, `limit`, `display`, `title`), потому что она — не предикаты и порядка не несёт.
 *
 * Печать ТОТАЛЬНА, а грамматика v1 — плоская (§А5-3д). Дерево, которое плоским текстом не
 * выражается (OR между разными свойствами, вложенные группы), печатается СКОБКАМИ, и такой
 * текст парсер v1 честно отвергает. Асимметрия односторонняя и намеренная: дифф и экран
 * обязаны показать любое сохранённое дерево, а вводить скобками пока нечего.
 */
import type {
  QueryAst,
  QueryFilterNode,
  QueryPropValue,
  QueryRelPredicate,
  QueryScalar,
} from './ast';
import { QUERY_DATE_TOKENS } from './ast';
import { effectiveLabel, isExcludeBlockedSugar, type ParseRegistry } from './parse-ast';

export type QueryPrintForm = 'key' | 'label';

/**
 * Конец обёртки `{{query:…}}` — ЕДИНСТВЕННОЕ описание этой формы на стороне запроса.
 *
 * Живёт здесь, а рядом с самой обёрткой (`doc/nodes/query-block.ts`, `QUERY_BLOCK_CLOSE`) —
 * своя копия, и это не дубль по недосмотру: `@orbis/shared/doc` тянет схему редактора
 * целиком (~150 кБ gzip), и строковому редактору запроса, который об этот же маркер гасит
 * «Сохранить», такое ребро обошлось бы дороже двух символов. Разъехаться копиям нечем —
 * это конец разметки тела, а не правило грамматики, и меняться ему негде.
 *
 * Печать про него ЗНАЕТ: `}` входит в `QUOTE_TRIGGER_RE` ниже и экранируется внутри кавычек,
 * поэтому key-форма разобранного запроса обёртку не рвёт. Маркер нужен там, где текст пишет
 * человек и печать его не проверяла.
 */
export const BLOCK_END = '}}';

const DATE_TOKEN_WORDS: ReadonlySet<string> = new Set(QUERY_DATE_TOKENS);

/**
 * Символы, при которых значение обязано быть в кавычках: разделители конструкций (запятая
 * И пробел — §А5-3), оператор, разделители списка и отрицания, скобки печати, сами кавычки
 * с бэкслешем — и ЗАКРЫВАЮЩАЯ ФИГУРНАЯ СКОБКА.
 *
 * `}` попал сюда не из грамматики, а из РАЗМЕТКИ ТЕЛА: смарт-лист лежит в markdown внутри
 * обёртки `{{query:…}}`, токенайзер обёртки нежадный и кавычек не знает, поэтому `title=a}}b`
 * закрыл бы блок на первом `}}` — хвост запроса уехал бы прозой, а `{{query:` в этом хвосте
 * завёл бы ЛИШНИЙ блок. Одних кавычек мало (`"a}}b"` рвётся ровно так же), поэтому `escape`
 * ниже разводит скобки бэкслешем; разбор снимает его тем же правилом, что `\"` и `\\`.
 */
const QUOTE_TRIGGER_RE = /[\s,=|&<>!"\\()}]/;

/**
 * Кавычки нужны ещё в трёх случаях, где неквотированный текст вернулся бы ДРУГИМ AST:
 * `..` разобрался бы диапазоном; пустая строка — «пустое значение»; слово относительного
 * времени (`today`) стало бы токеном, а не литералом.
 */
function needsQuote(value: string): boolean {
  if (value === '') return true;
  if (value !== value.trim()) return true;
  if (value.includes('..')) return true;
  if (DATE_TOKEN_WORDS.has(value)) return true;
  return QUOTE_TRIGGER_RE.test(value);
}

/**
 * Экранирование внутри кавычек: бэкслеш, кавычка и `}` (см. `QUOTE_TRIGGER_RE`). Порядок
 * замен обязателен — бэкслеш первым, иначе он удвоил бы уже поставленные им же экраны.
 */
function escapeQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\}/g, '\\}');
}

/**
 * Значение → текст запроса: кавычки ставятся ровно там, где без них разбор вернул бы ДРУГОЕ
 * дерево (см. `needsQuote`).
 *
 * Экспортирована ради строителей текста в `apps/web` (`browser/query.ts`, `budget/txQuery.ts`):
 * они собирают запрос из ввода владельца — тега и строки поиска, — и до Задачи 21 несут
 * ТЕКСТ, а не AST, то есть печатают его мимо `printQueryAst`. Своя копия правила квотирования
 * там уже была и уже разошлась с грамматикой: `quoteValue` (`txQuery.ts`) не знала про пробел,
 * а `buildFilterQuery` не квотировала вовсе — два боевых текста описи (`SYNTAX`) родились
 * именно так. Одно правило на печать и на сборку — второму разъехаться уже не с чем.
 */
export function quoteQueryValue(value: string): string {
  return needsQuote(value) ? `"${escapeQuotes(value)}"` : value;
}

/** Имя в label-форме закавычено ВСЕГДА — кавычки и есть признак «это поле» (§А5-3б). */
function quoteAlways(value: string): string {
  return `"${escapeQuotes(value)}"`;
}

interface Names {
  prop(id: string): string;
  aspect(id: string): string;
  role(id: string): string;
  /** Совпадает ли реляционный предикат с сахаром `excludeBlocked=true` (см. его докблок). */
  isBlockedSugar(pred: QueryRelPredicate): boolean;
}

/**
 * Имя записи реестра в выбранной форме. Если id в реестре не нашёлся (запрос пережил
 * удаление свойства), печатается сам id: печать обязана быть тотальной — молча потерять
 * узел хуже, чем показать нерезолвенный id.
 */
function names(reg: ParseRegistry, form: QueryPrintForm): Names {
  const pick = <T extends { key: string; label: Record<string, string> }>(
    def: T | undefined,
    id: string,
  ): string => {
    // Имя в label-форме ВСЕГДА в кавычках (§А5-3б) — в том числе нерезолвенный id.
    // Экранирование ОБЯЗАТЕЛЬНО и здесь: подпись — свободный текст владельца (§А2-3), и
    // свойство с label `Он "сказал"` без экранирования печаталось бы `"Он "сказал""=v`,
    // то есть текстом, который парсер не соберёт обратно.
    if (!def) return form === 'label' ? quoteAlways(id) : id;
    return form === 'key' ? def.key : quoteAlways(effectiveLabel(def.label, reg.locale));
  };
  return {
    prop: (id) => pick(reg.properties.get(id), id),
    aspect: (id) => pick(reg.aspects.get(id), id),
    role: (id) => pick(reg.roles.get(id), id),
    // Реестр нужен и здесь: сахар — это КОНКРЕТНЫЕ id роли и свойства, а в дереве лежат id,
    // не ключи. Через `Names` (а не пятым параметром `printNode`), потому что это ровно тот
    // же класс знания — «как назвать/опознать запись реестра».
    isBlockedSugar: (pred) => isExcludeBlockedSugar(pred, reg),
  };
}

function printScalar(value: QueryScalar): string {
  if (typeof value === 'string') return quoteQueryValue(value);
  return String(value);
}

function printBound(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'token' in value) {
    return String((value as { token: string }).token);
  }
  return printScalar(value as QueryScalar);
}

/** Предикат свойства-«равенства», из которых складываются |- и &-списки. */
interface EqLeaf {
  prop: string;
  op: 'eq' | 'contains';
  value: QueryPropValue;
}

function asEqLeaf(node: QueryFilterNode): EqLeaf | null {
  if (!('prop' in node)) return null;
  if (node.op !== 'eq' && node.op !== 'contains') return null;
  return { prop: node.prop, op: node.op, value: node.value };
}

/** `|`-список по ОДНОМУ свойству — форма OR, выразимая плоской грамматикой. */
function asSamePropList(nodes: readonly QueryFilterNode[]): EqLeaf[] | null {
  const leaves: EqLeaf[] = [];
  for (const node of nodes) {
    const leaf = asEqLeaf(node);
    if (!leaf) return null;
    if (leaves.length > 0 && (leaves[0] as EqLeaf).prop !== leaf.prop) return null;
    leaves.push(leaf);
  }
  return leaves.length > 0 ? leaves : null;
}

/**
 * ВТОРАЯ форма OR, выразимая плоским текстом: однородный список тегов — `tags=a|b`.
 *
 * Её отсутствие было настоящей дырой обратимости, а не пробелом в покрытии: дерево
 * `{or:[{tag:'дом'},{tag:'дача'}]}` парсер САМ делает из боевого `tags=дом|дача`, а печать
 * возвращала `(tags=дом | tags=дача)` — текст, который парсер v1 отвергает. Обещание
 * обратимости key-формы (см. шапку файла) держалось на выборке фикстур, не покрывавшей то,
 * что парсер производит из живого текста.
 *
 * Остальные не-prop листья в `|`-список НЕ сводятся, и это проверено разбором, а не
 * догадкой: `aspect=a|b` парсер читает как ОДНО имя аспекта `a|b` (`UNKNOWN_ASPECT`),
 * `has=a|b` — как одно имя свойства, а `search=a|b` собрал бы строку поиска `a|b`, то есть
 * ДРУГОЕ дерево. Для них скобочная форма честнее: она отказывается разбираться вслух.
 */
function asTagList(nodes: readonly QueryFilterNode[]): string[] | null {
  const tags: string[] = [];
  for (const node of nodes) {
    if (!('tag' in node)) return null;
    tags.push(node.tag);
  }
  return tags.length > 0 ? tags : null;
}

function printTagList(tags: readonly string[]): string {
  return `tags=${tags.map(quoteQueryValue).join('|')}`;
}

function printNode(node: QueryFilterNode, n: Names): string {
  if ('and' in node) return `(${node.and.map((c) => printNode(c, n)).join(' & ')})`;
  if ('or' in node) {
    const list = asSamePropList(node.or);
    if (list) {
      return `${n.prop((list[0] as EqLeaf).prop)}=${list.map((l) => printBound(l.value)).join('|')}`;
    }
    const tags = asTagList(node.or);
    if (tags) return printTagList(tags);
    return `(${node.or.map((c) => printNode(c, n)).join(' | ')})`;
  }
  if ('not' in node) {
    const inner = node.not;
    // Сахар `excludeBlocked=true` — ЕДИНСТВЕННАЯ текстовая форма отрицания ребра с условием
    // на дальний конец, и печать обязана её вернуть: иначе `parse(print(a)) ≡ a` неверно для
    // каждого смарт-листа с этой конструкцией. Сверяется СОДЕРЖИМОЕ узла, а не наличие поля,
    // и сверяется чужой функцией (`isExcludeBlockedSugar`, `parse-ast.ts`) — тем же местом,
    // из которого сахар собран: свои литералы здесь были бы второй правдой о «закрытой
    // работе». Узел с другими `via`/`prop`/`values` этого текста не получает — он уходит в
    // скобочную форму ниже, потому что иначе два РАЗНЫХ дерева печатались бы одним текстом.
    if ('rel' in inner && n.isBlockedSugar(inner.rel)) return 'excludeBlocked=true';
    if ('or' in inner) {
      const list = asSamePropList(inner.or);
      if (list) {
        return `${n.prop((list[0] as EqLeaf).prop)}=${list.map((l) => `!${printBound(l.value)}`).join('&')}`;
      }
    }
    const leaf = asEqLeaf(inner);
    if (leaf) return `${n.prop(leaf.prop)}=!${printBound(leaf.value)}`;
    // `excludeTags=a|b` парсер даёт как `not(or(tag…))`, и своей ветки этому случаю НЕ
    // нужно: общий хвост ниже печатает `!` + свод из ветки `or`, то есть ровно `!tags=a|b`.
    // Отдельная ветка здесь была — и оказалась мёртвой: мутация «снять её» не меняла ни
    // одного вывода (найдено собственной мутацией М37 фикс-раунда 6).
    // Двойное отрицание плоским текстом невыразимо: `!!X` парсер прочитал бы как имя
    // конструкции `!X`, и отказ был бы не про то. Скобки дают ЧЕСТНОЕ сообщение —
    // «скобок в грамматике v1 нет» (§А5-3д), то же, что у любого невыразимого дерева.
    if ('not' in inner) return `!(${printNode(inner, n)})`;
    return `!${printNode(inner, n)}`;
  }
  if ('prop' in node) {
    const name = n.prop(node.prop);
    switch (node.op) {
      case 'eq':
      case 'contains':
        return `${name}=${printBound(node.value)}`;
      case 'ne':
        return `${name}!=${printBound(node.value)}`;
      case 'gt':
        return `${name}>${printBound(node.value)}`;
      case 'lt':
        return `${name}<${printBound(node.value)}`;
      case 'in':
        // `in` и OR по одному свойству делят одну текстовую форму: обратный разбор даёт OR
        // (§А5-3д). Вход для `in` — AST тула (§А5-4), не текст.
        return `${name}=${(node.value as QueryScalar[]).map(printScalar).join('|')}`;
      default: {
        const range = node.value as { from?: unknown; to?: unknown };
        if (range.from !== undefined && range.to !== undefined) {
          return `${name}=${printBound(range.from)}..${printBound(range.to)}`;
        }
        // Односторонняя ВКЛЮЧАЮЩАЯ граница — тот самый `<=`/`>=` (§А5-7, находка 8).
        if (range.to !== undefined) return `${name}<=${printBound(range.to)}`;
        return `${name}>=${printBound(range.from)}`;
      }
    }
  }
  if ('has' in node) return `has=${n.prop(node.has)}`;
  if ('aspect' in node) return `aspect=${n.aspect(node.aspect)}`;
  if ('tag' in node) return `tags=${quoteQueryValue(node.tag)}`;
  if ('search' in node) return `search=${quoteQueryValue(node.search)}`;
  if ('archived' in node) return `archived=${node.archived}`;
  if ('class' in node) return `class=${node.class.contract}:${node.class.set}`;
  const rel = node.rel;
  const target = rel.of === undefined ? '' : `=${quoteQueryValue(rel.of)}`;
  const via = rel.via === undefined ? '' : ` via=${n.role(rel.via)}`;
  // Ребро с условием на дальний конец плоским текстом НЕ выражается — ни в положительной
  // форме («покажи заблокированные живой работой» грамматика v1 сказать не умеет), ни в
  // отрицательной с НЕканоническим условием (сахар — ровно одна тройка `via`/`prop`/`values`,
  // см. ветку `not` выше). Печатаем скобками, как любое невыразимое дерево (§А5-3д): разбор
  // честно откажет про скобки, и это лучше текста, который вернулся бы ДРУГИМ деревом.
  //
  // СОДЕРЖИМОЕ условия печатается ЦЕЛИКОМ, а не сворачивается в `(has_relation via=…)`.
  // Иначе два узла, различающиеся только `prop` или набором значений, снова дали бы один
  // текст — тот же дефект, только переехавший из сахара в скобочную форму, а дифф Ш1 меряет
  // правки именно печатью (§А5-2). Скобки делают текст неразбираемым, но РАЗЛИЧИМЫМ.
  if (rel.kind === 'has_relation' && rel.sourceNotIn) {
    const { prop, values } = rel.sourceNotIn;
    return `(${rel.kind}${via} sourceNotIn=${n.prop(prop)}:${values.map(printScalar).join('|')})`;
  }
  return `${rel.kind}${target}${via}`;
}

/** Печатает Q-AST в текст грамматики §А5-3: `key` — канон, `label` — для человека. */
export function printQueryAst(ast: QueryAst, reg: ParseRegistry, form: QueryPrintForm): string {
  const n = names(reg, form);
  const parts: string[] = [];
  if (ast.filter !== null) {
    // Верхний `and` — и есть плоский список конструкций через запятую; всё остальное
    // печатается одним выражением.
    if ('and' in ast.filter) for (const child of ast.filter.and) parts.push(printNode(child, n));
    else parts.push(printNode(ast.filter, n));
  }
  if (ast.sortBy) {
    parts.push(`sortBy=${ast.sortBy.map((s) => `${n.prop(s.field)}:${s.dir}`).join('|')}`);
  }
  if (ast.limit !== undefined) parts.push(`limit=${ast.limit}`);
  if (ast.display !== undefined) parts.push(`display=${ast.display}`);
  if (ast.title !== undefined) parts.push(`title=${quoteQueryValue(ast.title)}`);
  return parts.join(', ');
}
