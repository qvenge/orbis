import { type MarkdownToken, Node } from '@tiptap/core';

/**
 * Форма ссылки — КОПИЯ серверного `BODY_REFS_RE` (executor/normalize.ts): класс символов и
 * регистронезависимость обязаны совпадать, иначе документ и backlinks разъедутся. Разница лишь
 * в том, что здесь это узел дерева, а не находка регэкспа в тексте.
 */
const RE = /^\[\[entity:([0-9a-f-]{36})(?:\|([^\]]*))?\]\]/i;

/**
 * Тот же класс символов, но глобальный и с захватом подписи: им пользуется bodyRefsFromDoc,
 * когда ищет ссылки внутри raw-блоков (Б2). Форма повторяет клиентский ENTITY_REF_RE
 * (Markdown.tsx:16); серверный BODY_REFS_RE держит подпись в незахватывающей группе.
 */
export const BODY_REF_RE = /\[\[entity:([0-9a-f-]{36})(?:\|([^\]]*))?\]\]/gi;

export const EntityRef = Node.create({
  name: 'entityRef',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ entityId: { default: null }, label: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-entity-id]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    { 'data-entity-id': HTMLAttributes.entityId, 'data-label': HTMLAttributes.label },
  ],
  markdownTokenizer: {
    name: 'entityRef',
    level: 'inline',
    start: (src: string) => src.indexOf('[[entity:'),
    tokenize: (src: string) => {
      const m = RE.exec(src);
      if (!m) return undefined;
      return { type: 'entityRef', raw: m[0], entityId: m[1], label: m[2] ?? null } as never;
    },
  },
  // id приводится к lowercase (И7): дерево, resolveRefs и БД говорят на одном регистре, иначе
  // чип с [[entity:0F8FAD…]] навсегда промахивался бы мимо Map заголовков.
  // Тип токена — MarkdownToken, а не структурный литерал: у литерала со всеми полями
  // необязательными TS не находит общих свойств с MarkdownToken и отвергает обработчик.
  parseMarkdown: (token: MarkdownToken) => ({
    type: 'entityRef',
    attrs: {
      entityId: typeof token.entityId === 'string' ? token.entityId.toLowerCase() : null,
      label: typeof token.label === 'string' ? token.label : null,
    },
  }),
  renderMarkdown: (node: { attrs?: { entityId?: string; label?: string | null } }) => {
    const label = node.attrs?.label;
    return `[[entity:${node.attrs?.entityId}${label ? `|${label}` : ''}]]`;
  },
});
