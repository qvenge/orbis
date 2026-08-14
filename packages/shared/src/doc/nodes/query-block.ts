import { type MarkdownToken, Node } from '@tiptap/core';

/** Закрывающая половина обёртки — отдельной строкой: её длину меряет проверка рубежа ниже. */
export const QUERY_BLOCK_CLOSE = '}}';

/**
 * Смарт-лист `{{query:…}}`. Атрибут `query` хранит содержимое ДОСЛОВНО — с переносами строк и
 * девятипробельными отступами continuation-строк: сидированные тела (§3.3 PRD) сверяются с
 * документом байт-в-байт живым тестом, и тримленный атрибут схлопнул бы их при первом же
 * сохранении.
 */
export const QueryBlock = Node.create({
  name: 'queryBlock',
  group: 'block',
  atom: true,
  addAttributes: () => ({ query: { default: '' } }),
  parseHTML: () => [{ tag: 'div[data-query]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-query': HTMLAttributes.query }],
  markdownTokenizer: {
    name: 'queryBlock',
    level: 'block',
    // Индекс ТОЛЬКО у полной обёртки. Поиск подстроки `{{query:` резал бы абзац пополам на
    // первой же опечатке, а хвост записи уезжал в отдельный узел (поймано спайком).
    start: (src: string) => {
      const m = /\{\{query:[\s\S]*?\}\}/.exec(src);
      return m ? m.index : -1;
    },
    tokenize: (src: string) => {
      const m = /^\{\{query:([\s\S]*?)\}\}/.exec(src);
      if (!m) return undefined;
      return { type: 'queryBlock', raw: m[0], query: m[1] ?? '' } as never;
    },
  },
  // Тип токена — MarkdownToken по той же причине, что в entity-ref.ts.
  parseMarkdown: (token: MarkdownToken) => ({
    type: 'queryBlock',
    attrs: { query: typeof token.query === 'string' ? token.query : '' },
  }),
  // БЕЗ хвостовых переносов: разделитель между блоками ставит сериализатор, и свой `\n\n`
  // давал двойной (поймано спайком).
  renderMarkdown: (node: { attrs?: { query?: string } }) =>
    `{{query:${node.attrs?.query ?? ''}${QUERY_BLOCK_CLOSE}`,
});
