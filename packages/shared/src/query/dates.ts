/**
 * Абсолютные даты в фильтре Q-AST — для правила спеки страниц §5.6: в блоке данных страницы
 * или шаблона дата бывает только относительной (концепция §4.2 — страница живёт годами, и
 * «2026-01-01» в ней через месяц показывает прошлое). В заметках абсолютные даты законны —
 * решает вызывающий по месту блока, функция только находит.
 *
 * Тип «дата» известен ТОЛЬКО РЕЕСТРУ (`date` | `timestamp`, включая core-проекции
 * `orbis/created_at`/`orbis/updated_at`): узел `{prop, op, value}` типа не несёт, а строка
 * «2026-01-01» у текстового свойства — текст, не дата. Эвристики по виду значения здесь нет
 * намеренно — от неё уже отказались в каталоге (`catalog.ts`, ловушка `user/timestamp_trap`).
 *
 * Обход — по образцу `hasDateToken`/`walk` из `static.ts`, но с обратным вопросом: там ищется
 * ТОКЕН (нестатичность), здесь — литерал там, где мог бы стоять токен.
 */
import type { QueryAst, QueryBound, QueryFilterNode } from './ast';
import { QUERY_DATE_TOKENS } from './ast';
import { acceptsDateTokenKind, type ParseRegistry } from './parse-ast';

/**
 * Относительные токены дат — то, что подсказка §5.6 предлагает вместо абсолютной даты.
 * Не второй словарь, а имя того же `QUERY_DATE_TOKENS` для потребителей страниц: набор один,
 * и токены периодов («этот месяц», 1б) добавятся туда же.
 */
export const RELATIVE_DATE_TOKENS = QUERY_DATE_TOKENS;

/** Первое абсолютное значение: скаляр или элемент списка, токен пропускается. */
function firstLiteral(values: readonly (QueryBound | undefined)[]): string | null {
  for (const v of values) {
    if (v === undefined) continue;
    if (typeof v === 'object' && v !== null && 'token' in v) continue;
    return String(v);
  }
  return null;
}

function walk(
  node: QueryFilterNode,
  reg: Pick<ParseRegistry, 'properties'>,
): { prop: string; value: string } | null {
  if ('and' in node || 'or' in node) {
    for (const child of 'and' in node ? node.and : node.or) {
      const found = walk(child, reg);
      if (found) return found;
    }
    return null;
  }
  if ('not' in node) return walk(node.not, reg);
  if (!('prop' in node)) return null; // `has=` называет свойство, но значения не несёт
  const def = reg.properties.get(node.prop);
  if (!def || !acceptsDateTokenKind(def.type.kind)) return null;
  const value = node.value;
  let literal: string | null;
  if (Array.isArray(value)) literal = firstLiteral(value);
  else if (typeof value === 'object' && value !== null && !('token' in value)) {
    // `range`: нижняя граница первой — «первая» в порядке чтения текста `a..b`.
    literal = firstLiteral([value.from, value.to]);
  } else literal = firstLiteral([value]);
  return literal === null ? null : { prop: node.prop, value: literal };
}

/**
 * Первая абсолютная дата/момент в фильтре (свойства date|timestamp, включая core
 * created_at/updated_at). `prop` — адрес из дерева (id свойства; у встроенных он же key),
 * `value` — литерал как записан. `null` — абсолютных дат нет.
 *
 * Проекцию не смотрит: даты в `sortBy`/`columns` — адреса свойств, а не значения.
 */
export function absoluteDateIn(
  ast: QueryAst,
  reg: Pick<ParseRegistry, 'properties'>,
): { prop: string; value: string } | null {
  return ast.filter === null ? null : walk(ast.filter, reg);
}
