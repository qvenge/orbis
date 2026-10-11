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
 * (`query/parse-ast`, `query/dates`), обход ссылок на параметры (`query/page-only`, без импортов) и
 * строки отказов (`contracts/block-messages`, без импортов). Его тянет экран записи, а оттуда нельзя дотянуться до
 * барреля `@orbis/shared/doc` (tiptap, marked; сторожа `scripts/check-lazy-chunks.ts` и
 * `save.test.tsx`). Разбор запроса несёт zod (`query/ast.ts`), но экран записи уже держит его
 * через корневой `@orbis/shared`, так что нового веса в чанк это не добавляет.
 */

import { EMPTY_QUERY_MESSAGE } from '../contracts/block-messages';
import { absoluteDateIn } from '../query/dates';
import { paramNamesIn } from '../query/page-only';
import { effectiveLabel, type ParseRegistry, parseQueryAst } from '../query/parse-ast';
import { QUERY_DATE_TOKEN_LABELS } from '../query/tokens';
import {
  CONTAINER_LIMITS,
  type GrammarErrorCode,
  type PageNode,
  type PageParamDecl,
  paramDeclsOf,
  parsePageText,
} from './page-grammar';

export type BodyKind = 'note' | 'page' | 'template';
export type PlacedBlock =
  | 'container'
  | 'record'
  | 'body'
  | 'card'
  | 'query'
  | 'own-cards'
  | 'host'
  | 'param';

/**
 * Матрица §5.5. Блоки обвязки (`record` — кроме `{{body}}`, и `card`) показывают запись
 * `this`, а обычная запись и так рисуется через шаблон со своими заголовком и карточками —
 * в заметке они дали бы второй экземпляр на том же экране. Контейнеры в заметке не
 * показывались бы раскладкой (§9.1). `{{body}}` — место тела записи внутри шаблона, у страницы
 * тело и есть она сама.
 *
 * Срез 1б (РП-4): свои карточки `{{cards: own}}` — как карточка, они тоже показывают запись
 * `this`. Блоки хоста `{{apps}}` и `{{records}}` — только страница: они не показывают запись вовсе,
 * а рисуют примитив хоста, и в шаблоне повторились бы на экране каждой записи этого шаблона.
 *
 * Срез 1в (§5.1): параметр страницы `{{param: …}}` — страница и шаблон. В заметке переключателю
 * негде жить: значение параметра — состояние экрана страницы, а заметка — документ; ссылки `$` в её
 * блоках данных всё равно отвергнет разбор без места (`PAGE_ONLY`).
 */
const MATRIX: Record<PlacedBlock, Record<BodyKind, boolean>> = {
  container: { note: false, page: true, template: true },
  record: { note: false, page: true, template: true },
  body: { note: false, page: false, template: true },
  card: { note: false, page: true, template: true },
  query: { note: true, page: true, template: true },
  'own-cards': { note: false, page: true, template: true },
  host: { note: false, page: true, template: false },
  param: { note: false, page: true, template: true },
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
 * `CONTAINER_LIMITS.depth`.
 *
 * МЕСТО гарантирует схема (спека 1б §10, 1а новое-9): узлы страницы — группа `pageBlock`, и её
 * пускают в `content` только `doc`, `column` и `tab` (`PAGE_BLOCK_PARENTS`). Документ с колонками
 * под цитатой или блоком в пункте списка не собрать, и гейт записи отвергает его `VALIDATION`,
 * как одну колонку. ГЛУБИНУ схема без группы на каждый уровень не выразит — её держит правило ниже
 * (`layoutMisplaced`), а у записи ещё и страховка скелета в `convert.ts` (`rawBlock`).
 *
 * Правило остаётся ради глубины и меню «/», одно на два входа редактора: меню спрашивает его про
 * место каретки (удобство — не предлагать то, что нельзя), страж транзакций — про документ после
 * шага (вставка буфера или перетаскивание контейнера третьим уровнем). Своя копия у каждого
 * разошлась бы, и меню спрятало бы то, что вставка молча пропустила. Проверка места в нём дешева
 * и нужна меню: каретка в пункте списка — не место для контейнера.
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
/** Группа схемы, в которую входят узлы страницы (`nodes/layout.ts`, `nodes/record-blocks.ts`). */
export const PAGE_BLOCK_GROUP = 'pageBlock';
/**
 * Узлы страницы — члены группы `pageBlock`: контейнеры, блок обвязки, карточка, свои карточки
 * `ownCards`, блок хоста `hostBlock` (1б) и параметр `paramBlock` (1в). Совпадение со схемой
 * сторожит `schema.test.ts`.
 */
export const LAYOUT_NODES: ReadonlySet<string> = new Set([
  ...CONTAINER_NODES,
  'recordBlock',
  'aspectCard',
  'ownCards',
  'hostBlock',
  'paramBlock',
]);
/**
 * Родители, в чьём `content` разрешена группа `pageBlock`: верх документа и части контейнеров.
 * Совпадение со схемой сторожит `schema.test.ts`; по этому списку считает перепись `census-v3`.
 */
export const PAGE_BLOCK_PARENTS: ReadonlySet<string> = new Set(['doc', 'column', 'tab']);

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
 * Есть ли в документе узел страницы не на своём месте (`layoutPlaceAllows`). Место гарантирует
 * схема (группа `pageBlock`), так что в документе редактора правило ловит глубину; проверка места
 * в нём — та же, что у меню «/», и второй копии правила не заводит. Обход по блокам, в текстовые
 * блоки не спускается — O(блоков), по силам стражу каждой транзакции.
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
  | 'SECOND_BLOCK'
  | 'ABSOLUTE_DATE'
  | 'QUERY_INVALID'
  // Параметр страницы (1в §5.1): ошибка блока `{{param}}` (неверное умолчание, чужой токен…) и
  // ссылка `$<имя>` блока данных на имя, которого тело не объявляет.
  | 'PARAM_INVALID';

export interface PlacementIssue {
  code: PlacementIssueCode;
  message: string;
  hint?: string;
  path: number[];
}

/** Плашка §5.5 на месте блока обвязки или контейнера, попавшего в заметку. */
export const MISPLACED_HINT = 'работает на страницах и в шаблонах — сделать запись страницей?';

/**
 * Подсказка блока хоста в заметке (1б, РП-4). Общая `MISPLACED_HINT` здесь соврала бы: блок хоста
 * в шаблоне не работает. В шаблоне подсказки нет вовсе, как у `{{body}}` на странице: шаблон
 * страницей не делают, блок из него убирают.
 */
export const HOST_MISPLACED_HINT = 'работает только на страницах — сделать запись страницей?';

/**
 * Плашка «второй» (РП-4): карточки записи рисуются один раз, лишний блок — подсказка на своём
 * месте, а не повтор. Тексты живут здесь одной формулировкой для `bodyIssues` и плана рендера
 * web, который ловит повтор разными написаниями; второй `{{cards: own}}` — своим текстом рядом.
 */
export const SECOND_CARDS_MESSAGE =
  'Второй блок {{cards}}: карточки записи показываются один раз, лишний блок не рисуется.';

/** Плашка второго `{{cards: own}}` (1б §8.5) — той же формулировкой, что у `{{cards}}`. */
export const SECOND_OWN_CARDS_MESSAGE =
  'Второй блок {{cards: own}}: свои карточки записи показываются один раз, лишний блок не рисуется.';

/**
 * Плашка второго параметра с тем же именем (1в §5.1, механизм «второй» 1б): объявление действует
 * первое, лишний блок не рисуется.
 */
export function secondParamMessage(name: string): string {
  return `Второй параметр «${name}»: действует первый, лишний блок не рисуется.`;
}

/**
 * Ссылка `$<имя>` на параметр, которого тело не объявляет (1в §5.1): «ошибка блока с плашкой». Одна
 * формулировка на плашку блока данных в web и на причину «шаблон не разобран».
 */
export function undeclaredParamMessage(name: string, kind: BodyKind): string {
  return `параметр «${name}» не объявлен ${KIND_WORD[kind]}`;
}

/** Текст плашки второй карточки одного аспекта; `raw` — блок, как он написан. */
export function secondCardMessage(raw: string): string {
  return `Второй ${raw.trim()}: карточка этого аспекта уже стоит выше, лишняя не рисуется.`;
}

/**
 * Пустой блок данных — «блок не настроен» (Р-21-8). Текст живёт в листовом
 * `contracts/block-messages.ts`: одна формулировка на плашку тела, плашку блока в web и отказ
 * блока сервером (`entity.blocks`, код `EMPTY`). Реэкспорт здесь — чтобы потребители плашек тела
 * брали его оттуда же, откуда `bodyIssues`.
 */
export { EMPTY_QUERY_MESSAGE };

/** Подсказка — перечень токенов из словаря (`tokens.ts`, РП-17): второго списка нет. */
const DATE_HINT = `замените на относительный токен: ${Object.keys(QUERY_DATE_TOKEN_LABELS).join(', ')}`;

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
    case 'ownCards':
      return 'own-cards';
    case 'host':
      return 'host';
    case 'param':
      return 'param';
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
    // Канонической печатью: `{{cards:own}}` и `{{cards: own}}` — один блок, и плашка зовёт его одинаково.
    case 'ownCards':
      return 'Блок {{cards: own}}';
    case 'host':
      return `Блок {{${node.name}}}`;
    // Именем, а не строкой целиком: маркер длинный, а плашка называет, КАКОЙ параметр.
    case 'param':
      return node.decl === null ? 'Блок {{param}}' : `Блок {{param: ${node.decl.name}}}`;
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
  if (block === 'host') {
    return {
      code: 'BLOCK_MISPLACED',
      message: `${blockLabel(node)} не показывается ${KIND_WORD[kind]}.`,
      ...(kind === 'note' && { hint: HOST_MISPLACED_HINT }),
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

/**
 * Проблема блока данных. Место разбора — по роду тела (1в §3.8, РП-5): на странице и в шаблоне
 * `$`-ссылка законна (`place: 'page'`), в заметке — отказ `PAGE_ONLY` с подсказкой, плашкой
 * `QUERY_INVALID`. Правило абсолютной даты на блоке со ссылкой работает как обычно: ссылка —
 * не литерал (`absoluteDateIn`). Ссылка на имя, которого нет среди объявлений тела (`declared`),
 * — `PARAM_INVALID`; проверяется после даты — порядок тот же, что у плашек блока данных в web.
 */
// ОБХОДЧИК-Q: placement-issue
function queryIssue(
  text: string,
  kind: BodyKind,
  reg: ParseRegistry,
  path: number[],
  declared: ReadonlyMap<string, PageParamDecl>,
): PlacementIssue | null {
  // Без краевых пробелов — как разбирает блок данных (`lib/query-blocks/parse.ts` в web):
  // иначе позиция в плашке тела и в плашке самого блока разошлись бы на пробел после `query:`.
  const inner = text.trim();
  // Пустой текст НЕ разбирается (Р-21-8, как `bindAttrs` и `QueryBlock`): разбор принял бы его
  // деревом «весь корпус», шаблон с таким блоком считался бы разобранным, а блок данных
  // вернул бы все записи владельца.
  if (inner === '') return { code: 'QUERY_INVALID', message: EMPTY_QUERY_MESSAGE, path };
  const parsed = parseQueryAst(inner, reg, kind === 'note' ? {} : { place: 'page' });
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
  if (found === null) {
    const missing = paramNamesIn(parsed.ast).find((n) => !declared.has(n));
    return missing === undefined
      ? null
      : { code: 'PARAM_INVALID', message: undeclaredParamMessage(missing, kind), path };
  }
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
 *
 * Второй `{{cards}}`, второй `{{cards: own}}`, повтор `{{card: X}}` ОДИНАКОВЫМ текстом и второй
 * параметр с тем же именем (1в) — `SECOND_BLOCK` здесь; разные написания одного аспекта (ключ и подпись) без реестра не узнать —
 * их ловит план рендера web, где реестр есть. Неуместные и лежащие в `broken` блоки не считаются: они и так не рисуются.
 *
 * Параметр страницы (1в §5.1) на странице и в шаблоне: ошибка блока `{{param}}` и ссылка блока данных
 * на необъявленное имя — `PARAM_INVALID` (шаблон с таким блоком к выбору не предлагается).
 */
export function bodyIssues(
  nodes: readonly PageNode[],
  kind: BodyKind,
  reg: ParseRegistry,
): PlacementIssue[] {
  const out: PlacementIssue[] = [];
  let bodies = 0;
  let cards = 0;
  let ownCards = 0;
  const cardTexts = new Set<string>();
  const paramNames = new Set<string>();
  // Объявления — со всего тела, а не «выше блока»: переключатель ниже блока законен (§5.1).
  const declared = paramDeclsOf(nodes);

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
      if (node.kind === 'record' && node.name === 'cards') {
        cards += 1;
        if (cards > 1) {
          out.push({ code: 'SECOND_BLOCK', message: SECOND_CARDS_MESSAGE, path });
        }
        return;
      }
      if (node.kind === 'ownCards') {
        ownCards += 1;
        if (ownCards > 1) {
          out.push({ code: 'SECOND_BLOCK', message: SECOND_OWN_CARDS_MESSAGE, path });
        }
        return;
      }
      // Второй параметр с тем же именем (1в §5.1). Параметр с ошибкой блока в счёт «второго» не
      // идёт — его объявление не действует; сама ошибка — `PARAM_INVALID` с текстом препрохода:
      // плашка на месте блока и причина «шаблон не разобран» (перенос гейта задачи 4, M-4).
      if (node.kind === 'param') {
        const name = node.decl?.name;
        if (name === undefined) {
          out.push({
            code: 'PARAM_INVALID',
            message: `${blockLabel(node)}: ${node.problem}.`,
            path,
          });
        } else if (paramNames.has(name)) {
          out.push({ code: 'SECOND_BLOCK', message: secondParamMessage(name), path });
        } else {
          paramNames.add(name);
        }
        return;
      }
      if (node.kind === 'card') {
        // `aspect` препроход уже отдал без краевых пробелов — «{{card:  x }}» и «{{card: x}}» равны.
        if (cardTexts.has(node.aspect)) {
          out.push({ code: 'SECOND_BLOCK', message: secondCardMessage(node.raw), path });
        } else {
          cardTexts.add(node.aspect);
        }
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
        const issue = queryIssue(node.text, kind, reg, path, declared);
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
 *
 * С подсказкой, если она у проблемы есть (С1а-9 «с подсказкой»): плашка сломанного шаблона —
 * единственное место, где владелец узнаёт причину, не открывая настройку, и абсолютная дата без
 * списка относительных токенов звала бы чинить наугад (финальное ревью, F-M1).
 */
export function templateBrokenReason(text: string, reg: ParseRegistry): string | null {
  const [first] = bodyIssues(parsePageText(text), 'template', reg);
  if (!first) return null;
  if (first.hint === undefined) return first.message;
  return `${first.message} ${first.hint.charAt(0).toUpperCase()}${first.hint.slice(1)}.`;
}
