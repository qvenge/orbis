// apps/server/src/query/params.ts
// Подстановка значений параметров страницы в дерево блока (спека 1в §5.1, РП-6).
//
// ПОЧЕМУ НА СЕРВЕРЕ, а не в клиенте. Ссылка `$<имя>` — часть текста блока, значение — состояние
// экрана (переключатель). Клиент шлёт текст как есть и значения полем элемента пачки
// (`entity.blocks`, `params`), сервер подставляет их ДО окна материализации и компиляции. Так
// нативный клиент получает то же поведение без своей копии подстановки, а проверка значения
// («это токен даты») стоит там же, где всё прочее доверие ко входу.
//
// ОТКАЗ — ПО БЛОКУ. Нет значения для имени или значение — не токен: `ExecError('VALIDATION')` с
// причиной в `details.reason`; пачка превращает его в ошибку ЭТОГО блока (`compileFailure`), соседи
// живы. Тихий «сегодня» вместо отказа нарисовал бы владельцу не тот горизонт без единого слова.

import {
  QUERY_DATE_TOKENS,
  type QueryAst,
  type QueryBound,
  type QueryDateToken,
  type QueryFilterNode,
  type QueryPropValue,
} from '@orbis/shared/query';
import { ExecError } from '../errors';

const DATE_TOKENS: ReadonlySet<string> = new Set(QUERY_DATE_TOKENS);

function isParam(v: unknown): v is { param: string } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'param' in v;
}

/**
 * Значение параметра по имени. `Object.hasOwn`, а не `params[name]`: имя из дерева — строка
 * `PARAM_NAME_RE`, и `constructor` иначе нашёл бы функцию прототипа, а не «значения нет».
 */
function valueFor(name: string, params: Readonly<Record<string, string>>): QueryDateToken {
  if (!Object.hasOwn(params, name)) {
    throw new ExecError('VALIDATION', `параметр «${name}» не объявлен на странице`, {
      reason: 'UNKNOWN_PARAM',
      name,
    });
  }
  const value = params[name] as string;
  // В 1в тип параметра один — `period`, и его значение — токен даты (§5.1, §14).
  if (!DATE_TOKENS.has(value)) {
    throw new ExecError(
      'VALIDATION',
      `значение параметра «${name}» — '${value}', а не токен даты: ${QUERY_DATE_TOKENS.join(', ')}`,
      { reason: 'PARAM_VALUE', name },
    );
  }
  return value as QueryDateToken;
}

/** Граница: ссылка → токен значения; прочее — тем же объектом. */
function bound(b: QueryBound, params: Readonly<Record<string, string>>): QueryBound {
  return isParam(b) ? { token: valueFor(b.param, params) } : b;
}

function value(v: QueryPropValue, params: Readonly<Record<string, string>>): QueryPropValue {
  if (isParam(v)) return bound(v, params);
  if (typeof v !== 'object' || v === null || Array.isArray(v) || 'token' in v) return v;
  const from = v.from === undefined ? undefined : bound(v.from, params);
  const to = v.to === undefined ? undefined : bound(v.to, params);
  if (from === v.from && to === v.to) return v;
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/**
 * Узел с подставленными значениями; без ссылок — ТОТ ЖЕ объект (дерево без параметров проезжает
 * подстановку бесплатно, и пачка из обычных блоков не пересобирает ни одного дерева).
 */
function node(n: QueryFilterNode, params: Readonly<Record<string, string>>): QueryFilterNode {
  if ('and' in n || 'or' in n) {
    const list = 'and' in n ? n.and : n.or;
    const next = list.map((c) => node(c, params));
    if (next.every((c, i) => c === list[i])) return n;
    return 'and' in n ? { and: next } : { or: next };
  }
  if ('not' in n) {
    const inner = node(n.not, params);
    return inner === n.not ? n : { not: inner };
  }
  if ('prop' in n) {
    const v = value(n.value, params);
    return v === n.value ? n : ({ ...n, value: v } as QueryFilterNode);
  }
  return n;
}

/**
 * Дерево блока с подставленными значениями параметров: каждая `{param}` → `{token}` значения из
 * `params`. Проверяются только ИСПОЛЬЗОВАННЫЕ имена — лишние значения пачки блоку не мешают (у
 * страницы параметров может быть больше, чем ссылок в этом блоке). Проекция ссылок не несёт.
 */
// ОБХОДЧИК-Q: substitute-params
export function substituteParams(
  ast: QueryAst,
  params: Readonly<Record<string, string>>,
): QueryAst {
  if (ast.filter === null) return ast;
  const filter = node(ast.filter, params);
  return filter === ast.filter ? ast : { ...ast, filter };
}
