/**
 * Где работают блоки тела и что в теле сломано (спека страниц 1а §5.5, §5.6, §5.8, §4.2 шаг 7).
 *
 * Одна функция над деревом препрохода (`parsePageText`), а не правило внутри `parseBody`:
 * разбор тела не знает, чьё это тело — заметки, страницы или шаблона, — а место блока решает
 * именно вид. Знание нужно четырём потребителям сразу (рендерер, первый кадр, редактор, выбор
 * шаблона); четыре своих копии матрицы разъехались бы, и одна и та же строка была бы плашкой
 * на экране и нормой в редакторе.
 *
 * Модуль листовой: импортирует только `page-grammar` и разбор запроса с датами
 * (`query/parse-ast`, `query/dates`). Его тянет экран записи, а оттуда нельзя дотянуться до
 * барреля `@orbis/shared/doc` (tiptap, marked; сторожа `scripts/check-lazy-chunks.ts` и
 * `save.test.tsx`). Разбор запроса несёт zod (`query/ast.ts`), но экран записи уже держит его
 * через корневой `@orbis/shared`, так что нового веса в чанк это не добавляет.
 */

import { absoluteDateIn, RELATIVE_DATE_TOKENS } from '../query/dates';
import { effectiveLabel, type ParseRegistry, parseQueryAst } from '../query/parse-ast';
import { type GrammarErrorCode, type PageNode, parsePageText } from './page-grammar';

export type BodyKind = 'note' | 'page' | 'template';
export type PlacedBlock = 'container' | 'record' | 'body' | 'card' | 'query';

/**
 * Матрица §5.5. Блоки обвязки (`record` — кроме `{{body}}`, и `card`) показывают запись
 * `this`, а обычная запись и так рисуется через шаблон со своими заголовком и карточками —
 * в заметке они дали бы второй экземпляр на том же экране. Контейнеры в заметке не
 * показывались бы раскладкой (§9.1). `{{body}}` — место тела записи внутри шаблона, у страницы
 * тело и есть она сама.
 */
const MATRIX: Record<PlacedBlock, Record<BodyKind, boolean>> = {
  container: { note: false, page: true, template: true },
  record: { note: false, page: true, template: true },
  body: { note: false, page: false, template: true },
  card: { note: false, page: true, template: true },
  query: { note: true, page: true, template: true },
};

/** Матрица §5.5. */
export function blockAllowedIn(block: PlacedBlock, kind: BodyKind): boolean {
  return MATRIX[block][kind];
}

export type PlacementIssueCode =
  | GrammarErrorCode
  | 'BLOCK_MISPLACED'
  | 'SECOND_BODY'
  | 'ABSOLUTE_DATE'
  | 'QUERY_INVALID';

export interface PlacementIssue {
  code: PlacementIssueCode;
  message: string;
  hint?: string;
  path: number[];
}

/** Плашка §5.5 на месте блока обвязки или контейнера, попавшего в заметку. */
export const MISPLACED_HINT = 'работает на страницах и в шаблонах — сделать запись страницей?';

/**
 * Пустой блок данных — «блок не настроен», а не «все записи владельца» (Р-21-8): грамматика
 * принимает пустой текст законным `{filter: null}`, а сервер пустой фильтр не отсекает. Одна
 * формулировка на плашку тела, плашку блока в web (`features/page/blocks/DataBlock.tsx`,
 * `lib/query-blocks/batch.tsx`) и отказ блока сервером (`entity.blocks`, код `EMPTY`).
 */
export const EMPTY_QUERY_MESSAGE = 'пустой запрос: блок ничего не выбирает — настройте его';

const DATE_HINT = `замените на относительный токен: ${RELATIVE_DATE_TOKENS.join(', ')}`;

const KIND_WORD: Record<BodyKind, string> = {
  note: 'в заметке',
  page: 'на странице',
  template: 'в шаблоне',
};

/** Какой клетке матрицы подчиняется узел; `null` — текст и `broken`, места у них нет. */
function placedBlockOf(node: PageNode): PlacedBlock | null {
  switch (node.kind) {
    case 'columns':
    case 'tabs':
      return 'container';
    case 'record':
      return node.name === 'body' ? 'body' : 'record';
    case 'card':
      return 'card';
    case 'query':
      return 'query';
    default:
      return null;
  }
}

/** Как блок назван в плашке: так, как его пишут в тексте. */
function blockLabel(node: PageNode): string {
  switch (node.kind) {
    case 'columns':
    case 'tabs':
      return `Контейнер {{${node.kind}}}`;
    case 'record':
      return `Блок {{${node.name}}}`;
    case 'card':
      return `Блок {{card: ${node.aspect}}}`;
    default:
      return 'Блок';
  }
}

function misplaced(
  node: PageNode,
  block: PlacedBlock,
  kind: BodyKind,
  path: number[],
): PlacementIssue {
  if (block === 'body') {
    // Подсказка «сделать страницей» здесь соврала бы: на странице `{{body}}` тоже не работает.
    return {
      code: 'BLOCK_MISPLACED',
      message: `Блок {{body}} работает только в шаблоне, ${KIND_WORD[kind]} он не показывается.`,
      path,
    };
  }
  return {
    code: 'BLOCK_MISPLACED',
    message: `${blockLabel(node)} не показывается ${KIND_WORD[kind]}.`,
    hint: MISPLACED_HINT,
    path,
  };
}

function queryIssue(
  text: string,
  kind: BodyKind,
  reg: ParseRegistry,
  path: number[],
): PlacementIssue | null {
  // Без краевых пробелов — как разбирает блок данных (`lib/query-blocks/parse.ts` в web):
  // иначе позиция в плашке тела и в плашке самого блока разошлись бы на пробел после `query:`.
  const inner = text.trim();
  // Пустой текст НЕ разбирается (Р-21-8, как `bindAttrs` и `QueryBlock`): разбор принял бы его
  // деревом «весь корпус», шаблон с таким блоком считался бы разобранным, а блок данных
  // вернул бы все записи владельца.
  if (inner === '') return { code: 'QUERY_INVALID', message: EMPTY_QUERY_MESSAGE, path };
  const parsed = parseQueryAst(inner, reg);
  if (!parsed.ok) {
    const { message, position } = parsed.error;
    return {
      code: 'QUERY_INVALID',
      message:
        position === undefined
          ? `Запрос не разобран: ${message}`
          : `Запрос не разобран: ${message} (позиция ${position})`,
      path,
    };
  }
  if (kind === 'note') return null; // §5.6: заметка — документ, абсолютные даты в ней законны
  // Дерево РАЗБОРА, а не текст и не чужое дерево: `absoluteDateIn` узнаёт свойство только по
  // id, а `parseQueryAst` уже перевёл key (`user/deadline`) в id. Дерево с key в `prop`
  // прошло бы правило молча — у своих свойств владельца key ≠ id (перенос ревью задачи 6).
  const found = absoluteDateIn(parsed.ast, reg);
  if (found === null) return null;
  const def = reg.properties.get(found.prop);
  const name = def ? effectiveLabel(def.label, reg.locale) : found.prop;
  return {
    code: 'ABSOLUTE_DATE',
    message: `Абсолютная дата «${found.value}» у свойства «${name}»: ${KIND_WORD[kind]} даты только относительные — страница живёт годами, и такая дата через месяц покажет прошлое.`,
    hint: DATE_HINT,
    path,
  };
}

/**
 * Все проблемы тела данного вида в порядке документа (обход в глубину, сверху вниз).
 *
 * `path` — адрес узла в дереве `parsePageText`, нечётной длины:
 * `[i0]` — узел верхнего уровня `nodes[i0]`;
 * `[i0, p1, i1]` — узел `i1` в части `p1` контейнера `nodes[i0]`: у `columns` часть — это
 * `parts[p1]` (массив узлов), у `tabs` — `parts[p1].children`;
 * `[i0, p1, i1, p2, i2]` — то же на второй глубине (контейнер в части контейнера, §5.2).
 * Пары «часть, узел» повторяются на каждом спуске; индексы — в массивах дерева, не в тексте.
 *
 * Неуместный контейнер (в заметке) — одна плашка на весь контейнер, внутрь обход не идёт: он
 * не рисуется вовсе, и плашки его содержимого не показались бы нигде. `broken` лежит только на
 * верхнем уровне (препроход ломает весь внешний контейнер). На странице и в шаблоне он
 * сообщается своим грамматическим кодом; в заметке — `BLOCK_MISPLACED`: `broken` всегда разметка
 * контейнера, а контейнер в заметке не работает вовсе (§5.5), и совет вроде «колонок бывает от
 * 2 до 4» звал бы чинить то, что и после починки не заработает.
 */
export function bodyIssues(
  nodes: readonly PageNode[],
  kind: BodyKind,
  reg: ParseRegistry,
): PlacementIssue[] {
  const out: PlacementIssue[] = [];
  let bodies = 0;

  const visit = (list: readonly PageNode[], prefix: number[]) => {
    list.forEach((node, i) => {
      const path = [...prefix, i];
      if (node.kind === 'broken') {
        out.push(
          kind === 'note'
            ? {
                code: 'BLOCK_MISPLACED',
                message: 'Разметка контейнера не показывается в заметке.',
                hint: MISPLACED_HINT,
                path,
              }
            : { code: node.code, message: node.message, path },
        );
        return;
      }
      const block = placedBlockOf(node);
      if (block === null) return;
      if (!blockAllowedIn(block, kind)) {
        out.push(misplaced(node, block, kind, path));
        return;
      }
      if (block === 'body') {
        bodies += 1;
        if (bodies > 1) {
          out.push({
            code: 'SECOND_BODY',
            message:
              'Второй блок {{body}}: тело записи в шаблоне показывается один раз, лишний блок не рисуется.',
            path,
          });
        }
        return;
      }
      if (node.kind === 'query') {
        const issue = queryIssue(node.text, kind, reg, path);
        if (issue) out.push(issue);
        return;
      }
      const parts =
        node.kind === 'columns'
          ? node.parts
          : node.kind === 'tabs'
            ? node.parts.map((t) => t.children)
            : [];
      for (const [p, part] of parts.entries()) visit(part, [...path, p]);
    });
  };

  visit(nodes, []);
  return out;
}

/**
 * §4.2 шаг 7: причина «шаблон не разобран» или `null`. Шаблон с любой проблемой тела (§5.8)
 * исключается из выбора целиком, поэтому причина — первая проблема в порядке документа: её
 * человек и увидит первой, открыв шаблон.
 */
export function templateBrokenReason(text: string, reg: ParseRegistry): string | null {
  const [first] = bodyIssues(parsePageText(text), 'template', reg);
  return first ? first.message : null;
}
