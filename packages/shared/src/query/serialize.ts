/**
 * Печать AST грамматики query-движка обратно в строку запроса (PRD 01 §6.1) —
 * обратная операция к `parseQuery`. Нужна визуальному редактору query-блоков:
 * блок body разбирается парсером, правится формой и печатается обратно в текст.
 *
 * Обёртку `{{query: … }}` сериализатор НЕ ставит — симметрично парсеру, который её
 * не снимает (обёртка — забота рендерера body).
 *
 * Контракт — round-trip по AST, не по байтам исходной строки: парсер нормализует
 * переносы строк, отступы, незначащие нули в `limit` и снимает кавычки, и восстановить
 * исходное написание по AST невозможно. Инварианты закреплены `serialize.test.ts`:
 *   parseQuery(serializeQuery(ast)).ast   глубоко равен ast;
 *   serializeQuery(parseQuery(serializeQuery(ast)).ast) === serializeQuery(ast).
 *
 * ─── AST, который нельзя честно напечатать ───
 *
 * Вход — AST, произведённый `parseQuery`, либо структурно ему эквивалентный, собранный
 * формой редактора. Форму парсер породить не может ⇒ она может оказаться непечатаемой:
 * строка либо не разберётся вовсе, либо ТИХО даст другой смысл. Такие AST — ошибка
 * вызывающего, и сериализатор бросает `Error`, а не отбрасывает конструкцию молча:
 * тихая запись испорченного блока в body сущности хуже громкого падения при разработке.
 *
 * Бросает на:
 *   • имя поля, совпадающее с ключом грамматики (`limit` есть у orbis/budget):
 *     `limit=100` парсер разберёт как параметр запроса, и фильтр исчезнет без ошибки;
 *   • пустой список значений (`tags`, `excludeTags`, `anyOf`, `noneOf`, `sortBy`):
 *     `tags=` грамматика отвергает — пустой элемент запрещён;
 *   • `limit`, не являющийся целым больше нуля (`parseLimit` такое отвергает);
 *   • `}}` в любом месте результата: обёртка `{{query: … }}`, которую поставит
 *     вызывающий, закроется раньше времени, а рендерер блоков грамматики не знает,
 *     и кавычки тут не спасают.
 *
 * НЕ проверяется (проверить нечем):
 *   • литерал, равный date-токену, на строковом поле (`status=today`) — тип поля
 *     известен только каталогу, а каталога у сериализатора нет; кавычки не помогают:
 *     парсер снимает их до проверки на токен;
 *   • перенос строки внутри значения — `parse.ts` меняет его на пробел до разбора,
 *     независимо от кавычек; строка остаётся разбираемой, теряется только сам перенос.
 */

import type {
  QueryAst,
  QueryEntityRef,
  QueryFieldCondition,
  QueryFieldValue,
  QueryFilter,
} from './grammar';

/**
 * Ключи, занятые грамматикой в позиции имени конструкции (§6.1).
 *
 * Осознанный дубль `RESERVED_KEYS` из `parse.ts`: там константа не экспортирована,
 * а тянуть внутренности парсера в сериализатор хуже, чем повторить список. От дрейфа
 * защищает тест «набор совпадает с набором парсера», который сверяет набор с ПОВЕДЕНИЕМ
 * парсера, а не с его исходником.
 *
 * Ограничение касается только позиции имени конструкции: внутри `sortBy` те же имена
 * резолвятся как обычные поля (`sortBy=limit:asc` разбирается корректно), там запрета нет.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
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

/**
 * Маркер конца обёртки `{{query: … }}` — внутри напечатанного запроса недопустим.
 *
 * Экспортируется ради ЕДИНСТВЕННОГО описания этой формы на стороне запроса: строковый
 * редактор блока гасит «Сохранить» на том же маркере и объясняет причину теми же двумя
 * символами. Своя копия у него разъехалась бы с этой молча — а разойтись им нельзя: здесь
 * маркер роняет печать, там гасит кнопку, и обе стороны говорят об одном и том же проломе.
 */
export const BLOCK_END = '}}';

function fail(reason: string): never {
  throw new Error(`serializeQuery: ${reason}`);
}

/**
 * Символы, при которых значение обязано быть в кавычках: разделители конструкций,
 * оператор, разделители списка/отрицания, сравнения и сами кавычки с бэкслешем (§6.1).
 */
const QUOTE_TRIGGER_CHARS = [',', '=', '|', '&', '>', '<', '"', '\\'];

/**
 * Нужны ли кавычки. Помимо символов §6.1 — три случая, где неквотированное значение
 * НЕ возвращается парсером в тот же AST (проверено прогоном парсера, см. тесты):
 *   `..` в значении — `status=a..b` разбирается как диапазон (ошибка), а не как литерал;
 *   ведущий `!` — `status=!foo` даёт noneOf вместо anyOf, то есть ТИХО другой смысл;
 *   пустое значение — `search=` это ошибка «пустое значение», выразимо только как `""`.
 * Краевые пробелы срезал бы `trim` парсера. Лишние кавычки — косметика,
 * недостающие — чужой AST у пользовательского блока, поэтому правило — надмножество.
 */
function needsQuote(value: string): boolean {
  if (value === '') return true;
  if (value !== value.trim()) return true;
  if (value.startsWith('!')) return true;
  if (value.includes('..')) return true;
  return QUOTE_TRIGGER_CHARS.some((ch) => value.includes(ch));
}

/** Значение в форме, которую парсер вернёт байт-в-байт: `\` → `\\`, `"` → `\"` (§6.1). */
function quoteValue(value: string): string {
  if (!needsQuote(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Имя поля в позиции ключа конструкции: ключи грамматики сюда не пролезают. */
function fieldName(name: string): string {
  if (RESERVED_KEYS.has(name)) {
    fail(
      `имя поля '${name}' занято ключом грамматики §6.1 — такую конструкцию парсер ` +
        `разберёт как параметр запроса, а фильтр молча исчезнет`,
    );
  }
  return name;
}

/** Грамматика §6.1 требует хотя бы одно значение: пустой список напечатать нечем. */
function nonEmpty<T>(values: readonly T[], where: string): readonly T[] {
  if (values.length === 0) fail(`пустой список значений в '${where}' — печатать нечего`);
  return values;
}

/** Элемент значения: date-токен печатается голым словом, литерал — по правилам квотирования. */
function serializeFieldValue(value: QueryFieldValue): string {
  return value.kind === 'date_token' ? value.token : quoteValue(value.value);
}

/** `v1|v2` для anyOf и `!v1&!v2` для noneOf (§6.1). */
function serializeCondition(condition: QueryFieldCondition, field: string): string {
  const values = nonEmpty(condition.values, `${field}=`).map(serializeFieldValue);
  return condition.kind === 'noneOf' ? values.map((v) => `!${v}`).join('&') : values.join('|');
}

/** `this` либо UUID (§6.1). */
function serializeEntityRef(ref: QueryEntityRef): string {
  return ref.kind === 'this' ? 'this' : ref.id;
}

/**
 * Одна конструкция отбора. Switch исчерпывающий: новый узел грамматики ломает типизацию
 * в `default`, а не теряется молча при печати.
 *
 * Значения сравнений и границы диапазона печатаются сырыми: их синтаксис ограничен
 * парсером (decimal / YYYY-MM-DD / ISO 8601) и ни одного символа-триггера не содержит,
 * а кавычки вокруг границ диапазона только зашумили бы строку.
 * Имена полей не квотируются никогда — `"status"=x` парсер резолвить не станет.
 */
function serializeFilter(filter: QueryFilter): string {
  switch (filter.kind) {
    case 'tags':
      return `tags=${nonEmpty(filter.values, 'tags=').map(quoteValue).join('|')}`;
    case 'excludeTags':
      return `excludeTags=${nonEmpty(filter.values, 'excludeTags=').map(quoteValue).join('|')}`;
    case 'aspect':
      return `aspect=${quoteValue(filter.aspect)}`;
    case 'field':
      return `${fieldName(filter.field)}=${serializeCondition(filter.condition, filter.field)}`;
    case 'comparison':
      return `${fieldName(filter.field)}${filter.op}${filter.value.value}`;
    case 'range':
      return `${fieldName(filter.field)}=${filter.min.value}..${filter.max.value}`;
    case 'children_of':
      return `children_of=${serializeEntityRef(filter.of)}`;
    case 'parents_of':
      return `parents_of=${serializeEntityRef(filter.of)}`;
    case 'excludeBlocked':
      // Единственная допустимая форма (§6.1) — узел не несёт значения.
      return 'excludeBlocked=true';
    case 'archived':
      return `archived=${filter.value}`;
    default: {
      const exhaustive: never = filter;
      fail(`неизвестный узел фильтра ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Печатает AST в строку запроса §6.1: конструкции через `, `, фильтры в порядке массива,
 * затем параметры `sortBy`, `search`, `limit`, `display`, `title`.
 *
 * Порядок фильтров сохраняется дословно и ни один не выбрасывается: неоднозначные имена
 * (`currency`, `category_ref` живут в двух аспектах) парсер резолвит по `aspect=` в том же
 * запросе — потеря или перестановка конструкции сделала бы строку неразбираемой.
 *
 * Непечатаемый AST — `Error` (см. шапку модуля), а не тихо испорченная строка.
 */
export function serializeQuery(ast: QueryAst): string {
  const parts = ast.filters.map(serializeFilter);
  if (ast.sortBy !== undefined) {
    const fields = nonEmpty(ast.sortBy, 'sortBy=');
    parts.push(`sortBy=${fields.map((s) => `${s.field}:${s.direction}`).join('|')}`);
  }
  if (ast.search !== undefined) parts.push(`search=${quoteValue(ast.search)}`);
  if (ast.limit !== undefined) {
    // Дословно условие parseLimit (parse.ts): дробный, нулевой и отрицательный не разберутся.
    if (!Number.isInteger(ast.limit) || ast.limit <= 0) {
      fail(`limit должен быть целым числом больше 0, получено '${ast.limit}'`);
    }
    parts.push(`limit=${ast.limit}`);
  }
  if (ast.display !== undefined) parts.push(`display=${ast.display}`);
  if (ast.title !== undefined) parts.push(`title=${quoteValue(ast.title)}`);

  const query = parts.join(', ');
  // Одна проверка на весь результат вместо проверки каждого значения: `}}` может прийти
  // только из строки внутри AST (квотирование фигурных скобок не порождает), а разделители
  // конструкций не дают двум `}` из соседних значений слипнуться.
  if (query.includes(BLOCK_END)) {
    fail(
      `результат содержит '${BLOCK_END}' и закроет обёртку {{query: … }} раньше времени: ${query}`,
    );
  }
  return query;
}
