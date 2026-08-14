import type { JSONContent } from '@tiptap/core';
import { marked } from 'marked';
import { OrbisMarkdownManager } from './manager';
import { BODY_REF_RE } from './nodes/entity-ref';
import { QUERY_BLOCK_CLOSE } from './nodes/query-block';
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
  // list_item — обязателен: элементы списка лежат в items и несут собственные tokens, и без
  // него КАЖДЫЙ список, включая чеклисты, уходил в raw целиком (проверено пробой).
  'list_item',
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
  // checkbox — маркер `[ ]`/`[x]` внутри list_item; его разбирает TaskItem. Без него чеклист
  // уезжал в raw, а приёмка «канон равен входу» это не ловила: raw отдаёт вход дословно.
  'checkbox',
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
  if (!cells.every((cell) => walk(cell.tokens))) return false;
  return walk(token.tokens ?? token.items);
}

function rawNode(markdown: string): JSONContent {
  return { type: 'rawBlock', attrs: { markdown } };
}

function rawDoc(markdown: string): BodyDoc {
  return { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [rawNode(markdown)] } };
}

/** Полная обёртка смарт-листа. Сегменты вырезаются ДО прогона marked: лексер не знает нашу
 *  грамматику и порезал бы многострочный блок по своим правилам. Тот же принцип «start только
 *  по полному совпадению», что спас спайк от разрезанных абзацев. */
const QUERY_SEGMENT_RE = /\{\{query:[\s\S]*?\}\}/g;
const QUERY_OPEN = '{{query:';

export function parseBody(markdown: string): BodyDoc {
  if (markdown.trim() === '') {
    return { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [] } };
  }
  try {
    const content: JSONContent[] = [];
    // 1. Разрезаем на чередование [markdown-кусок | {{query:…}}-сегмент].
    const segments: Array<{ kind: 'md' | 'query'; text: string }> = [];
    let last = 0;
    for (const m of markdown.matchAll(QUERY_SEGMENT_RE)) {
      if (m.index > last) segments.push({ kind: 'md', text: markdown.slice(last, m.index) });
      segments.push({ kind: 'query', text: m[0] });
      last = m.index + m[0].length;
    }
    if (last < markdown.length) segments.push({ kind: 'md', text: markdown.slice(last) });

    for (const seg of segments) {
      if (seg.kind === 'query') {
        // Дословный атрибут (Р4): содержимое между обёрткой, байт-в-байт.
        content.push({
          type: 'queryBlock',
          attrs: { query: seg.text.slice(QUERY_OPEN.length, -QUERY_BLOCK_CLOSE.length) },
        });
        continue;
      }
      const trimmed = seg.text.replace(/^\n+|\n+$/g, '');
      if (trimmed === '') continue;
      // 2. Внутри markdown-куска — поблочно по токенам собственного лексера.
      const lexer = new marked.Lexer({ gfm: true });
      const tokens = lexer.lex(trimmed) as unknown as Tok[];
      if (Object.keys(lexer.tokens.links ?? {}).length > 0) {
        // Reference-определения marked складывает в lexer.tokens.links, и восстановить их
        // форму нечем — консервативно ВЕСЬ исходник дословно (ловит и сноски GFM из спайка).
        return rawDoc(markdown);
      }
      for (const token of tokens) {
        if (token.type === 'space') continue;
        if (blockIsKnown(token)) {
          const parsed = md().parse(token.raw.replace(/\n+$/, ''));
          content.push(...(parsed.content ?? []));
        } else {
          content.push(rawNode(token.raw.replace(/\n+$/, '')));
        }
      }
    }
    return { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content } };
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
