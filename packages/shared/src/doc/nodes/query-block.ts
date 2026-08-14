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
    // Индекс ТОЛЬКО у полной обёртки И ТОЛЬКО в начале строки. Два разных рубежа:
    //  - полная обёртка: поиск подстроки `{{query:` резал бы абзац пополам на первой же
    //    опечатке, а хвост записи уезжал в отдельный узел (поймано спайком);
    //  - начало строки: смарт-лист — БЛОК, и `{{query:…}}` посреди строки прозы блоком не
    //    является. Без этого условия marked обрезал абзац по этому индексу, и запись
    //    «смотри `{{query: a=b}}` тут» разваливалась на три блока (найдено ревью).
    //
    // Якорь ТОЛЬКО `\n`, без `^`: marked ищет место разреза абзаца в `src.slice(1)` (первый
    // символ он уже попробовал сам), поэтому `^` здесь значит «второй символ блока», а не
    // «начало строки» — и `x{{query:…}}` разваливалось на абзац «x» и блок (проба, Задача 7).
    // Обёртку в самом начале блока разбирает не этот поиск, а сам tokenize.
    start: (src: string) => {
      const m = /\n\{\{query:[\s\S]*?\}\}/.exec(src);
      return m ? m.index + 1 : -1;
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
