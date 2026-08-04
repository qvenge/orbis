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
 * Вход — AST, произведённый `parseQuery` (или структурно ему эквивалентный). Формы,
 * которые парсер породить не может, за контрактом: пустые списки значений в `tags`/
 * `excludeTags`/`anyOf`/`noneOf` (грамматика требует непустой элемент), литерал, равный
 * date-токену, на строковом поле, имя поля, совпадающее с зарезервированным ключом
 * грамматики (`limit` аспекта orbis/budget), и перенос строки внутри значения
 * (парсер заменяет его пробелом до разбора, независимо от кавычек).
 */

import type {
  QueryAst,
  QueryEntityRef,
  QueryFieldCondition,
  QueryFieldValue,
  QueryFilter,
} from './grammar';

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

/** Элемент значения: date-токен печатается голым словом, литерал — по правилам квотирования. */
function serializeFieldValue(value: QueryFieldValue): string {
  return value.kind === 'date_token' ? value.token : quoteValue(value.value);
}

/** `v1|v2` для anyOf и `!v1&!v2` для noneOf (§6.1). */
function serializeCondition(condition: QueryFieldCondition): string {
  const values = condition.values.map(serializeFieldValue);
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
      return `tags=${filter.values.map(quoteValue).join('|')}`;
    case 'excludeTags':
      return `excludeTags=${filter.values.map(quoteValue).join('|')}`;
    case 'aspect':
      return `aspect=${quoteValue(filter.aspect)}`;
    case 'field':
      return `${filter.field}=${serializeCondition(filter.condition)}`;
    case 'comparison':
      return `${filter.field}${filter.op}${filter.value.value}`;
    case 'range':
      return `${filter.field}=${filter.min.value}..${filter.max.value}`;
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
      throw new Error(`serializeQuery: неизвестный узел фильтра ${JSON.stringify(exhaustive)}`);
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
 */
export function serializeQuery(ast: QueryAst): string {
  const parts = ast.filters.map(serializeFilter);
  // Пустой список сортировки печатать нечем: `sortBy=` — ошибка парсинга. Для AST
  // отсутствие сортировки и пустой список означают одно и то же (поле опционально).
  if (ast.sortBy && ast.sortBy.length > 0) {
    parts.push(`sortBy=${ast.sortBy.map((s) => `${s.field}:${s.direction}`).join('|')}`);
  }
  if (ast.search !== undefined) parts.push(`search=${quoteValue(ast.search)}`);
  if (ast.limit !== undefined) parts.push(`limit=${ast.limit}`);
  if (ast.display !== undefined) parts.push(`display=${ast.display}`);
  if (ast.title !== undefined) parts.push(`title=${quoteValue(ast.title)}`);
  return parts.join(', ');
}
