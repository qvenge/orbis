/**
 * Статическое подмножество Q-AST (§А6-1 — `ref.target`, §А2-1 — `scope`).
 *
 * Смысл гейта: цель ссылочного свойства и область свойства-«колонки» обязаны задавать
 * множество, вычислимое БЕЗ «сегодня» и без «этой сущности». Иначе значение `ref`,
 * законное в понедельник, во вторник оказалось бы вне цели — и пере-установка того же
 * значения стала бы отказом без единой правки данных (§А6-3 разбирает ровно такой класс).
 * По той же причине здесь нет места проекции: `limit`/`sortBy` у МНОЖЕСТВА бессмысленны,
 * а `archived=any` подменяет само множество, а не сужает его.
 *
 * Код отказа — строковая КОНСТАНТА рядом с бросающим кодом, как `PATTERN_NOT_REGULAR`
 * (`registry/property-type.ts:18`): единственная таблица кодов реформы и TRPC-маппинг
 * живут в `apps/server/src/errors.ts` и импортируют константу, второго определения быть
 * не должно.
 */
import type { QueryAst, QueryBound, QueryFilterNode, QueryPropValue } from './ast';
import { fieldRefKey } from './ast';

export const SCOPE_NOT_STATIC = 'SCOPE_NOT_STATIC';

export class ScopeNotStaticError extends Error {
  readonly code = SCOPE_NOT_STATIC;
  constructor(
    /** Что именно оказалось нестатическим — для сообщения владельцу, а не для кода. */
    readonly reason: string,
  ) {
    super(`запрос не статический: ${reason}`);
    this.name = 'ScopeNotStaticError';
  }
}

function isToken(value: QueryBound | undefined): boolean {
  return typeof value === 'object' && value !== null && 'token' in value;
}

/**
 * Ссылка на параметр страницы в значении (1в §3.8): множество зависело бы от переключателя на
 * странице. До этого места ссылку не пускает базовая схема (`queryAstSchema`), а сторож стоит и
 * здесь — он структурный и зовётся на дереве, пришедшем любым путём.
 */
function paramRef(value: QueryPropValue): string | null {
  const bounds =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? 'param' in value || 'token' in value
        ? [value]
        : [(value as { from?: QueryBound }).from, (value as { to?: QueryBound }).to]
      : [];
  for (const b of bounds) {
    if (typeof b === 'object' && b !== null && 'param' in b) return b.param;
  }
  return null;
}

/** Есть ли относительное время в значении предиката — включая обе границы `range`. */
function hasDateToken(value: QueryPropValue): string | null {
  if (Array.isArray(value)) return null; // список литералов — токенов в нём нет по схеме
  if (typeof value !== 'object' || value === null) return null;
  if ('token' in value) return value.token;
  const range = value as { from?: QueryBound; to?: QueryBound };
  if (isToken(range.from)) return (range.from as { token: string }).token;
  if (isToken(range.to)) return (range.to as { token: string }).token;
  return null;
}

function walk(node: QueryFilterNode): void {
  if ('and' in node) {
    for (const child of node.and) walk(child);
    return;
  }
  if ('or' in node) {
    for (const child of node.or) walk(child);
    return;
  }
  if ('not' in node) {
    walk(node.not);
    return;
  }
  // Адрес контракта (1в §3.1) статичен так же, как свойство: множество задаёт значение, а не
  // «сегодня». Нестатичен только токен в значении — и у адреса, и у свойства.
  if ('prop' in node) {
    const param = paramRef(node.value);
    if (param !== null) {
      throw new ScopeNotStaticError(
        `ссылка '$${param}' на параметр страницы у поля '${fieldRefKey(node.prop)}' — множество зависело бы от переключателя страницы`,
      );
    }
    const token = hasDateToken(node.value);
    if (token !== null) {
      throw new ScopeNotStaticError(
        `относительное время '${token}' у поля '${fieldRefKey(node.prop)}' — множество менялось бы каждый день`,
      );
    }
    return;
  }
  if ('search' in node) {
    throw new ScopeNotStaticError('полнотекстовый поиск даёт множество, зависящее от текста тел');
  }
  if ('archived' in node) {
    throw new ScopeNotStaticError(`'archived' подменяет множество целиком, а не сужает его`);
  }
  if ('rel' in node && node.rel.of === 'this') {
    throw new ScopeNotStaticError(`'this' зависит от записи, в которой лежит запрос`);
  }
}

/**
 * Бросает `ScopeNotStaticError`, если запрос не годится в `ref.target` или `scope`.
 * Реестра не спрашивает намеренно: гейт структурный, и его обязаны проходить одинаково
 * сид (без БД), исполнитель (в транзакции) и конструктор в браузере.
 */
// ОБХОДЧИК-Q: static
export function assertStaticQuery(ast: QueryAst): void {
  // Настройки показа блока данных (§5.4) — тоже проекция: множеству ни плитка, ни колонки,
  // ни «прятать пустое» ничего не добавляют, а молча принятые они выглядели бы как смысл.
  for (const key of [
    'sortBy',
    'limit',
    'display',
    'title',
    'aggregate',
    'columns',
    'hideEmpty',
  ] as const) {
    if (ast[key] !== undefined) {
      throw new ScopeNotStaticError(`проекция '${key}' у множества бессмысленна`);
    }
  }
  if (ast.filter !== null) walk(ast.filter);
}
