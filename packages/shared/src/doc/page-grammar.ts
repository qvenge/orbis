/**
 * Грамматика тела v3 — препроход по строкам (спека страниц 1а, §5.2–§5.3, §5.7–§5.8).
 *
 * Почему препроход, а не блочный токенайзер `marked` (Ф-1а-7). У CommonMark есть ленивое
 * продолжение: строка без отступа сразу после пункта списка, цитаты или html-блока считается их
 * продолжением. Маркер закрытия `{{/column}}`, написанный вплотную под `- пункт`, уезжал бы внутрь
 * `list_item`, контейнер становился «незакрытым», а откат в raw забирал весь контейнер со всеми
 * колонками. Здесь текст режется по маркерам ДО markdown-разбора: маркер — целая строка с колонки 0
 * вне забора кода, поэтому ленивому продолжению нечего утащить. Откат в raw остаётся поблочным
 * внутри частей, а ошибки препроход видит сам и сохраняет дословную подстроку исходника.
 *
 * Одна копия правил маркеров (РП-6) — цель среза, а не сегодняшнее состояние. Сейчас модуль —
 * единственное место правил контейнеров и блоков обвязки, но `{{query:…}}` пока распознают ещё
 * токенайзер `nodes/query-block.ts` и первый кадр `bodySegments` (web), а `parseBody` этот модуль
 * не зовёт. На него переходят дальше по срезу: `parseBody` — задача 8, первый кадр — задача 11,
 * сторож «одной копии» — задача 17. Зачем одна копия: вторая рано или поздно разъехалась бы с
 * этой, и человек видел бы на первом кадре один разбор, а в редакторе через мгновение — другой.
 *
 * Модуль листовой ПО ЗАКОНУ — без единого импорта. Его статически тянет экран записи, а из
 * `DetailScreen` нельзя дотянуться до барреля `@orbis/shared/doc` (сторожа
 * `scripts/check-lazy-chunks.ts` и `save.test.tsx`): любой импорт здесь — кандидат протащить
 * tiptap или marked в эагерный чанк. Поэтому свой мини-сканер заборов кода вместо лексера.
 */

export const RECORD_BLOCK_NAMES = [
  'title',
  'tags',
  'body',
  'cards',
  'subtasks',
  'blockers',
  'backlinks',
  'versions',
  'thread',
] as const;
export type RecordBlockName = (typeof RECORD_BLOCK_NAMES)[number];

export const GRAMMAR_ERROR_CODES = [
  'CONTAINER_UNCLOSED',
  'PART_UNCLOSED',
  'TEXT_OUTSIDE_PART',
  'DEPTH_EXCEEDED',
  'PART_COUNT',
  'PART_OUTSIDE_CONTAINER',
  'CLOSE_WITHOUT_OPEN',
] as const;
export type GrammarErrorCode = (typeof GRAMMAR_ERROR_CODES)[number];

/**
 * Пределы держит препроход, а не `content`-выражение схемы документа: нарушение схемы — это
 * отказ записи всего тела, а человеку нужна плашка на месте контейнера с его текстом (§5.8).
 * `depth` — сколько контейнеров можно вложить друг в друга, считая внешний.
 */
export const CONTAINER_LIMITS = {
  columns: { min: 2, max: 4 },
  tabs: { min: 1, max: 8 },
  depth: 2,
} as const;

export type PageNode =
  | { kind: 'text'; text: string } // кусок markdown дословно
  | { kind: 'query'; text: string; raw: string } // {{query:…}}, возможно многострочный
  | { kind: 'record'; name: RecordBlockName; raw: string }
  | { kind: 'card'; aspect: string; raw: string } // ключ или «подпись в кавычках» как написано
  | { kind: 'columns'; parts: PageNode[][]; raw: string }
  | { kind: 'tabs'; parts: { label: string; children: PageNode[] }[]; raw: string }
  | { kind: 'broken'; code: GrammarErrorCode; message: string; raw: string };

/** Сообщения ошибок §5.8 по-русски — для плашек. */
export const GRAMMAR_ERROR_MESSAGES: Record<GrammarErrorCode, string> = {
  CONTAINER_UNCLOSED: 'Контейнер не закрыт: ниже нет строки {{/columns}} или {{/tabs}}.',
  PART_UNCLOSED:
    'Колонка или вкладка не закрыта: перед следующей частью или концом контейнера нужна строка {{/column}} или {{/tab}}.',
  TEXT_OUTSIDE_PART:
    'Внутри контейнера — только его колонки или вкладки: текст и блоки пишутся внутри них.',
  DEPTH_EXCEEDED:
    'Слишком глубокая вложенность: контейнер можно положить в колонку или вкладку другого контейнера, но не глубже.',
  PART_COUNT: `Колонок бывает от ${CONTAINER_LIMITS.columns.min} до ${CONTAINER_LIMITS.columns.max}, вкладок — от ${CONTAINER_LIMITS.tabs.min} до ${CONTAINER_LIMITS.tabs.max}.`,
  PART_OUTSIDE_CONTAINER:
    'Колонка пишется только внутри {{columns}}, вкладка — только внутри {{tabs}}.',
  CLOSE_WITHOUT_OPEN: 'Закрывающая строка без пары: выше нет открытия, которое она закрывает.',
};

// Регэкспы маркеров — единственная их копия (РП-6). Применяются к строке без `\n` и без
// хвостового `\r`, поэтому тело с `\r\n` разбирается так же, как с `\n`. Хвостовые пробелы
// разрешены: их не видно глазом, и отказ из-за них был бы ловушкой.
// Подпись — только у открывающего `tab`: `{{columns: x}}`, `{{/tab: x}}`, `{{column: x}}` не
// маркеры, а текст (§5.7 — незнакомая форма остаётся текстом).
// Подпись и аспект начинаются с НЕпробельного символа (`\S`), а не `\s*(.+?)`: там пробелы
// могли достаться и `\s*`, и `.+?`, и строка `{{tab:` с длинным хвостом пробелов без `}}`
// разбиралась квадратично (40 тыс. символов — 1,7 с). Здесь пробелы берёт только `[ \t]*` —
// разбор линейный, а пустая или пробельная подпись (`{{tab:   }}`) остаётся текстом, как `{{tab:}}`.
const CONTAINER_MARKER_RE = /^\{\{(\/?)(columns|column|tabs|tab)\}\}[ \t]*$/;
const TAB_LABEL_RE = /^\{\{tab:[ \t]*(\S.*?)\}\}[ \t]*$/;
const RECORD_BLOCK_RE =
  /^\{\{(title|tags|body|cards|subtasks|blockers|backlinks|versions|thread)\}\}[ \t]*$/;
const CARD_RE = /^\{\{card:[ \t]*(\S.*?)\}\}[ \t]*$/;
// Блок данных — как у токенайзера `queryBlock` (`nodes/query-block.ts`): с начала строки до
// ПЕРВОГО `}}`, переносы внутри допустимы. Без `}}` — текст: иначе опечатка съела бы хвост тела.
const QUERY_OPEN = '{{query:';
const QUERY_CLOSE = '}}';
// Хвост строки после `}}` из одних пробелов уходит в узел вместе с переносом: узлы обвязки и
// маркеры тоже забирают свою строку целиком, и тексту не остаётся пустых огрызков `\n`.
const LINE_TAIL_RE = /[ \t]*(?:\r?\n|\r?$)/y;

// Забор кода CommonMark: ``` или ~~~ длиной от трёх, отступ не больше трёх пробелов. У ```-забора
// в строке сведений не бывает обратной кавычки — такая строка открывает инлайн-код, не забор.
// Закрывает забор тот же символ не короче открытия, без строки сведений.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

type ContainerKind = 'columns' | 'tabs';
type PartKind = 'column' | 'tab';
type MarkerName = ContainerKind | PartKind;

const PART_OF: Record<ContainerKind, PartKind> = { columns: 'column', tabs: 'tab' };

/** Лексема препрохода: позиции — полуинтервал исходника, чтобы любой `raw` резался дословно. */
type Item =
  | { t: 'text'; start: number; end: number }
  | {
      t: 'node';
      node: Extract<PageNode, { kind: 'query' | 'record' | 'card' }>;
      start: number;
      end: number;
    }
  | { t: 'open'; name: MarkerName; label: string; start: number; end: number }
  | { t: 'close'; name: MarkerName; start: number; end: number };

type Fence = { ch: string; len: number };

function fenceOpen(line: string): Fence | null {
  const m = FENCE_OPEN_RE.exec(line);
  if (!m) return null;
  const run = m[1] as string;
  const ch = run[0] as string;
  if (ch === '`' && (m[2] ?? '').includes('`')) return null;
  return { ch, len: run.length };
}

function fenceCloses(line: string, fence: Fence): boolean {
  const m = FENCE_CLOSE_RE.exec(line);
  if (!m) return false;
  const run = m[1] as string;
  return run[0] === fence.ch && run.length >= fence.len;
}

/** Строка, как её видят регэкспы: без `\n` и без хвостового `\r`. */
function lineBody(src: string, start: number, nl: number): string {
  const end = nl === -1 ? src.length : nl;
  const body = src.slice(start, end);
  return body.endsWith('\r') ? body.slice(0, -1) : body;
}

function lineMarker(body: string, start: number, end: number): Item | null {
  const c = CONTAINER_MARKER_RE.exec(body);
  if (c) {
    const name = c[2] as MarkerName;
    return c[1] === '/'
      ? { t: 'close', name, start, end }
      : { t: 'open', name, label: '', start, end };
  }
  const tab = TAB_LABEL_RE.exec(body);
  if (tab) return { t: 'open', name: 'tab', label: (tab[1] as string).trim(), start, end };
  return null;
}

function lineAtom(src: string, body: string, start: number, end: number): Item | null {
  const raw = src.slice(start, end);
  const rec = RECORD_BLOCK_RE.exec(body);
  if (rec)
    return {
      t: 'node',
      node: { kind: 'record', name: rec[1] as RecordBlockName, raw },
      start,
      end,
    };
  const card = CARD_RE.exec(body);
  if (card)
    return {
      t: 'node',
      node: { kind: 'card', aspect: (card[1] as string).trim(), raw },
      start,
      end,
    };
  return null;
}

/** Плоский поток лексем: забор кода гасит всё, смежный текст склеен в одну лексему. */
function lex(src: string): Item[] {
  const items: Item[] = [];
  const pushText = (start: number, end: number) => {
    if (end <= start) return;
    const last = items[items.length - 1];
    if (last?.t === 'text' && last.end === start) last.end = end;
    else items.push({ t: 'text', start, end });
  };
  let fence: Fence | null = null;
  // Ближайшее `}}` запоминается: позиция строки только растёт, и первое `}}` после неё не левее
  // найденного раньше. Без памяти тело из N строк `{{query:` без `}}` искало бы до конца N раз —
  // квадратично.
  let closeFrom = -1;
  let closeAt = -1;
  let pos = 0;
  while (pos < src.length) {
    const nl = src.indexOf('\n', pos);
    const end = nl === -1 ? src.length : nl + 1;
    const body = lineBody(src, pos, nl);

    if (fence) {
      if (fenceCloses(body, fence)) fence = null;
      pushText(pos, end);
      pos = end;
      continue;
    }
    const opened = fenceOpen(body);
    if (opened) {
      fence = opened;
      pushText(pos, end);
      pos = end;
      continue;
    }

    if (body.startsWith(QUERY_OPEN)) {
      const from = pos + QUERY_OPEN.length;
      if (closeFrom === -1 || (closeAt !== -1 && closeAt < from)) {
        closeAt = src.indexOf(QUERY_CLOSE, from);
        closeFrom = from;
      }
      const close = closeAt;
      if (close !== -1) {
        let qEnd = close + QUERY_CLOSE.length;
        LINE_TAIL_RE.lastIndex = qEnd;
        if (LINE_TAIL_RE.test(src)) qEnd = LINE_TAIL_RE.lastIndex;
        items.push({
          t: 'node',
          node: {
            kind: 'query',
            text: src.slice(pos + QUERY_OPEN.length, close),
            raw: src.slice(pos, qEnd),
          },
          start: pos,
          end: qEnd,
        });
        // Блок закрылся посреди строки — остаток строки текст: маркер и блок стоят с начала
        // строки, и вторая обёртка на той же строке блоком не считается (как у `bodySegments`).
        if (qEnd < src.length && src[qEnd - 1] !== '\n') {
          const restNl = src.indexOf('\n', qEnd);
          const restEnd = restNl === -1 ? src.length : restNl + 1;
          pushText(qEnd, restEnd);
          qEnd = restEnd;
        }
        pos = qEnd;
        continue;
      }
    }

    const item = lineMarker(body, pos, end) ?? lineAtom(src, body, pos, end);
    if (item) items.push(item);
    else pushText(pos, end);
    pos = end;
  }
  return items;
}

const broken = (code: GrammarErrorCode, raw: string): PageNode => ({
  kind: 'broken',
  code,
  message: GRAMMAR_ERROR_MESSAGES[code],
  raw,
});

function appendText(list: PageNode[], text: string) {
  const last = list[list.length - 1];
  if (last?.kind === 'text') last.text += text;
  else list.push({ kind: 'text', text });
}

const isBlank = (s: string) => /^[ \t\r\n]*$/.test(s);

type Part = { label: string; children: PageNode[] };
type Frame = { kind: ContainerKind; start: number; parts: Part[]; part: Part | null };

/**
 * Где кончается сломанный внешний контейнер: на парном ему закрытии, найденном счётом
 * одноимённых маркеров, а без пары — в конце тела. Счёт идёт по лексемам, то есть уже без
 * маркеров из заборов кода. До места ошибки разбор принимал одноимённые открытия и закрытия
 * строго парно, поэтому парное закрытие не может оказаться раньше ошибки и уже выданный текст
 * не повторится.
 */
function brokenExtent(
  items: Item[],
  i0: number,
  textLength: number,
): { end: number; next: number } {
  const name = (items[i0] as { name: MarkerName }).name;
  let depth = 0;
  for (let j = i0; j < items.length; j++) {
    const it = items[j] as Item;
    if ((it.t === 'open' || it.t === 'close') && it.name === name) {
      depth += it.t === 'open' ? 1 : -1;
      if (depth === 0) return { end: it.end, next: j + 1 };
    }
  }
  return { end: textLength, next: items.length };
}

/**
 * Разбор контейнера верхнего уровня стеком. Первая же ошибка на любой глубине превращает в
 * `broken` ВЕСЬ внешний контейнер (§5.8): частичное дерево с дырой показало бы раскладку, которой
 * автор не писал, а дословный `raw` сохраняет всё написанное для правки.
 */
function parseContainer(src: string, items: Item[], i0: number): { node: PageNode; next: number } {
  const first = items[i0] as Extract<Item, { t: 'open' }>;
  const stack: Frame[] = [
    { kind: first.name as ContainerKind, start: first.start, parts: [], part: null },
  ];
  const fail = (code: GrammarErrorCode) => {
    const { end, next } = brokenExtent(items, i0, src.length);
    return { node: broken(code, src.slice(first.start, end)), next };
  };

  for (let i = i0 + 1; i < items.length; i++) {
    const it = items[i] as Item;
    const top = stack[stack.length - 1] as Frame;

    if (it.t === 'text' || it.t === 'node') {
      if (top.part) {
        if (it.t === 'text') appendText(top.part.children, src.slice(it.start, it.end));
        else top.part.children.push(it.node);
        continue;
      }
      // Пустые строки между частями законны: канон печатает блоки через пустую строку.
      if (it.t === 'text' && isBlank(src.slice(it.start, it.end))) continue;
      return fail('TEXT_OUTSIDE_PART');
    }

    if (it.t === 'open') {
      if (it.name === 'columns' || it.name === 'tabs') {
        if (!top.part) return fail('TEXT_OUTSIDE_PART');
        if (stack.length >= CONTAINER_LIMITS.depth) return fail('DEPTH_EXCEEDED');
        stack.push({ kind: it.name, start: it.start, parts: [], part: null });
        continue;
      }
      const own = PART_OF[top.kind];
      // Одноимённая часть при открытой части — забытое закрытие предыдущей; чужая часть —
      // колонка без `{{columns}}` или вкладка без `{{tabs}}` над ней.
      if (top.part) return fail(it.name === own ? 'PART_UNCLOSED' : 'PART_OUTSIDE_CONTAINER');
      if (it.name !== own) return fail('PART_OUTSIDE_CONTAINER');
      top.part = { label: it.label, children: [] };
      continue;
    }

    // Закрытие. Закрывает только самое внутреннее открытое: часть, если она открыта, иначе
    // контейнер. Имя, открытое где-то выше, значит, что самое внутреннее забыли закрыть.
    const innermost: MarkerName = top.part ? PART_OF[top.kind] : top.kind;
    if (it.name !== innermost) {
      const openAbove = stack.some(
        (f) => f.kind === it.name || (f.part !== null && PART_OF[f.kind] === it.name),
      );
      if (!openAbove) return fail('CLOSE_WITHOUT_OPEN');
      return fail(top.part ? 'PART_UNCLOSED' : 'CONTAINER_UNCLOSED');
    }
    if (top.part) {
      top.parts.push(top.part);
      top.part = null;
      continue;
    }
    const lim = CONTAINER_LIMITS[top.kind];
    if (top.parts.length < lim.min || top.parts.length > lim.max) return fail('PART_COUNT');
    const raw = src.slice(top.start, it.end);
    const node: PageNode =
      top.kind === 'columns'
        ? { kind: 'columns', parts: top.parts.map((p) => p.children), raw }
        : { kind: 'tabs', parts: top.parts, raw };
    stack.pop();
    const parent = stack[stack.length - 1];
    if (!parent) return { node, next: i + 1 };
    (parent.part as Part).children.push(node);
  }
  return fail('CONTAINER_UNCLOSED');
}

/**
 * Тело → дерево верхнего уровня. Инвариант: склейка `text` у текстовых узлов и `raw` у прочих
 * воспроизводит вход байт-в-байт — ни одна ошибка не теряет текст (§5.8).
 */
export function parsePageText(text: string): PageNode[] {
  const items = lex(text);
  const out: PageNode[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i] as Item;
    if (it.t === 'text') {
      appendText(out, text.slice(it.start, it.end));
      i++;
    } else if (it.t === 'node') {
      out.push(it.node);
      i++;
    } else if (it.t === 'close') {
      out.push(broken('CLOSE_WITHOUT_OPEN', text.slice(it.start, it.end)));
      i++;
    } else if (it.name === 'column' || it.name === 'tab') {
      // Только строка маркера: искать ей пару значило бы рисковать проглотить законный
      // контейнер ниже, а текст после неё и так остаётся текстом.
      out.push(broken('PART_OUTSIDE_CONTAINER', text.slice(it.start, it.end)));
      i++;
    } else {
      const { node, next } = parseContainer(text, items, i);
      out.push(node);
      i = next;
    }
  }
  return out;
}
