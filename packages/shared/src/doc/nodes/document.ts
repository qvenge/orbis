import { type JSONContent, Node } from '@tiptap/core';
import { PAGE_BLOCK_GROUP } from '../placement';

/**
 * Верх документа — копия `Document` @tiptap/extension-document 3.30.1 с одним отличием: `content`
 * пускает группу `pageBlock` (узлы страницы, спека 1б §10). Своя копия, а не `Document.extend`:
 * пакет не зависимость shared, и тянуть его ради строки `content` незачем. StarterKit отключает
 * свой `document` (`schema.ts`).
 */
export const OrbisDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: `(block | ${PAGE_BLOCK_GROUP})+`,
  renderMarkdown: (
    node: JSONContent,
    h: { renderChildren: (n: JSONContent[], s?: string) => string },
  ) => (node.content ? h.renderChildren(node.content, '\n\n') : ''),
});
