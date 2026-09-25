/**
 * Где работают блоки тела и что в теле сломано (спека страниц 1а §5.5, §5.6, §5.8, §4.2 шаг 7).
 *
 * Одна функция над деревом препрохода (`parsePageText`), а не правило внутри `parseBody`:
 * разбор тела не знает, чьё это тело — заметки, страницы или шаблона, — а место блока решает
 * именно вид. Знание нужно четырём потребителям сразу (рендерер, первый кадр, редактор, выбор
 * шаблона); четыре своих копии матрицы разъехались бы, и одна и та же строка была бы плашкой
 * на экране и нормой в редакторе.
 *
 * Модуль листовой: импортирует только `page-grammar`, разбор запроса с датами
 * (`query/parse-ast`, `query/dates`) и строки отказов (`contracts/block-messages`, без импортов). Его тянет экран записи, а оттуда нельзя дотянуться до
 * барреля `@orbis/shared/doc` (tiptap, marked; сторожа `scripts/check-lazy-chunks.ts` и
 * `save.test.tsx`). Разбор запроса несёт zod (`query/ast.ts`), но экран записи уже держит его
 * через корневой `@orbis/shared`, так что нового веса в чанк это не добавляет.
 */

import { EMPTY_QUERY_MESSAGE } from '../contracts/block-messages';
import { absoluteDateIn, RELATIVE_DATE_TOKENS } from '../query/dates';
import { effectiveLabel, type ParseRegistry, parseQueryAst } from '../query/parse-ast';
import {
  CONTAINER_LIMITS,
  type GrammarErrorCode,
  type PageNode,
  parsePageText,
} from './page-grammar';

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

const BODY_KINDS: readonly BodyKind[] = ['note', 'page', 'template'];

/** Роды тела, где блок работает, — та же матрица §5.5, прочитанная по строке (меню «/»). */
export function kindsAllowing(block: PlacedBlock): BodyKind[] {
  return BODY_KINDS.filter((kind) => blockAllowedIn(block, kind));
}

/**
 * Место узлов страницы в ДОКУМЕНТЕ (§5.2): грамматика пускает контейнеры, блоки обвязки и
 * карточки только на верх тела или в часть контейнера, а контейнеры — не глубже
 * `CONTAINER_LIMITS.depth`. Схема документа шире (`block+` у пункта списка, цитаты, ячейки), и
 * узел вне своего места не пережил бы повторного разбора: сверка скелета при записи увела бы ВСЁ
 * тело в один `rawBlock`, а у страницы нет ни правки разметкой, ни правки `rawBlock`.
 *
 * Одно правило на два входа редактора: меню «/» спрашивает его про место каретки (удобство —
 * не предлагать то, что нельзя), страж транзакций — про документ после шага (защита — вставка
 * буфера, обёртка цитатой или списком, перетаскивание). Своя копия у каждого разошлась бы, и
 * меню спрятало бы то, что вставка молча пропустила.
 */
export const LAYOUT_HOSTS: ReadonlySet<string> = new Set([
  'doc',
  'columns',
  'column',
  'tabs',
  'tab',
]);
/** Узлы-контейнеры: их вложенность и считает предел глубины. */
export const CONTAINER_NODES: ReadonlySet<string> = new Set(['columns', 'tabs']);
/** Узлы страницы, которым место задаёт грамматика: контейнеры, блок обвязки, карточка. */
const LAYOUT_NODES: ReadonlySet<string> = new Set([
  ...CONTAINER_NODES,
  'recordBlock',
  'aspectCard',
]);

/**
 * Законно ли узлу страницы стоять под этой цепочкой предков (от `doc` до родителя включительно):
 * все предки — верх, контейнер или его часть; контейнеру ещё и предков-контейнеров меньше предела,
 * иначе он встанет уровнем глубже `CONTAINER_LIMITS.depth`.
 */
export function layoutPlaceAllows(ancestors: readonly string[], container: boolean): boolean {
  let containers = 0;
  for (const name of ancestors) {
    if (!LAYOUT_HOSTS.has(name)) return false;
    if (CONTAINER_NODES.has(name)) containers += 1;
  }
  return !container || containers < CONTAINER_LIMITS.depth;
}

/**
 * Узел документа — ровно то, что правилу о нём нужно. Структурный тип, а не `Node` ProseMirror:
 * модуль листовой (tiptap сюда не тянется), а живой узел подходит под него как есть.
 */
export type LayoutDocNode = {
  type: { name: string };
  isTextblock: boolean;
  forEach: (f: (child: LayoutDocNode) => void) => void;
};

/**
 * Есть ли в документе узел страницы не на своём месте (`layoutPlaceAllows`). Обход по блокам, в
 * текстовые блоки не спускается — O(блоков), по силам стражу каждой транзакции.
 */
export function layoutMisplaced(doc: LayoutDocNode): boolean {
  const ancestors: string[] = [];
  const visit = (node: LayoutDocNode): boolean => {
    const name = node.type.name;
    if (LAYOUT_NODES.has(name) && !layoutPlaceAllows(ancestors, CONTAINER_NODES.has(name))) {
      return true;
    }
    if (node.isTextblock) return false;
    ancestors.push(name);
    let found = false;
    node.forEach((child) => {
      if (!found && visit(child)) found = true;
    });
    ancestors.pop();
    return found;
  };
  return visit(doc);
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
 * Пустой блок данных — «блок не настроен» (Р-21-8). Текст живёт в листовом
 * `contracts/block-messages.ts`: одна формулировка на плашку тела, плашку блока в web и отказ
 * блока сервером (`entity.blocks`, код `EMPTY`). Реэкспорт здесь — чтобы потребители плашек тела
 * брали его оттуда же, откуда `bodyIssues`.
 */
export { EMPTY_QUERY_MESSAGE };

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
 * Узел дерева `parsePageText` по пути проблемы (формат пути — докблок `bodyIssues`).
 *
 * Одна копия разыменования: пути выдаёт `bodyIssues`, а читают их рендерер (плашка на месте
 * узла) и тесты. Своя копия у каждого разъехалась бы с форматом при первой же его правке —
 * и плашка встала бы на чужой узел молча.
 */
export function nodeAt(nodes: readonly PageNode[], path: readonly number[]): PageNode {
  let list: readonly PageNode[] = nodes;
  let node = list[path[0] as number] as PageNode;
  for (let i = 1; i < path.length; i += 2) {
    const part = path[i] as number;
    if (node.kind === 'columns') list = node.parts[part] as PageNode[];
    else if (node.kind === 'tabs') list = (node.parts[part] as { children: PageNode[] }).children;
    else throw new Error(`путь спускается в узел ${node.kind}, у которого нет частей`);
    node = list[path[i + 1] as number] as PageNode;
  }
  if (!node) throw new Error(`по пути ${path.join('.')} узла нет`);
  return node;
}

/**
 * Определение аспекта — выводом из реестра разбора, а не импортом `registry/property-type`:
 * список импортов модуля держит сторож листовости (`placement.test.ts`), и тип того не стоит.
 */
type CardAspect = ParseRegistry['aspects'] extends ReadonlyMap<string, infer A> ? A : never;

/**
 * Аспект по тексту карточки: ключ (`orbis/goal`) или подпись в кавычках (`"Цель"`) — те же две
 * формы имени, что у `aspect=` в запросе (§А5-3а/б), и то же правило подписи: локаль реестра,
 * регистр и края не важны. Неоднозначная подпись не угадывается — карточка остаётся непривязанной.
 *
 * Живёт здесь, в листовом модуле, а не в `bind-query.ts`: её зовут и привязка документа на
 * сервере, и рендерер страниц в чанке экрана записи, которому баррель `@orbis/shared/doc`
 * запрещён. Две копии правила «какой аспект назван» дали бы карточку, привязанную в документе,
 * но пустую на показе.
 */
export function aspectOfCardText(text: string, reg: ParseRegistry): CardAspect | undefined {
  const name = text.trim();
  const aspects = [...reg.aspects.values()];
  if (!name.startsWith('"')) return aspects.find((a) => a.key === name);
  if (name.length < 2 || !name.endsWith('"')) return undefined;
  const label = name.slice(1, -1).trim().toLowerCase();
  const found = aspects.filter(
    (a) => effectiveLabel(a.label, reg.locale).trim().toLowerCase() === label,
  );
  return found.length === 1 ? found[0] : undefined;
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
