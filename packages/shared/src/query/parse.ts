/**
 * Парсер грамматики query-движка (PRD 01 §6.1) → AST `grammar.ts`.
 *
 * Запрос — строка из конструкций через запятую; все условия соединяются AND,
 * внутри значения `|` даёт OR (§6). Структура файла: токенайзер (нарезка по запятым
 * вне кавычек, поиск оператора, снятие кавычек) → резолвер имён (§6.1, правила резолва)
 * → диспетчер конструкций. Все ошибки — структурные `{ message, position }` (§6.4),
 * `position` — индекс символа в исходной строке.
 *
 * Обёртку `{{query: …}}` парсер НЕ снимает — на вход приходит уже содержимое
 * (снятие обёртки — забота рендерера body).
 */

import type { FieldCatalog, FieldType } from './catalog';
import { CORE_FIELDS } from './catalog';
import type {
  QueryAst,
  QueryComparableValue,
  QueryDateToken,
  QueryDisplayMode,
  QueryEntityRef,
  QueryFieldCondition,
  QueryFieldValue,
  QueryFilter,
  QuerySortField,
} from './grammar';

export type { FieldCatalog, FieldInfo, FieldType } from './catalog';
export { buildFieldCatalog, CORE_FIELDS } from './catalog';

export type ParseResult =
  | { ok: true; ast: QueryAst }
  | { ok: false; error: { message: string; position: number } };

/** Зарезервированные ключи грамматики — первый шаг резолва имени (§6.1). */
const RESERVED_KEYS = new Set([
  'tags',
  'excludeTags',
  'aspect',
  'children_of',
  'parents_of',
  'excludeBlocked',
  'archived',
  'sortBy',
  'search',
  'limit',
  'display',
  'title',
]);

const DATE_TOKENS = new Set<QueryDateToken>(['today', 'overdue', 'next_7d', 'after_7d']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Абсолютный ISO 8601 для сравнений core-timestamp (§6.1) — тот же паттерн, что в реестре (§3.1). */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** Числовой литерал сравнений/диапазонов: base-10 без экспоненты, знак допустим (§3.3, §6.1). */
const DECIMAL_LITERAL_RE = /^-?\d+(\.\d+)?$/;

/** Разбирает запрос §6.1; ошибки парсинга возвращает структурно, с позицией (§6.4). */
export function parseQuery(input: string, catalog: FieldCatalog): ParseResult {
  try {
    return { ok: true, ast: parseQueryOrThrow(input, catalog) };
  } catch (e) {
    if (e instanceof QueryParseError) {
      return { ok: false, error: { message: e.message, position: e.position } };
    }
    throw e;
  }
}

function parseQueryOrThrow(input: string, catalog: FieldCatalog): QueryAst {
  // Переводы строк эквивалентны пробелам (§6.1). Замена 1:1 сохраняет длину строки,
  // поэтому позиции ошибок остаются честными индексами в исходной строке.
  const normalized = input.replace(/[\n\r]/g, ' ');
  const parts = splitTopLevel(normalized)
    .filter((p) => p.text.trim() !== '') // висячая запятая и пустые конструкции — пропускаем
    .map(parsePart);

  // Пре-пасс: `aspect=X` участвует в резолве неоднозначных имён независимо от того,
  // стоит он до или после поля («запрос содержит aspect=», §6.1).
  const aspectsInQuery = new Set<string>();
  for (const p of parts) {
    if (p.op === '=' && p.key === 'aspect') aspectsInQuery.add(unquote(p.value, p.valueOffset));
  }

  const filters: QueryFilter[] = [];
  const ast: QueryAst = { filters };
  const ctx: Ctx = { catalog, aspectsInQuery, filters, ast };
  for (const p of parts) dispatchPart(p, ctx);
  return ast;
}

/** Контекст разбора: каталог, упомянутые аспекты, накапливаемый AST. */
interface Ctx {
  catalog: FieldCatalog;
  aspectsInQuery: Set<string>;
  filters: QueryFilter[];
  ast: QueryAst;
}

class QueryParseError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

function fail(message: string, position: number): never {
  throw new QueryParseError(message, position);
}

// ─────────────────────────── Токенайзер ───────────────────────────

/** Фрагмент строки с абсолютным смещением в исходном запросе. */
interface Part {
  text: string;
  offset: number;
}

/**
 * Маска «символ вне кавычек» для строки: внутри двойных кавычек `\"` — экранированная
 * кавычка (§6.1). `unclosedAt` — позиция незакрытой открывающей кавычки, иначе -1.
 */
function quoteMask(text: string): { outside: boolean[]; unclosedAt: number } {
  const outside = new Array<boolean>(text.length).fill(false);
  let quoteOpen = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoteOpen !== -1) {
      if (ch === '\\' && text[i + 1] === '"')
        i++; // экранированная кавычка
      else if (ch === '"') quoteOpen = -1;
    } else if (ch === '"') {
      quoteOpen = i;
    } else {
      outside[i] = true;
    }
  }
  return { outside, unclosedAt: quoteOpen };
}

/** Режет запрос по запятым вне кавычек; незакрытая кавычка — ошибка с позицией открытия. */
function splitTopLevel(input: string): Part[] {
  const { outside, unclosedAt } = quoteMask(input);
  if (unclosedAt !== -1) fail('незакрытая кавычка', unclosedAt);
  const parts: Part[] = [];
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    if (outside[i] && input[i] === ',') {
      parts.push({ text: input.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  parts.push({ text: input.slice(start), offset: start });
  return parts;
}

/** Режет фрагмент по одиночному разделителю вне кавычек (для `|`, `&`). */
function splitPartBy(part: Part, delim: string): Part[] {
  const { outside } = quoteMask(part.text);
  const parts: Part[] = [];
  let start = 0;
  for (let i = 0; i < part.text.length; i++) {
    if (outside[i] && part.text[i] === delim) {
      parts.push({ text: part.text.slice(start, i), offset: part.offset + start });
      start = i + 1;
    }
  }
  parts.push({ text: part.text.slice(start), offset: part.offset + start });
  return parts;
}

/** Индекс первого символа из `chars` вне кавычек; -1 если нет. */
function findOutsideQuotes(text: string, chars: string): number {
  const { outside } = quoteMask(text);
  for (let i = 0; i < text.length; i++) {
    if (outside[i] && chars.includes(text[i] as string)) return i;
  }
  return -1;
}

/** Индекс первого вхождения `..` вне кавычек; -1 если нет (детекция диапазона). */
function findRangeDots(text: string): number {
  const { outside } = quoteMask(text);
  for (let i = 0; i + 1 < text.length; i++) {
    if (outside[i] && outside[i + 1] && text[i] === '.' && text[i + 1] === '.') return i;
  }
  return -1;
}

/** Убирает пробелы по краям фрагмента, сдвигая offset на срезанное слева. */
function trimPart(part: Part): Part {
  const leading = part.text.length - part.text.trimStart().length;
  return { text: part.text.trim(), offset: part.offset + leading };
}

/**
 * Снимает обрамляющие кавычки и разэкранирует `\"` внутри (§6.1). `raw` уже обрезан
 * по краям. Кавычка в середине неквотированного значения и «хвост» после закрывающей
 * кавычки — ошибки: кавычки допустимы только вокруг всего значения.
 */
function unquote(raw: string, offset: number): string {
  if (!raw.startsWith('"')) {
    const q = raw.indexOf('"');
    if (q !== -1) fail('кавычки допустимы только вокруг всего значения', offset + q);
    return raw;
  }
  let out = '';
  let i = 1;
  for (; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && raw[i + 1] === '"') {
      out += '"';
      i++;
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  // Незакрытость поймана раньше (splitTopLevel), но страхуемся на прямые вызовы.
  if (i >= raw.length) fail('незакрытая кавычка', offset);
  if (i !== raw.length - 1) fail('лишние символы после закрывающей кавычки', offset + i + 1);
  return out;
}

/** Конструкция после нарезки: ключ, оператор (`=`, `>`, `<`) и сырое значение со смещениями. */
interface ParsedPart {
  key: string;
  keyOffset: number;
  op: '=' | '>' | '<';
  opOffset: number;
  value: string;
  valueOffset: number;
}

/** Находит оператор вне кавычек; ключ слева, значение справа (края обрезаются). */
function parsePart(part: Part): ParsedPart {
  const opIdx = findOutsideQuotes(part.text, '=><');
  if (opIdx === -1) {
    fail('ожидается конструкция вида ключ=значение', trimPart(part).offset);
  }
  const op = part.text[opIdx] as '=' | '>' | '<';
  const rawKey = trimPart({ text: part.text.slice(0, opIdx), offset: part.offset });
  if (rawKey.text === '') fail('пустое имя поля перед оператором', part.offset + opIdx);
  const rawValue = trimPart({
    text: part.text.slice(opIdx + 1),
    offset: part.offset + opIdx + 1,
  });
  if (rawValue.text === '') fail(`пустое значение после '${op}'`, part.offset + opIdx + 1);
  return {
    key: rawKey.text,
    keyOffset: rawKey.offset,
    op,
    opOffset: part.offset + opIdx,
    value: rawValue.text,
    valueOffset: rawValue.offset,
  };
}

// ─────────────────────────── Резолвер имён ───────────────────────────

/** Поле после резолва: каноническое имя, тип и признак core-поля (§4.1). */
interface ResolvedField {
  name: string;
  type: FieldType;
  core: boolean;
}

/**
 * Резолв имени поля (§6.1): core-поля → поля аспектов по каталогу; `due` — алиас
 * `orbis/task.due_date`. Зарезервированные ключи сюда не попадают (их снимает диспетчер).
 * Неизвестное имя и неоднозначное имя без уточняющего `aspect=` — ошибки (§6.4).
 * `allowTitle` — только для sortBy: core-`title` доступен в сортировке, но не в фильтре.
 */
function resolveField(key: string, keyOffset: number, ctx: Ctx, allowTitle = false): ResolvedField {
  if (key === 'created_at' || key === 'updated_at') {
    return { name: key, type: CORE_FIELDS[key], core: true };
  }
  if (allowTitle && key === 'title') return { name: 'title', type: 'string', core: true };

  const name = key === 'due' ? 'due_date' : key;
  let infos = ctx.catalog.fields[name] ?? [];
  // Алиас документирован именно для orbis/task.due_date (§6.1).
  if (key === 'due') infos = infos.filter((i) => i.aspect === 'orbis/task');
  if (infos.length === 0) fail(`неизвестное поле '${key}'`, keyOffset);
  if (infos.length > 1) {
    // Запрос содержит aspect=X и поле есть ровно в одном таком X — резолвим в X.
    const inQuery = infos.filter((i) => ctx.aspectsInQuery.has(i.aspect));
    if (inQuery.length === 1) infos = inQuery;
    else {
      fail(
        `неоднозначное поле '${name}': встречается в ${infos.map((i) => i.aspect).join(', ')} — уточните запрос через aspect=`,
        keyOffset,
      );
    }
  }
  const info = infos[0] as { type: FieldType };
  return { name, type: info.type, core: false };
}

// ─────────────────────────── Диспетчер конструкций ───────────────────────────

function dispatchPart(p: ParsedPart, ctx: Ctx): void {
  if (p.op !== '=') {
    dispatchComparison(p, ctx);
    return;
  }
  switch (p.key) {
    case 'tags':
      ctx.filters.push({ kind: 'tags', values: parseList(p) });
      return;
    case 'excludeTags':
      ctx.filters.push({ kind: 'excludeTags', values: parseList(p) });
      return;
    case 'aspect':
      // В aspectsInQuery уже добавлен пре-пассом.
      ctx.filters.push({ kind: 'aspect', aspect: unquote(p.value, p.valueOffset) });
      return;
    case 'children_of':
      ctx.filters.push({ kind: 'children_of', of: parseEntityRef(p) });
      return;
    case 'parents_of':
      ctx.filters.push({ kind: 'parents_of', of: parseEntityRef(p) });
      return;
    case 'excludeBlocked': {
      const v = unquote(p.value, p.valueOffset);
      if (v !== 'true') {
        fail(`excludeBlocked: единственная допустимая форма — excludeBlocked=true`, p.valueOffset);
      }
      ctx.filters.push({ kind: 'excludeBlocked' });
      return;
    }
    case 'archived': {
      const v = unquote(p.value, p.valueOffset);
      if (v !== 'true' && v !== 'any') {
        fail(`archived: ожидается true или any, получено '${v}'`, p.valueOffset);
      }
      ctx.filters.push({ kind: 'archived', value: v });
      return;
    }
    case 'sortBy':
      assignOnce(ctx, 'sortBy', p, parseSortBy(p, ctx));
      return;
    case 'search':
      assignOnce(ctx, 'search', p, unquote(p.value, p.valueOffset));
      return;
    case 'limit':
      assignOnce(ctx, 'limit', p, parseLimit(p));
      return;
    case 'display':
      assignOnce(ctx, 'display', p, parseDisplay(p));
      return;
    case 'title':
      // Ключ занят параметром заголовка: core-`title` в фильтре недоступен,
      // отбор по заголовку — через search= (§6.1).
      assignOnce(ctx, 'title', p, unquote(p.value, p.valueOffset));
      return;
    default: {
      const field = resolveField(p.key, p.keyOffset, ctx);
      const dots = findRangeDots(p.value);
      if (dots !== -1) {
        ctx.filters.push(parseRange(p, dots, field));
        return;
      }
      ctx.filters.push({
        kind: 'field',
        field: field.name,
        condition: parseFieldCondition(p, field),
      });
    }
  }
}

/** Параметры представления и лимиты задаются один раз — повтор перетирал бы значение молча. */
function assignOnce<K extends 'sortBy' | 'search' | 'limit' | 'display' | 'title'>(
  ctx: Ctx,
  key: K,
  p: ParsedPart,
  value: NonNullable<QueryAst[K]>,
): void {
  if (ctx.ast[key] !== undefined) fail(`повторный параметр '${key}'`, p.keyOffset);
  ctx.ast[key] = value;
}

/** Список значений через `|` (tags/excludeTags): элементы непусты, кавычки снимаются. */
function parseList(p: ParsedPart): string[] {
  return splitPartBy({ text: p.value, offset: p.valueOffset }, '|').map((el) => {
    const t = trimPart(el);
    if (t.text === '') fail('пустой элемент списка', t.offset);
    return unquote(t.text, t.offset);
  });
}

/** `children_of=`/`parents_of=`: явный UUID либо `this` (§6.1). */
function parseEntityRef(p: ParsedPart): QueryEntityRef {
  const v = unquote(p.value, p.valueOffset);
  if (v === 'this') return { kind: 'this' };
  if (UUID_RE.test(v)) return { kind: 'id', id: v };
  fail(`${p.key}: ожидается UUID или this, получено '${v}'`, p.valueOffset);
}

/** `limit=` — целое строго больше 0 (§6.1). */
function parseLimit(p: ParsedPart): number {
  const v = unquote(p.value, p.valueOffset);
  if (!/^\d+$/.test(v) || Number.parseInt(v, 10) <= 0) {
    fail(`limit должен быть целым числом больше 0, получено '${v}'`, p.valueOffset);
  }
  return Number.parseInt(v, 10);
}

/** `display=compact|list|table` — подсказка рендереру (§6.1). */
function parseDisplay(p: ParsedPart): QueryDisplayMode {
  const v = unquote(p.value, p.valueOffset);
  if (v !== 'compact' && v !== 'list' && v !== 'table') {
    fail(`display: ожидается compact, list или table, получено '${v}'`, p.valueOffset);
  }
  return v;
}

/** `sortBy=поле:asc|поле:desc` — упорядоченный список; имена резолвятся (core-`title` доступен). */
function parseSortBy(p: ParsedPart, ctx: Ctx): QuerySortField[] {
  return splitPartBy({ text: p.value, offset: p.valueOffset }, '|').map((el) => {
    const t = trimPart(el);
    if (t.text === '') fail('пустой элемент sortBy', t.offset);
    const colon = t.text.indexOf(':');
    if (colon === -1) fail(`sortBy: ожидается форма 'поле:asc' или 'поле:desc'`, t.offset);
    const rawField = trimPart({ text: t.text.slice(0, colon), offset: t.offset });
    const direction = t.text.slice(colon + 1).trim();
    if (direction !== 'asc' && direction !== 'desc') {
      fail(
        `sortBy: направление должно быть asc или desc, получено '${direction}'`,
        t.offset + colon + 1,
      );
    }
    if (rawField.text === '') fail('sortBy: пустое имя поля', t.offset);
    const field = resolveField(rawField.text, rawField.offset, ctx, true);
    return { field: field.name, direction };
  });
}

/**
 * Сравнение `>`/`<` (§6.1): числовые поля аспектов → decimal-литерал;
 * core-timestamp → абсолютный ISO 8601. Зарезервированные ключи операторов не имеют.
 */
function dispatchComparison(p: ParsedPart, ctx: Ctx): void {
  if (RESERVED_KEYS.has(p.key)) {
    fail(`оператор '${p.op}' неприменим к ключу '${p.key}'`, p.opOffset);
  }
  const field = resolveField(p.key, p.keyOffset, ctx);
  const value = parseComparable({ text: p.value, offset: p.valueOffset }, field);
  ctx.filters.push({ kind: 'comparison', field: field.name, op: p.op as '>' | '<', value });
}

/** Диапазон `min..max` (§6.1) — те же типы значений, что у сравнений, обе границы обязательны. */
function parseRange(p: ParsedPart, dots: number, field: ResolvedField): QueryFilter {
  const min = trimPart({ text: p.value.slice(0, dots), offset: p.valueOffset });
  const max = trimPart({ text: p.value.slice(dots + 2), offset: p.valueOffset + dots + 2 });
  if (min.text === '') fail('диапазон: пустая левая граница', p.valueOffset);
  if (max.text === '') fail('диапазон: пустая правая граница', max.offset);
  return {
    kind: 'range',
    field: field.name,
    min: parseComparable(min, field),
    max: parseComparable(max, field),
  };
}

/**
 * Значение сравнения/диапазона. Применимо к `number`/`integer`/`decimal` (kind `decimal`)
 * и к core-полям типа timestamp (kind `timestamp`, валидный ISO 8601) — §6.1: лексикографическое
 * сравнение строк запрещено, timestamp-поля аспектов операторами не сравниваются.
 */
function parseComparable(el: Part, field: ResolvedField): QueryComparableValue {
  const text = unquote(el.text, el.offset);
  if (field.core && field.type === 'timestamp') {
    if (!ISO_TIMESTAMP_RE.test(text)) {
      fail(`ожидается ISO 8601 timestamp для '${field.name}', получено '${text}'`, el.offset);
    }
    return { kind: 'timestamp', value: text };
  }
  if (field.type === 'number' || field.type === 'integer' || field.type === 'decimal') {
    if (!DECIMAL_LITERAL_RE.test(text)) {
      fail(`ожидается числовое значение для '${field.name}', получено '${text}'`, el.offset);
    }
    return { kind: 'decimal', value: text };
  }
  fail(
    `операторы >/< и диапазон .. применимы к числовым полям и core-timestamp; поле '${field.name}' имеет тип ${field.type}`,
    el.offset,
  );
}

/**
 * Условие фильтра поля: `v1|v2` → anyOf, `!v1&!v2` → noneOf (§6.1).
 * Смешивание `|` и `&` в одном значении — ошибка парсинга (§6.4), смесь непредставима в AST.
 */
function parseFieldCondition(p: ParsedPart, field: ResolvedField): QueryFieldCondition {
  const value: Part = { text: p.value, offset: p.valueOffset };
  const pipeIdx = findOutsideQuotes(p.value, '|');
  const ampIdx = findOutsideQuotes(p.value, '&');
  if (pipeIdx !== -1 && ampIdx !== -1) {
    fail(
      'смешивание | и & в одном значении недопустимо',
      p.valueOffset + Math.max(pipeIdx, ampIdx),
    );
  }
  if (ampIdx !== -1) {
    const values = splitPartBy(value, '&').map((el) => parseNegatedElement(trimPart(el), field));
    return { kind: 'noneOf', values };
  }
  const els = splitPartBy(value, '|').map(trimPart);
  // Одиночное `!v` — вырожденная &-форма: noneOf из одного значения.
  if (els.length === 1 && (els[0] as Part).text.startsWith('!')) {
    return { kind: 'noneOf', values: [parseNegatedElement(els[0] as Part, field)] };
  }
  const values = els.map((el) => {
    if (el.text.startsWith('!')) {
      // `!a|!b` — OR отрицаний: семантика §6.1 не определяет, отклоняем как ошибку.
      fail(`отрицание '!' внутри |-списка не поддерживается — используйте &-форму`, el.offset);
    }
    return parseValueElement(el, field);
  });
  return { kind: 'anyOf', values };
}

/** Элемент noneOf: обязан начинаться с `!`, дальше — обычное значение. */
function parseNegatedElement(el: Part, field: ResolvedField): QueryFieldValue {
  if (!el.text.startsWith('!')) {
    fail(`в &-форме каждый элемент должен начинаться с '!' (отрицание)`, el.offset);
  }
  return parseValueElement(trimPart({ text: el.text.slice(1), offset: el.offset + 1 }), field);
}

/**
 * Одиночный элемент значения: date-токен (`today|overdue|next_7d|after_7d`) —
 * только для полей типа date/timestamp (§6.1); иначе строковый литерал.
 */
function parseValueElement(el: Part, field: ResolvedField): QueryFieldValue {
  if (el.text === '') fail('пустой элемент значения', el.offset);
  const text = unquote(el.text, el.offset);
  if (DATE_TOKENS.has(text as QueryDateToken)) {
    if (field.type !== 'date' && field.type !== 'timestamp') {
      fail(
        `date-токен '${text}' применим только к полям типа date/timestamp; поле '${field.name}' имеет тип ${field.type}`,
        el.offset,
      );
    }
    return { kind: 'date_token', token: text as QueryDateToken };
  }
  return { kind: 'literal', value: text };
}
