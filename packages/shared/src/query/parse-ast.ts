/**
 * Текст грамматики §А5-3 → канонический Q-AST (§А5-7), с резолвом имён ПО РЕЕСТРУ.
 *
 * Чем этот парсер принципиально отличается от `parse.ts` (§А5-3ж): неизвестное имя поля,
 * аспекта или роли — ОТКАЗ С КОДОМ, а не молчаливый ноль результатов. Сегодня `aspect=`
 * не проверялось ни парсером (`parse.ts:469-478`), ни старым компилятором
 * (`compile.ts:233-235`),
 * и опечатка `aspect=orbis/tsk` даёт пустой список, неотличимый от честной пустоты.
 *
 * Адресация имён (§А5-3а/б): машинная ручка — namespaced key (`orbis/limit>1000`), слэш и
 * есть встроенная пометка «это свойство», поэтому коллизия с голыми reserved-словами
 * невозможна по построению; человеческая — закавыченный label (`"срок"<=today`), резолв по
 * локали, неоднозначность лечится `aspect=`.
 *
 * Разделители конструкций — запятая ИЛИ пробел вне кавычек. Запятая нужна дословно (тексты
 * Agenda и сидов §А5-5 написаны через неё), пробел — потому что `via=` пристёгивается к
 * предыдущему реляционному предикату отдельным словом (`!has_children via=subitem`).
 *
 * **Следствие, названное вслух: значение с пробелом обязано быть в кавычках, и это ломает
 * УЖЕ СОХРАНЁННЫЕ тексты.** Сегодняшний `serialize.ts:158` печатает `title=Мои задачи`,
 * `tags=дом дача` и `search=hello world` БЕЗ кавычек — новый разбор их отвергает. Полная
 * опись пострадавших текстов с адресами — `PRODUCTION_QUERY_TEXTS` в `ast-fixtures.ts`.
 * Интервал и владельцы перевода: Agenda и конструкторы web — Задача 10c, сидированные
 * тела смарт-листов и всё остальное — Задача 21. До перевода живут ОБА разбора (РП-11):
 * с Задачи 9b серверный разбор пробует СНАЧАЛА этот парсер и лишь при его отказе кодом
 * «текст старой формы» откатывается к `parse.ts` через мост (`legacy-bridge.ts`).
 *
 * Скобок в грамматике v1 НЕТ (§А5-3д): плоский текст — сахар, OR-дерево строит форма, AI
 * или AST-вход тула (§А5-4). Печать при этом тотальна и невыразимое дерево печатает
 * скобками (`print.ts`) — асимметрия намеренная и односторонняя.
 *
 * АДРЕСА ВИДА `compile.ts:NNN` НИЖЕ — В СНЯТОМ ФАЙЛЕ: старый серверный компилятор
 * `apps/server/src/query/compile.ts` удалён Задачей 9b вместе с последним потребителем, и
 * ссылки на него читаются по git-истории этого пути. Оставлены они потому, что называют
 * ПОВЕДЕНИЕ, которое реформа обязалась не менять, — без адреса проверить это негде.
 *
 * Токенайзер (маска кавычек, нарезка, снятие кавычек) был КОПИЕЙ токенайзера старого
 * парсера (`parse.ts:186-306`): выносить общий модуль было нельзя, пока обе грамматики жили
 * рядом. Старый парсер снят Задачей 21b целиком, и копия осталась единственной — выносить
 * теперь не из чего и не во что.
 */
import { ROLE_DEPENDENCY } from '../constants';
import { HHMM_RE, hasValidCalendar } from '../date';
import type {
  AspectDefinition,
  PropertyDefinition,
  RelationRoleDefinition,
} from '../registry/property-type';
import { effectiveLabel, OWNER_LOCALE, type PropertyType } from '../registry/types';
import type {
  QueryAst,
  QueryDateToken,
  QueryFilterNode,
  QueryRelKind,
  QueryRelPredicate,
  QueryScalar,
  QuerySortField,
} from './ast';
import { QUERY_DATE_TOKENS, QUERY_DISPLAY_MODES } from './ast';

// ─────────────────────────── Реестр разбора ───────────────────────────

/**
 * Срез реестров, которого хватает разбору: словари по id + локаль читателя. Больше
 * парсеру не нужно ничего — ни БД, ни сети, поэтому он одинаково работает в сиде, в
 * транзакции сервера и в браузере.
 */
export interface ParseRegistry {
  properties: ReadonlyMap<string, PropertyDefinition>;
  aspects: ReadonlyMap<string, AspectDefinition>;
  roles: ReadonlyMap<string, RelationRoleDefinition>;
  locale: string;
}

/**
 * ЕДИНСТВЕННЫЙ адаптер снимка реестра к форме разбора (находка 19 ревью плана): второе
 * преобразование той же пары словарей неизбежно разошлось бы с этим в правилах fallback
 * локали — а именно от них зависит, какое имя увидит человек в ошибке.
 */
export function toParseRegistry(
  snapshot: {
    properties: ReadonlyMap<string, PropertyDefinition>;
    aspects: ReadonlyMap<string, AspectDefinition>;
    roles: ReadonlyMap<string, RelationRoleDefinition>;
  },
  locale: string,
): ParseRegistry {
  return {
    properties: snapshot.properties,
    aspects: snapshot.aspects,
    roles: snapshot.roles,
    locale,
  };
}

/**
 * Правило чтения `LocalizedText` и локаль владельца — РЕЭКСПОРТ, а не определение.
 *
 * `effectiveLabel`: подпись записи реестра в локали читателя (локаль → en → любая, §А2-1).
 * Одно правило на печать и на разбор — иначе напечатанное имя не резолвилось бы обратно.
 * `OWNER_LOCALE`: та локаль, в которой резолвятся ЗАКАВЫЧЕННЫЕ подписи имён (§А5-3б) и
 * печатается label-форма (`print.ts`).
 *
 * Дом у обоих ОДИН и он при самом типе `LocalizedText` (`registry/types.ts`), и увёл их туда
 * один и тот же довод: то же правило и ту же локаль читают генератор схем `attach_*`
 * (`registry/tool-schema.ts`, Задача 12) и подписи полей и аспектов в web
 * (`lib/registry/labels.ts`, Задача 13a) — а `registry/*` лежит в эагерном барреле
 * `@orbis/shared`, тогда как этот файл выходит отдельным входом `@orbis/shared/query`, и
 * подписи в первом кадре тащили бы за одной строкой весь разбор запросов. Импорт обоих имён
 * из `@orbis/shared/query` при этом остался рабочим — потребители канона Q-AST его не меняли.
 *
 * Локаль наблюдаема в разборе в одном случае — когда в тексте стоит `"подпись"` вместо ключа;
 * ключевая форма (весь корпус боевых текстов) от локали не зависит вовсе.
 */
export { effectiveLabel, OWNER_LOCALE };

// ─────────────────────────── Коды отказов ───────────────────────────

export const QUERY_PARSE_CODES = [
  'UNKNOWN_FIELD',
  'UNKNOWN_ASPECT',
  'UNKNOWN_ROLE',
  'AMBIGUOUS_LABEL',
  'TYPE',
  'SYNTAX',
  'QUERY_MULTI_ROLE',
  'QUERY_JOIN',
  'RESERVED',
  'CLASS_NOT_AVAILABLE',
] as const;
export type QueryParseCode = (typeof QUERY_PARSE_CODES)[number];

export type ParseAstResult =
  | { ok: true; ast: QueryAst }
  | { ok: false; error: { code: QueryParseCode; message: string; position?: number } };

class QueryAstParseError extends Error {
  constructor(
    readonly code: QueryParseCode,
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'QueryAstParseError';
  }
}

function fail(code: QueryParseCode, message: string, position: number): never {
  throw new QueryAstParseError(code, message, position);
}

// ─────────────────────────── Токенайзер ───────────────────────────

interface Part {
  text: string;
  offset: number;
}

/** Маска «символ вне кавычек»; `unclosedAt` — позиция незакрытой кавычки, иначе -1. */
function quoteMask(text: string): { outside: boolean[]; unclosedAt: number } {
  const outside = new Array<boolean>(text.length).fill(false);
  let quoteOpen = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoteOpen !== -1) {
      if (ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) i++;
      else if (ch === '"') quoteOpen = -1;
    } else if (ch === '"') {
      quoteOpen = i;
    } else {
      outside[i] = true;
    }
  }
  return { outside, unclosedAt: quoteOpen };
}

/**
 * Текст запроса с СОДЕРЖИМЫМ КАВЫЧЕК, заменённым на `\u0001` той же длины.
 *
 * Зачем наружу. Блок, который разбор ОТВЕРГ, дерева не имеет, и всё, что о нём можно узнать,
 * читается из его текста регулярками — так работают признак бэкфилла D42 (`seed/onboarding.ts`)
 * и перенос имени свойства при слиянии (`registry/ops.ts`). Голая регулярка не отличает имя
 * поля от строки: `title="orbis/undecided"` — не адрес, а подпись, которую написал владелец,
 * и переписать её означало бы испортить чужой текст.
 *
 * ЭТО САМОЕ ТОНКОЕ РАЗЛИЧЕНИЕ, ДОСТУПНОЕ БЕЗ ПАРСЕРА, и предел назван вслух: значение,
 * которому кавычки не понадобились (`title=orbis/undecided`), от имени поля здесь
 * неотличимо. Для текста, который парсер принял, вопрос не стоит вовсе — там есть дерево.
 *
 * Длина сохраняется: позиции в исходной строке остаются валидными, поэтому по маске можно
 * искать, а править — оригинал по тем же индексам. Незакрытая кавычка не отказ: у
 * неразобранного текста она вероятна, и «всё после неё — значение» здесь безопаснее отказа.
 */
export function maskQuotedValues(text: string): string {
  const { outside } = quoteMask(text);
  let out = '';
  for (let i = 0; i < text.length; i++) out += outside[i] === true ? (text[i] as string) : '\u0001';
  return out;
}

const SEPARATOR_RE = /[\s,]/;

/** Режет запрос по запятым и пробелам вне кавычек. */
function splitTopLevel(input: string): Part[] {
  const { outside, unclosedAt } = quoteMask(input);
  if (unclosedAt !== -1) fail('SYNTAX', 'незакрытая кавычка', unclosedAt);
  const parts: Part[] = [];
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    if (outside[i] && SEPARATOR_RE.test(input[i] as string)) {
      parts.push({ text: input.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  parts.push({ text: input.slice(start), offset: start });
  return parts.filter((p) => p.text !== '');
}

/** Режет фрагмент по одиночному разделителю вне кавычек (`|`, `&`). */
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

function findOutsideQuotes(text: string, chars: string): number {
  const { outside } = quoteMask(text);
  for (let i = 0; i < text.length; i++) {
    if (outside[i] && chars.includes(text[i] as string)) return i;
  }
  return -1;
}

function findRangeDots(text: string): number {
  const { outside } = quoteMask(text);
  for (let i = 0; i + 1 < text.length; i++) {
    if (outside[i] && outside[i + 1] && text[i] === '.' && text[i + 1] === '.') return i;
  }
  return -1;
}

function trimPart(part: Part): Part {
  const leading = part.text.length - part.text.trimStart().length;
  return { text: part.text.trim(), offset: part.offset + leading };
}

/**
 * Снимает обрамляющие кавычки и разэкранирует `\"`, `\\` и `\}`.
 *
 * Третий экран — не грамматика, а РАЗМЕТКА ТЕЛА: печать разводит `}` бэкслешем, чтобы
 * значение с `}}` не закрыло обёртку `{{query:…}}` смарт-листа (см. `print.ts`), и без
 * симметричного снятия `parse(print(a)) ≡ a` перестало бы держаться на таком значении.
 */
function unquote(raw: string, offset: number): string {
  if (!raw.startsWith('"')) {
    const q = raw.indexOf('"');
    if (q !== -1) fail('SYNTAX', 'кавычки допустимы только вокруг всего значения', offset + q);
    return raw;
  }
  let out = '';
  let i = 1;
  for (; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && (raw[i + 1] === '"' || raw[i + 1] === '\\' || raw[i + 1] === '}')) {
      out += raw[i + 1];
      i++;
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  if (i >= raw.length) fail('SYNTAX', 'незакрытая кавычка', offset);
  if (i !== raw.length - 1) {
    fail('SYNTAX', 'лишние символы после закрывающей кавычки', offset + i + 1);
  }
  return out;
}

/** Операторы грамматики. Двухсимвольные ищутся первыми — иначе `<=` съелось бы как `<`. */
type Op = '=' | '!=' | '>' | '<' | '>=' | '<=';

interface Token {
  /** Имя конструкции или поля — как написано (возможно, в кавычках). */
  key: string;
  keyOffset: number;
  /** Ведущее `!`: отрицание всей конструкции (`!has_children`, `!tags=дом`). */
  negated: boolean;
  op: Op | null;
  opOffset: number;
  value: string;
  valueOffset: number;
}

function tokenize(part: Part): Token {
  let { text, offset } = part;
  let negated = false;
  if (text.startsWith('!') && text[1] !== '=') {
    negated = true;
    text = text.slice(1);
    offset += 1;
  }
  const idx = findOutsideQuotes(text, '=><!');
  if (idx === -1) {
    return {
      key: text,
      keyOffset: offset,
      negated,
      op: null,
      opOffset: offset,
      value: '',
      valueOffset: offset,
    };
  }
  const ch = text[idx] as string;
  const next = text[idx + 1];
  let op: Op;
  if (ch === '!') {
    if (next !== '=') fail('SYNTAX', `оператор '!' сам по себе не существует`, offset + idx);
    op = '!=';
  } else if ((ch === '<' || ch === '>') && next === '=') {
    op = ch === '<' ? '<=' : '>=';
  } else {
    op = ch as Op;
  }
  const rawKey = trimPart({ text: text.slice(0, idx), offset });
  if (rawKey.text === '') fail('SYNTAX', 'пустое имя поля перед оператором', offset + idx);
  const valueStart = idx + op.length;
  const rawValue = trimPart({ text: text.slice(valueStart), offset: offset + valueStart });
  if (rawValue.text === '') {
    fail('SYNTAX', `пустое значение после '${op}'`, offset + valueStart);
  }
  return {
    key: rawKey.text,
    keyOffset: rawKey.offset,
    negated,
    op,
    opOffset: offset + idx,
    value: rawValue.text,
    valueOffset: rawValue.offset,
  };
}

// ─────────────────────────── Резолв имён ───────────────────────────

/**
 * Слова грамматики. Они перехватывают только ГОЛОЕ имя: `orbis/limit` однозначен по
 * слэшу (§А5-3а/В11), поэтому свойство с ключом `limit` заводить не запрещено (§А2-4).
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'aspect',
  'tags',
  'excludeTags',
  'has',
  'has_relation',
  'has_children',
  'children_of',
  'parents_of',
  'descendants_of',
  'ancestors_of',
  'via',
  'excludeBlocked',
  'archived',
  'search',
  'sortBy',
  'limit',
  'display',
  'title',
  'class',
]);

interface Ctx {
  reg: ParseRegistry;
  byPropertyKey: Map<string, PropertyDefinition>;
  byPropertyLabel: Map<string, PropertyDefinition[]>;
  byAspectKey: Map<string, AspectDefinition>;
  byAspectLabel: Map<string, AspectDefinition[]>;
  byRoleKey: Map<string, RelationRoleDefinition>;
  byRoleLabel: Map<string, RelationRoleDefinition[]>;
  /** Аспекты, названные `aspect=` где угодно в запросе — разводка неоднозначных подписей. */
  aspectsInQuery: Set<string>;
  /** Свойства аспекта: propertyId → множество id аспектов-носителей. */
  carriers: Map<string, Set<string>>;
}

function labelKey(text: string): string {
  return text.trim().toLowerCase();
}

function pushLabel<T>(index: Map<string, T[]>, label: string, item: T): void {
  const key = labelKey(label);
  const list = index.get(key);
  if (list) list.push(item);
  else index.set(key, [item]);
}

function buildCtx(reg: ParseRegistry): Ctx {
  const ctx: Ctx = {
    reg,
    byPropertyKey: new Map(),
    byPropertyLabel: new Map(),
    byAspectKey: new Map(),
    byAspectLabel: new Map(),
    byRoleKey: new Map(),
    byRoleLabel: new Map(),
    aspectsInQuery: new Set(),
    carriers: new Map(),
  };
  for (const prop of reg.properties.values()) {
    ctx.byPropertyKey.set(prop.key, prop);
    pushLabel(ctx.byPropertyLabel, effectiveLabel(prop.label, reg.locale), prop);
  }
  for (const aspect of reg.aspects.values()) {
    ctx.byAspectKey.set(aspect.key, aspect);
    pushLabel(ctx.byAspectLabel, effectiveLabel(aspect.label, reg.locale), aspect);
    for (const ref of aspect.properties) {
      const set = ctx.carriers.get(ref.propertyId);
      if (set) set.add(aspect.id);
      else ctx.carriers.set(ref.propertyId, new Set([aspect.id]));
    }
  }
  for (const role of reg.roles.values()) {
    ctx.byRoleKey.set(role.key, role);
    pushLabel(ctx.byRoleLabel, effectiveLabel(role.label, reg.locale), role);
  }
  return ctx;
}

/** Имя записи реестра: `"подпись"` — всегда label, иначе key (§А5-3а/б). */
function isLabelForm(raw: string): boolean {
  return raw.startsWith('"');
}

function resolveProperty(raw: string, offset: number, ctx: Ctx): PropertyDefinition {
  if (isLabelForm(raw)) {
    const label = unquote(raw, offset);
    const found = ctx.byPropertyLabel.get(labelKey(label)) ?? [];
    if (found.length === 0) fail('UNKNOWN_FIELD', `нет свойства с подписью «${label}»`, offset);
    if (found.length === 1) return found[0] as PropertyDefinition;
    const narrowed = found.filter((p) =>
      [...(ctx.carriers.get(p.id) ?? [])].some((a) => ctx.aspectsInQuery.has(a)),
    );
    if (narrowed.length === 1) return narrowed[0] as PropertyDefinition;
    const where = found
      .map(
        (p) =>
          `${p.key} (${[...(ctx.carriers.get(p.id) ?? [])].sort().join(', ') || 'без аспекта'})`,
      )
      .join('; ');
    return fail(
      'AMBIGUOUS_LABEL',
      `подпись «${label}» носят несколько свойств: ${where} — уточните запрос через aspect= или назовите key`,
      offset,
    );
  }
  const byKey = ctx.byPropertyKey.get(raw);
  if (byKey) return byKey;
  if (RESERVED_WORDS.has(raw)) {
    return fail(
      'RESERVED',
      `'${raw}' — слово грамматики; свойство с таким ключом адресуется namespaced key (например 'orbis/${raw}')`,
      offset,
    );
  }
  return fail(
    'UNKNOWN_FIELD',
    `неизвестное свойство '${raw}': имена адресуются namespaced key ('orbis/…') или закавыченной подписью`,
    offset,
  );
}

function resolveAspect(raw: string, offset: number, ctx: Ctx): AspectDefinition {
  if (isLabelForm(raw)) {
    const label = unquote(raw, offset);
    const found = ctx.byAspectLabel.get(labelKey(label)) ?? [];
    if (found.length === 0) fail('UNKNOWN_ASPECT', `нет аспекта с подписью «${label}»`, offset);
    if (found.length > 1) {
      fail('AMBIGUOUS_LABEL', `подпись «${label}» носят несколько аспектов`, offset);
    }
    return found[0] as AspectDefinition;
  }
  const byKey = ctx.byAspectKey.get(raw);
  if (byKey) return byKey;
  return fail('UNKNOWN_ASPECT', `неизвестный аспект '${raw}'`, offset);
}

function resolveRole(raw: string, offset: number, ctx: Ctx): RelationRoleDefinition {
  if (isLabelForm(raw)) {
    const label = unquote(raw, offset);
    const found = ctx.byRoleLabel.get(labelKey(label)) ?? [];
    if (found.length === 0) fail('UNKNOWN_ROLE', `нет роли ребра с подписью «${label}»`, offset);
    if (found.length > 1) {
      fail('AMBIGUOUS_LABEL', `подпись «${label}» носят несколько ролей`, offset);
    }
    return found[0] as RelationRoleDefinition;
  }
  const byKey = ctx.byRoleKey.get(raw);
  if (byKey) return byKey;
  return fail('UNKNOWN_ROLE', `неизвестная роль ребра '${raw}'`, offset);
}

// ─────────────────────────── Значения по типу свойства ───────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_LITERAL_RE = /^-?\d+(\.\d+)?$/;
const DATE_LITERAL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_TOKENS: ReadonlySet<string> = new Set(QUERY_DATE_TOKENS);

/**
 * Значение свойства — список (§А2-2: `cardinality: many`, у `json` признак — `maxItems`).
 *
 * Экспортирован ради переходного моста (`legacy-bridge.ts`): выбор оператора равенства у
 * списочного свойства (`contains` вместо `eq`) — это решение ЯЗЫКА, а не парсера, и вторая
 * его копия в мосте разошлась бы с этой на первом же новом списочном свойстве.
 */
export function isListPropertyType(type: PropertyType): boolean {
  if (type.kind === 'json') return type.maxItems !== undefined;
  return 'cardinality' in type && type.cardinality === 'many';
}

/**
 * Есть ли у типа линейный порядок: только у него осмысленны `>`, `<` и диапазон.
 *
 * Экспортирована по той же причине, что `isListPropertyType`: это решение ЯЗЫКА, а не
 * парсера. Конструктор запросов в web предлагает операторы сравнения ровно тем свойствам,
 * которым их разрешает разбор, и своя копия списка типов разошлась бы с этой на первом же
 * новом типе — форма показала бы оператор, которым набранное перестало бы сохраняться.
 */
export function isOrderedPropertyKind(kind: PropertyType['kind']): boolean {
  return ['number', 'decimal', 'date', 'timestamp', 'time'].includes(kind);
}

/**
 * Принимает ли свойство относительное время (`today`, `overdue`, …) вместо литерала.
 * Экспортирована на том же основании: форма подставляет токены только туда, где их примет
 * разбор (§А5-7).
 */
export function acceptsDateTokenKind(kind: PropertyType['kind']): boolean {
  return kind === 'date' || kind === 'timestamp';
}

/**
 * Разбирает литерал по типу свойства из РЕЕСТРА (§А2-2) — без единой эвристики по тексту
 * регэкспа, которой держался старый каталог (`catalog.ts:174-179`).
 *
 * Проверяется ФОРМА значения и принадлежность варианту `select` (набор вариантов — часть
 * типа). Границы `min`/`max`/`maxLength` здесь не проверяются намеренно: это валидация
 * ЗАПИСИ (`registry/value-schema.ts`), а фильтр по значению вне границ — законный запрос,
 * который честно вернёт пусто.
 */
function parseScalar(prop: PropertyDefinition, el: Part): QueryScalar {
  const text = unquote(el.text, el.offset);
  const type = prop.type;
  const bad = (expected: string): never =>
    fail('TYPE', `свойство '${prop.key}' ожидает ${expected}, получено '${text}'`, el.offset);
  switch (type.kind) {
    case 'number': {
      if (!DECIMAL_LITERAL_RE.test(text)) return bad('число');
      const n = Number(text);
      if (type.integer === true && !Number.isInteger(n)) return bad('целое число');
      return n;
    }
    case 'decimal':
      // Decimal остаётся СТРОКОЙ: число IEEE-754 потеряло бы хвост копеек ровно там, где
      // его и сравнивают (§А7-3).
      return DECIMAL_LITERAL_RE.test(text) ? text : bad('decimal-строку');
    case 'boolean':
      if (text === 'true') return true;
      if (text === 'false') return false;
      return bad('true или false');
    case 'date':
      // Регексп — ФОРМА, `hasValidCalendar` — существование дня. Разделены потому, что у
      // календаря в монорепо один дом (`date.ts`), общий с записью и компилятором.
      return DATE_LITERAL_RE.test(text) && hasValidCalendar(text) ? text : bad('дату YYYY-MM-DD');
    case 'timestamp':
      return ISO_TIMESTAMP_RE.test(text) && hasValidCalendar(text) ? text : bad('момент ISO 8601');
    case 'time':
      return HHMM_RE.test(text) ? text : bad(`время 'ЧЧ:ММ'`);
    case 'select': {
      const keys = type.options.map((o) => o.key);
      return keys.includes(text) ? text : bad(`один из вариантов: ${keys.join(', ')}`);
    }
    case 'ref':
    case 'grant':
      return UUID_RE.test(text) ? text : bad('UUID');
    case 'json':
      return fail(
        'TYPE',
        `по свойству '${prop.key}' фильтровать нечем: значение — вложенный объект (kind json)`,
        el.offset,
      );
    default:
      // text и registry_ref — свободная строка.
      return text;
  }
}

type Bound = QueryScalar | { token: QueryDateToken };

/** Литерал ИЛИ относительное время; токен допустим только у date/timestamp (§А5-7). */
function parseBound(prop: PropertyDefinition, el: Part): Bound {
  if (el.text === '') fail('SYNTAX', 'пустой элемент значения', el.offset);
  const raw = el.text.startsWith('"') ? null : el.text;
  if (raw !== null && DATE_TOKENS.has(raw)) {
    if (!acceptsDateTokenKind(prop.type.kind)) {
      fail(
        'TYPE',
        `относительное время '${raw}' применимо только к свойствам типа date/timestamp; '${prop.key}' — ${prop.type.kind}`,
        el.offset,
      );
    }
    return { token: raw as QueryDateToken };
  }
  return parseScalar(prop, el);
}

// ─────────────────────────── Разбор конструкций ───────────────────────────

/**
 * ЧЕРНОВИК реляционного предиката. Готовый `QueryRelPredicate` связывает `kind` с
 * обязательностью `via`/`of` (см. его докблок), а разбор эту связь собрать сразу не может:
 * `via=` приезжает СЛЕДУЮЩИМ словом (`!has_children via=subitem`). Поэтому черновик
 * свободен по форме, а связь проверяет один пост-пасс `assertRelShape` — он же и есть
 * место, где черновик становится каноническим предикатом.
 */
interface RelDraft {
  kind: QueryRelKind;
  via?: string;
  of?: string;
  /** Состояние дальнего конца — заполняет только сахар `excludeBlocked` (см. ниже). */
  sourceNotIn?: { prop: string; values: string[] };
}

interface RelSlot {
  pred: RelDraft;
  offset: number;
}

interface Acc {
  nodes: QueryFilterNode[];
  ast: QueryAst;
  /** Предикат, к которому пристёгивается следующий `via=`. */
  lastRel: RelSlot | null;
  /** Все реляционные предикаты запроса — форма проверяется после разбора. */
  rels: RelSlot[];
}

/** Роли обязательны/запрещены по `kind` — норматив §А5-1, одно место на весь разбор. */
function assertRelShape(slot: RelSlot): void {
  const { kind, via, of } = slot.pred;
  const needsVia = kind === 'descendants_of' || kind === 'ancestors_of' || kind === 'has_relation';
  const needsOf =
    kind === 'children_of' ||
    kind === 'parents_of' ||
    kind === 'descendants_of' ||
    kind === 'ancestors_of';
  if (needsVia && via === undefined) {
    fail(
      'QUERY_MULTI_ROLE',
      `'${kind}' требует via=<роль>: без названной роли предикат шёл бы сразу по нескольким, а это за границей языка запросов (§А5-1)`,
      slot.offset,
    );
  }
  if (needsOf && of === undefined) {
    fail('SYNTAX', `'${kind}' требует значение: UUID сущности или this`, slot.offset);
  }
  if (!needsOf && of !== undefined) {
    fail('SYNTAX', `'${kind}' не принимает вторую сущность`, slot.offset);
  }
}

function negate(node: QueryFilterNode, negated: boolean): QueryFilterNode {
  return negated ? { not: node } : node;
}

/** Значение реляционного предиката: `this` либо UUID; предикат вместо них — `QUERY_JOIN`. */
function parseEntityRef(t: Token): string {
  if (t.op === null) fail('SYNTAX', `конструкция '${t.key}' требует значение`, t.keyOffset);
  if (t.op !== '=') {
    fail('RESERVED', `оператор '${t.op}' неприменим к слову грамматики '${t.key}'`, t.opOffset);
  }
  const value = unquote(t.value, t.valueOffset);
  if (value === 'this' || UUID_RE.test(value)) return value;
  if (findOutsideQuotes(t.value, '=><') !== -1) {
    fail(
      'QUERY_JOIN',
      `'${t.key}' принимает UUID или this: соединение двух свободных сущностей за границей языка запросов (§А5-1)`,
      t.valueOffset,
    );
  }
  return fail('SYNTAX', `'${t.key}': ожидается UUID или this, получено '${value}'`, t.valueOffset);
}

/**
 * Значение узлов `{tag}`, `{search}` и параметра `title` канон объявляет непустым
 * (`min(1)` в `queryAstSchema`). Разбор обязан отказывать здесь, а не рождать дерево,
 * которое собственная схема канона потом отвергнет: такой AST сохранился бы в query-блок
 * и перестал читаться на первой же перевалидации (вход тула, `scope`, `ref.target`) —
 * «сохранилось, но не читается» хуже честного отказа при вводе. Выбор именно такой, а не
 * снятие `min(1)`: пустой тег и пустой поиск не отбирают ничего и означать ничего не могут,
 * а `title=""` рисует над списком пустой заголовок.
 */
function nonEmpty(value: string, what: string, offset: number): string {
  if (value === '') fail('SYNTAX', `пустое значение ${what} не имеет смысла`, offset);
  return value;
}

function requireOp(t: Token, op: Op): string {
  if (t.op === null) fail('SYNTAX', `конструкция '${t.key}' требует значение`, t.keyOffset);
  if (t.op !== op) {
    fail('RESERVED', `оператор '${t.op}' неприменим к слову грамматики '${t.key}'`, t.opOffset);
  }
  return t.value;
}

function assignOnce<K extends 'sortBy' | 'limit' | 'display' | 'title'>(
  acc: Acc,
  key: K,
  t: Token,
  value: NonNullable<QueryAst[K]>,
): void {
  if (acc.ast[key] !== undefined) {
    fail('SYNTAX', `повторный параметр '${key}'`, t.keyOffset);
  }
  acc.ast[key] = value;
}

function parseSortBy(t: Token, ctx: Ctx): QuerySortField[] {
  requireOp(t, '=');
  return splitPartBy({ text: t.value, offset: t.valueOffset }, '|').map((raw) => {
    const el = trimPart(raw);
    if (el.text === '') fail('SYNTAX', 'пустой элемент sortBy', el.offset);
    const colon = el.text.lastIndexOf(':');
    if (colon === -1)
      fail('SYNTAX', `sortBy: ожидается 'свойство:asc' или 'свойство:desc'`, el.offset);
    const name = trimPart({ text: el.text.slice(0, colon), offset: el.offset });
    const dir = el.text.slice(colon + 1).trim();
    if (dir !== 'asc' && dir !== 'desc') {
      fail('SYNTAX', `sortBy: направление asc или desc, получено '${dir}'`, el.offset + colon + 1);
    }
    const prop = resolveProperty(name.text, name.offset, ctx);
    if (isListPropertyType(prop.type) || prop.type.kind === 'json') {
      fail(
        'TYPE',
        `sortBy: по свойству '${prop.key}' сортировать нельзя — у значения нет линейного порядка`,
        name.offset,
      );
    }
    return { field: prop.id, dir };
  });
}

/** Список тегов через `|`: один тег — узел, несколько — OR (отрицание вешает вызывающий). */
function parseTags(t: Token): QueryFilterNode {
  requireOp(t, '=');
  const nodes = splitPartBy({ text: t.value, offset: t.valueOffset }, '|').map((raw) => {
    const el = trimPart(raw);
    if (el.text === '') fail('SYNTAX', 'пустой элемент списка тегов', el.offset);
    return { tag: nonEmpty(unquote(el.text, el.offset), 'тега', el.offset) } as QueryFilterNode;
  });
  return nodes.length === 1 ? (nodes[0] as QueryFilterNode) : { or: nodes };
}

/** Предикат свойства: оператор + значение (§А5-7). */
function parsePropNode(prop: PropertyDefinition, t: Token): QueryFilterNode {
  const value: Part = { text: t.value, offset: t.valueOffset };
  const listy = isListPropertyType(prop.type);
  const eqOp = listy ? ('contains' as const) : ('eq' as const);

  if (t.op === '>' || t.op === '<' || t.op === '>=' || t.op === '<=') {
    if (!isOrderedPropertyKind(prop.type.kind) || listy) {
      fail(
        'TYPE',
        `оператор '${t.op}' применим к свойствам с линейным порядком; '${prop.key}' — ${prop.type.kind}${listy ? ' (список)' : ''}`,
        t.opOffset,
      );
    }
    const bound = parseBound(prop, trimPart(value));
    // `<=`/`>=` — ВКЛЮЧАЮЩИЙ range: отдельных gte/lte в каноне нет (§А5-7, находка 8).
    if (t.op === '<=') return { prop: prop.id, op: 'range', value: { to: bound } };
    if (t.op === '>=') return { prop: prop.id, op: 'range', value: { from: bound } };
    return { prop: prop.id, op: t.op === '>' ? 'gt' : 'lt', value: bound };
  }

  if (t.op === '!=') {
    const bound = parseBound(prop, trimPart(value));
    // У списка «не равно» невыразимо одним оператором: отрицается вхождение элемента.
    return listy
      ? { not: { prop: prop.id, op: 'contains', value: bound } }
      : { prop: prop.id, op: 'ne', value: bound };
  }

  const dots = findRangeDots(t.value);
  if (dots !== -1) {
    if (!isOrderedPropertyKind(prop.type.kind) || listy) {
      fail(
        'TYPE',
        `диапазон применим к свойствам с линейным порядком; '${prop.key}' — ${prop.type.kind}`,
        t.valueOffset,
      );
    }
    const from = trimPart({ text: t.value.slice(0, dots), offset: t.valueOffset });
    const to = trimPart({ text: t.value.slice(dots + 2), offset: t.valueOffset + dots + 2 });
    if (from.text === '') fail('SYNTAX', 'диапазон: пустая левая граница', t.valueOffset);
    if (to.text === '') fail('SYNTAX', 'диапазон: пустая правая граница', to.offset);
    return {
      prop: prop.id,
      op: 'range',
      value: { from: parseBound(prop, from), to: parseBound(prop, to) },
    };
  }

  const pipe = findOutsideQuotes(t.value, '|');
  const amp = findOutsideQuotes(t.value, '&');
  if (pipe !== -1 && amp !== -1) {
    fail(
      'SYNTAX',
      'смешивание | и & в одном значении недопустимо',
      t.valueOffset + Math.max(pipe, amp),
    );
  }

  if (amp !== -1) {
    // `!a&!b` — «ни одно из»: дерево `not(or(...))`, а не отдельный узел noneOf (§А5-7).
    const nodes = splitPartBy(value, '&').map((raw) => {
      const el = trimPart(raw);
      if (!el.text.startsWith('!')) {
        fail('SYNTAX', `в &-форме каждый элемент начинается с '!'`, el.offset);
      }
      const inner = trimPart({ text: el.text.slice(1), offset: el.offset + 1 });
      return { prop: prop.id, op: eqOp, value: parseBound(prop, inner) } as QueryFilterNode;
    });
    return { not: nodes.length === 1 ? (nodes[0] as QueryFilterNode) : { or: nodes } };
  }

  const elements = splitPartBy(value, '|').map(trimPart);
  if (elements.length === 1) {
    const el = elements[0] as Part;
    if (el.text.startsWith('!')) {
      const inner = trimPart({ text: el.text.slice(1), offset: el.offset + 1 });
      return { not: { prop: prop.id, op: eqOp, value: parseBound(prop, inner) } };
    }
    return { prop: prop.id, op: eqOp, value: parseBound(prop, el) };
  }
  const nodes = elements.map((el) => {
    if (el.text.startsWith('!')) {
      fail(
        'SYNTAX',
        `отрицание '!' внутри |-списка не поддерживается — используйте &-форму`,
        el.offset,
      );
    }
    return { prop: prop.id, op: eqOp, value: parseBound(prop, el) } as QueryFilterNode;
  });
  // §А5-3: анкор «anyOf → or». Узел `in` каноничен, но текстом не порождается: у плоской
  // грамматики для `in` и `or` одна форма `p=a|b`, и печать обеих даёт её же.
  return { or: nodes };
}

/**
 * Роль, которой сегодня выражена блокировка, — та же `ROLE_DEPENDENCY`, по которой фильтрует
 * сервер (`query/compile-ast.ts`). Общая константа, а не свой литерал: два литерала на одну роль
 * стоят на РАЗНЫХ осях (здесь нужен key, серверу — id), и переименование роли валило бы
 * сборку только на одной из них, оставив вторую молча старой.
 *
 * Здесь она читается как KEY, и это законно: `excludeBlocked=true` — текстовый сахар,
 * тождественный `!has_relation via=dependency`, а `via=` принимает key (§А5-3). У встроенных
 * ролей key = id (`builtin-roles.ts` выводит его из id, равенство запиннено
 * `registry/builtin.test.ts`), поэтому одна константа служит обеим осям. Своя строка
 * владельца с другим key даст `UNKNOWN_ROLE` — ту же ошибку, что и явная запись, вместо
 * дерева, ссылающегося на несуществующую роль.
 */
const EXCLUDE_BLOCKED_ROLE_KEY: string = ROLE_DEPENDENCY;

/**
 * Свойство и набор значений, которыми интервал А выражает «блокирующая работа ЗАКРЫТА».
 *
 * Спека даёт для этого `class(completable) ∉ closed` (§таблица), но контрактов в срезе А
 * нет, а выбросить условие нельзя: его проверял старый компилятор (`compile.ts:272`,
 * `COALESCE(...,'') NOT IN ('done','cancelled')`), и без него «отпущенный» блокер начал бы
 * прятать работу. Поэтому набор назван здесь ДОСЛОВНО тем же, что стоит в сегодняшнем SQL,
 * и заменяется на `class` вместе с контрактами — целиком, а не дополняется.
 *
 * Ключ свойства резолвится РЕЕСТРОМ (как и роль рядом): реестр без `orbis/task_status`
 * обязан дать `UNKNOWN_FIELD`, а не дерево, ссылающееся на несуществующее свойство.
 */
const EXCLUDE_BLOCKED_STATUS_KEY = 'orbis/task_status';
const EXCLUDE_BLOCKED_CLOSED: readonly string[] = ['done', 'cancelled'];

/**
 * Совпадает ли предикат С САХАРОМ `excludeBlocked=true` — ровно, а не «похоже».
 *
 * Живёт здесь, рядом с константами сахара, потому что печать (`print.ts`) обязана спрашивать
 * ТУ ЖЕ правду, из которой сахар собран. Сверять содержимое там своими литералами значило бы
 * завести вторую правду о том, что такое «закрытая работа», и разъехаться с разбором молча.
 *
 * Почему сравнивается СОДЕРЖИМОЕ, а не наличие поля: `sourceNotIn` уехал в JSON Schema
 * провайдеру, то есть вход `ast:` тула (§А5-4) вернёт узлы с ЛЮБЫМИ `via`/`prop`/`values`.
 * Печать «по наличию» отдала бы им всем текст `excludeBlocked=true`, и обратный разбор вернул
 * бы другое дерево — то есть `parse(print(a)) ≠ a`, а правка внутри такого узла стала бы в
 * key-печати невидимой. Это дословно тот дефект, из-за которого `eq` на списочном свойстве
 * отвергнут компилятором (долг 1 гейта Задачи 8), и второй раз впускать его нельзя.
 */
export function isExcludeBlockedSugar(pred: QueryRelPredicate, reg: ParseRegistry): boolean {
  if (pred.kind !== 'has_relation' || pred.sourceNotIn === undefined) return false;
  const role = [...reg.roles.values()].find((r) => r.key === EXCLUDE_BLOCKED_ROLE_KEY);
  const prop = [...reg.properties.values()].find((p) => p.key === EXCLUDE_BLOCKED_STATUS_KEY);
  if (!role || !prop) return false;
  const { prop: propId, values } = pred.sourceNotIn;
  return (
    pred.via === role.id &&
    propId === prop.id &&
    values.length === EXCLUDE_BLOCKED_CLOSED.length &&
    values.every((v, i) => v === EXCLUDE_BLOCKED_CLOSED[i])
  );
}

const REL_WITH_TARGET: ReadonlySet<string> = new Set([
  'children_of',
  'parents_of',
  'descendants_of',
  'ancestors_of',
]);

/** Конструкции, у которых ведущее `!` бессмысленно: проекция, уточнение и уже-отрицания. */
const NOT_NEGATABLE: ReadonlySet<string> = new Set([
  'via',
  'sortBy',
  'limit',
  'display',
  'title',
  'excludeTags',
  'excludeBlocked',
]);

function dispatch(t: Token, ctx: Ctx, acc: Acc): void {
  if (t.negated && NOT_NEGATABLE.has(t.key)) {
    fail('SYNTAX', `конструкция '${t.key}' не отрицается`, t.keyOffset);
  }
  const push = (node: QueryFilterNode): void => {
    acc.nodes.push(negate(node, t.negated));
  };

  // `via=` пристёгивается к предыдущему реляционному предикату — отдельным словом, потому
  // что роль уточняет уже названный обход, а не заводит новую конструкцию.
  if (t.key === 'via') {
    if (t.negated) fail('SYNTAX', `'via' не отрицается: отрицается сам предикат`, t.keyOffset);
    const target = acc.lastRel;
    if (!target) {
      fail('SYNTAX', `'via=' уточняет предыдущий реляционный предикат, а его нет`, t.keyOffset);
    }
    if (target.pred.via !== undefined) fail('SYNTAX', `повторный 'via'`, t.keyOffset);
    target.pred.via = resolveRole(requireOp(t, '='), t.valueOffset, ctx).id;
    return;
  }

  if (REL_WITH_TARGET.has(t.key)) {
    const slot: RelSlot = {
      pred: { kind: t.key as QueryRelKind, of: parseEntityRef(t) },
      offset: t.keyOffset,
    };
    acc.lastRel = slot;
    acc.rels.push(slot);
    // Каст законен ровно потому, что `assertRelShape` пройдёт по acc.rels до возврата AST.
    push({ rel: slot.pred as QueryRelPredicate });
    return;
  }

  switch (t.key) {
    case 'aspect': {
      // Сырое значение, а не снятое с кавычек: кавычки и есть признак label-формы (§А5-3б).
      const aspect = resolveAspect(requireOp(t, '='), t.valueOffset, ctx);
      push({ aspect: aspect.id });
      return;
    }
    case 'tags':
      push(parseTags(t));
      return;
    case 'excludeTags':
      // Сахар сегодняшней грамматики: канон — отрицание над деревом (§А5-7).
      acc.nodes.push({ not: parseTags(t) });
      return;
    case 'has': {
      const prop = resolveProperty(requireOp(t, '='), t.valueOffset, ctx);
      push({ has: prop.id });
      return;
    }
    case 'has_relation':
    case 'has_children': {
      const slot: RelSlot = { pred: { kind: t.key }, offset: t.keyOffset };
      if (t.op !== null) {
        slot.pred.via = resolveRole(requireOp(t, '='), t.valueOffset, ctx).id;
      }
      acc.lastRel = slot;
      acc.rels.push(slot);
      push({ rel: slot.pred as QueryRelPredicate });
      return;
    }
    case 'excludeBlocked': {
      if (unquote(requireOp(t, '='), t.valueOffset) !== 'true') {
        fail('SYNTAX', `единственная форма — excludeBlocked=true`, t.valueOffset);
      }
      // Дословно как у старого компилятора (`compile.ts:272`): «на сущность есть ВХОДЯЩЕЕ
      // dependency ОТ НЕЗАКРЫТОЙ работы». Оба условия обязательны: без второго «отпущенный»
      // блокер (задача в done) начал бы прятать работу, и блок «Сегодня» показал бы владельцу
      // меньше, чем показывает сейчас, — то есть реформа поменяла бы наблюдаемое поведение.
      // Набор «closed» выражен статусом напрямую и заменяется на `class(completable)` вместе
      // с контрактами (Б-1). Направление — рулинг координатора, см. `QUERY_REL_ANCHOR`.
      //
      // Именно поэтому сахар и явная запись `!has_relation via=dependency` дают РАЗНЫЕ
      // деревья: у них разные намерения, и различить их можно только в самом дереве.
      //
      // Роль РЕЗОЛВИТСЯ реестром, а не подставляется литералом: это шестнадцатая точка
      // записи id в дерево, и на литерале она была единственной, где инвариант §А5-2 «в
      // дереве лежат id» держался на совпадении `key === id` у встроенных ролей
      // (`builtin-roles.ts:174`). У пользовательской роли (v1.5, Ч7) совпадения не будет.
      const slot: RelSlot = {
        pred: {
          kind: 'has_relation',
          via: resolveRole(EXCLUDE_BLOCKED_ROLE_KEY, t.keyOffset, ctx).id,
          sourceNotIn: {
            prop: resolveProperty(EXCLUDE_BLOCKED_STATUS_KEY, t.keyOffset, ctx).id,
            values: [...EXCLUDE_BLOCKED_CLOSED],
          },
        },
        offset: t.keyOffset,
      };
      acc.rels.push(slot);
      acc.nodes.push({ not: { rel: slot.pred as QueryRelPredicate } });
      return;
    }
    case 'archived': {
      const v = unquote(requireOp(t, '='), t.valueOffset);
      if (v !== 'true' && v !== 'any') {
        fail('SYNTAX', `archived: ожидается true или any, получено '${v}'`, t.valueOffset);
      }
      push({ archived: v });
      return;
    }
    case 'search':
      push({
        search: nonEmpty(unquote(requireOp(t, '='), t.valueOffset), 'поиска', t.valueOffset),
      });
      return;
    case 'class':
      // Часть Б: контрактов ещё нет, а молчаливое игнорирование дало бы запрос, который
      // «работает» и отбирает не то.
      fail(
        'CLASS_NOT_AVAILABLE',
        `предикат class появится с контрактами (часть Б реформы)`,
        t.keyOffset,
      );
      return;
    case 'sortBy':
      assignOnce(acc, 'sortBy', t, parseSortBy(t, ctx));
      return;
    case 'limit': {
      const v = unquote(requireOp(t, '='), t.valueOffset);
      if (!/^\d+$/.test(v) || Number.parseInt(v, 10) <= 0) {
        fail('SYNTAX', `limit: целое больше 0, получено '${v}'`, t.valueOffset);
      }
      assignOnce(acc, 'limit', t, Number.parseInt(v, 10));
      return;
    }
    case 'display': {
      const v = unquote(requireOp(t, '='), t.valueOffset);
      if (!(QUERY_DISPLAY_MODES as readonly string[]).includes(v)) {
        fail(
          'SYNTAX',
          `display: ${QUERY_DISPLAY_MODES.join(', ')}; получено '${v}'`,
          t.valueOffset,
        );
      }
      assignOnce(acc, 'display', t, v as NonNullable<QueryAst['display']>);
      return;
    }
    case 'title':
      assignOnce(
        acc,
        'title',
        t,
        nonEmpty(unquote(requireOp(t, '='), t.valueOffset), 'заголовка', t.valueOffset),
      );
      return;
    default: {
      if (t.op === null) {
        // Самый частый способ сюда попасть — НЕ опечатка, а значение с пробелом:
        // `title=Мои задачи` рвётся на `title=Мои` и `задачи`, и второе слово приезжает
        // конструкцией без оператора. Сообщение обязано называть настоящую причину, иначе
        // человек ищет несуществующее поле «задачи» (§6.4: отказ объясняет, а не пугает).
        fail(
          'SYNTAX',
          `ожидается конструкция вида имя=значение, получено '${t.key}'; если это часть значения с пробелом — возьмите значение в кавычки: title="Мои задачи"`,
          t.keyOffset,
        );
      }
      const prop = resolveProperty(t.key, t.keyOffset, ctx);
      push(parsePropNode(prop, t));
    }
  }
}

/** Разбирает текст §А5-3 в канонический Q-AST; отказы — структурные, с кодом и позицией. */
export function parseQueryAst(text: string, reg: ParseRegistry): ParseAstResult {
  try {
    return { ok: true, ast: parseOrThrow(text, reg) };
  } catch (e) {
    if (e instanceof QueryAstParseError) {
      return { ok: false, error: { code: e.code, message: e.message, position: e.position } };
    }
    throw e;
  }
}

function parseOrThrow(text: string, reg: ParseRegistry): QueryAst {
  // Переводы строк — те же разделители; замена 1:1 сохраняет длину, поэтому позиции
  // ошибок остаются честными индексами в исходной строке.
  const normalized = text.replace(/[\n\r]/g, ' ');
  const ctx = buildCtx(reg);
  const parts = splitTopLevel(normalized);
  for (const part of parts) {
    // Скобки — форма ПЕЧАТИ невыразимого дерева (`print.ts`), а не грамматики v1 (§А5-3д).
    // Внутри кавычек они обычный текст, поэтому ищутся только вне их.
    const paren = findOutsideQuotes(part.text, '()');
    if (paren !== -1) {
      fail(
        'SYNTAX',
        'скобок в грамматике v1 нет (§А5-3д): дерево строится формой или AST-входом тула',
        part.offset + paren,
      );
    }
  }
  const tokens = parts.map(tokenize);

  // Пре-пасс: `aspect=` разводит неоднозначные подписи независимо от порядка слов.
  // ОТРИЦАЕМЫЙ аспект (`!aspect=orbis/task`) сюда не идёт: запрос его ИСКЛЮЧАЕТ, и
  // резолвить по нему подпись значило бы выбрать свойство, носителя которого в выдаче
  // заведомо нет, — тот же молчаливый ноль, против которого §А5-3ж.
  for (const t of tokens) {
    if (t.key === 'aspect' && t.op === '=' && !t.negated) {
      ctx.aspectsInQuery.add(resolveAspect(t.value, t.valueOffset, ctx).id);
    }
  }

  const acc: Acc = { nodes: [], ast: { filter: null }, lastRel: null, rels: [] };
  for (const t of tokens) dispatch(t, ctx, acc);

  // Пост-пасс, а не проверка на месте: `via=` — отдельное слово и приезжает ПОСЛЕ предиката.
  for (const slot of acc.rels) assertRelShape(slot);

  acc.ast.filter =
    acc.nodes.length === 0
      ? null
      : acc.nodes.length === 1
        ? (acc.nodes[0] as QueryFilterNode)
        : { and: acc.nodes };
  return acc.ast;
}
