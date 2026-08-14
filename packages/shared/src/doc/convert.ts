import type { JSONContent } from '@tiptap/core';
import { OrbisMarkdownManager } from './manager';
import { BODY_REF_RE } from './nodes/entity-ref';
import { DOC_EXTENSIONS } from './schema';
import { type BodyDoc, DOC_SCHEMA_VERSION } from './types';

// Менеджер тяжёлый в конструировании и не хранит состояния между вызовами — создаётся один раз.
// Проверено спайком: работает на Bun без DOM.
let manager: OrbisMarkdownManager | null = null;
function md(): OrbisMarkdownManager {
  manager ??= new OrbisMarkdownManager({ extensions: DOC_EXTENSIONS });
  return manager;
}

function docOf(input: BodyDoc | JSONContent): JSONContent {
  return 'doc' in input && 'v' in input ? (input as BodyDoc).doc : (input as JSONContent);
}

export function serializeBody(input: BodyDoc | JSONContent): string {
  return md().serialize(docOf(input));
}

/**
 * «Непонятое» определяется НЕ сравнением строк, а по токенам marked (вердикт Б1, мера 3):
 * блочный или инлайн-токен, для которого в схеме нет обработчика, уводит В RAW ТОЛЬКО СВОЙ
 * БЛОК. Сравнение строк на этой роли проверяло каноничность, выдавая себя за проверку
 * целостности, — и валило в raw 47% живых тел (ревью Б1).
 */
const KNOWN_BLOCK = new Set([
  'paragraph',
  'heading',
  'list',
  // Свои токены: лексер менеджера отдаёт их наравне со штатными, и не будь их здесь, каждый
  // смарт-лист и каждая запись со ссылкой уезжали бы в raw.
  'queryBlock',
  // list_item — обязателен: элементы списка лежат в items и несут собственные tokens, и без
  // него КАЖДЫЙ список уходил в raw целиком (проверено пробой).
  'list_item',
  // Чеклист у лексера менеджера — СВОИ типы (их даёт markdown-спека @tiptap/extension-list),
  // а не list/list_item с токеном checkbox, как у голого marked. Без них чеклист уезжал в raw,
  // и приёмка «канон равен входу» это не ловила: raw отдаёт вход дословно.
  'taskList',
  'taskItem',
  'blockquote',
  'code',
  'table',
  'hr',
  'space',
  'text',
]);
const KNOWN_INLINE = new Set([
  'text',
  'em',
  'strong',
  'del',
  'codespan',
  'link',
  'br',
  'escape',
  'entityRef', // свой инлайн-токен, см. queryBlock выше
]);

type Cell = { tokens?: Tok[] };
type Tok = {
  type: string;
  raw: string;
  tokens?: Tok[];
  items?: Tok[];
  header?: Cell[];
  rows?: Cell[][];
};

function blockIsKnown(token: Tok): boolean {
  if (!KNOWN_BLOCK.has(token.type)) return false;
  const walk = (toks: Tok[] | undefined): boolean =>
    (toks ?? []).every((t) => {
      if (t.items) return walk(t.items); // list → items → вложенные блоки
      if (t.tokens) return (KNOWN_BLOCK.has(t.type) || KNOWN_INLINE.has(t.type)) && walk(t.tokens);
      return KNOWN_INLINE.has(t.type) || KNOWN_BLOCK.has(t.type);
    });
  // Ячейки таблицы GFM лежат не в tokens/items, а в header/rows. Без их обхода таблица всегда
  // считалась «понятой», и картинка в ячейке молча пропадала при сериализации (проверено).
  const cells = [...(token.header ?? []), ...(token.rows ?? []).flat()];
  const cellIsKnown = (cell: Cell): boolean =>
    // Черта внутри ячейки — граница столбца, и обратно её сериализатор таблицы не экранирует:
    // `x \| y` при повторном разборе разваливается на две ячейки. Это единственное найденное
    // нарушение инварианта канона, и лечится оно так же, как картинка, — уходом в raw.
    !(cell.tokens ?? []).some((t) => t.raw.includes('|')) && walk(cell.tokens);
  if (!cells.every(cellIsKnown)) return false;
  return walk(token.tokens ?? token.items);
}

function rawNode(markdown: string): JSONContent {
  return { type: 'rawBlock', attrs: { markdown } };
}

function rawDoc(markdown: string): BodyDoc {
  return { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [rawNode(markdown)] } };
}

/**
 * Пустое тело — это НЕ пустой документ: топ-узел схемы объявлен `block+`, и `content: []`
 * ProseMirror отвергает («Invalid content for node doc»). У каждой только что созданной
 * сущности body пуст, так что это самый частый случай, а не краевой. Пустой абзац сериализуется
 * в пустую строку, поэтому инвариант `body === serializeBody(body_doc)` цел (проверено).
 */
function emptyDoc(): BodyDoc {
  return { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [{ type: 'paragraph' }] } };
}

/**
 * Лексер берётся У МЕНЕДЖЕРА, а не собирается из голого `marked`: только в его экземпляре
 * зарегистрированы наши токенайзеры (`queryBlock`, `entityRef`). Из этого следует главное —
 * заборы кода и инлайн-код лексер разбирает РАНЬШЕ нашей грамматики, поэтому показанный в коде
 * пример `{{query:…}}` остаётся текстом. Прежний путь (вырезание сегментов регэкспом по сырому
 * тексту до лексера) про заборы не знал и рвал их пополам — найдено ревью.
 */
function lex(markdown: string): { tokens: Tok[]; hasRefDefs: boolean } {
  const instance = md().instance;
  const lexer = new instance.Lexer(instance.defaults);
  const tokens = lexer.lex(markdown) as unknown as Tok[];
  return { tokens, hasRefDefs: Object.keys(lexer.tokens.links ?? {}).length > 0 };
}

export function parseBody(markdown: string): BodyDoc {
  if (markdown.trim() === '') return emptyDoc();
  try {
    const { tokens, hasRefDefs } = lex(markdown);
    if (hasRefDefs) {
      // Reference-определения marked складывает в lexer.tokens.links, и восстановить их форму
      // нечем — консервативно ВЕСЬ исходник дословно (ловит и сноски GFM из спайка).
      return rawDoc(markdown);
    }
    const content: JSONContent[] = [];
    for (const token of tokens) {
      if (token.type === 'space') continue;
      const raw = token.raw.replace(/\n+$/, '');
      if (blockIsKnown(token)) {
        content.push(...(md().parse(raw).content ?? []));
      } else {
        content.push(rawNode(raw));
      }
    }
    return content.length > 0
      ? { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content } }
      : emptyDoc();
  } catch {
    // Парсер не справился вовсе — сохраняем дословно, не теряя ни байта.
    return rawDoc(markdown);
  }
}

/** Единственная форма, которой сервер пишет тело: body = КАНОН, не «как написала модель». */
export function canonicalizeBody(markdown: string): { doc: BodyDoc; body: string } {
  const doc = parseBody(markdown);
  return { doc, body: serializeBody(doc) };
}

/** Дерево ∪ регэксп по raw-блокам: backlinks не зависят от разбираемости тела (Б2).
 *  Код-блоки и inline-код — по-прежнему НЕ связь (Р7): они не raw, а честные ноды схемы. */
export function bodyRefsFromDoc(input: BodyDoc | JSONContent): string[] {
  const refs = new Set<string>();
  const walk = (node: JSONContent | undefined): void => {
    if (!node) return;
    if (node.type === 'entityRef' && typeof node.attrs?.entityId === 'string') {
      refs.add(node.attrs.entityId.toLowerCase());
    }
    if (node.type === 'rawBlock' && typeof node.attrs?.markdown === 'string') {
      for (const m of node.attrs.markdown.matchAll(BODY_REF_RE)) {
        if (m[1]) refs.add(m[1].toLowerCase());
      }
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(docOf(input));
  return [...refs];
}

/**
 * Правило разрешения (Р1): что считать документом.
 *  1. форма верна и версия знакома → он;
 *  2. иначе (версия из будущего после отката релиза, битая форма, NULL) → пересборка из `body`.
 * Худший исход — потеря блочных id и части оформления, но НЕ текста.
 */
export function readBodyDoc(stored: unknown, fallbackMarkdown: string): BodyDoc {
  if (
    typeof stored === 'object' &&
    stored !== null &&
    'v' in stored &&
    'doc' in stored &&
    (stored as BodyDoc).v === DOC_SCHEMA_VERSION
  ) {
    return stored as BodyDoc;
  }
  return parseBody(fallbackMarkdown);
}
