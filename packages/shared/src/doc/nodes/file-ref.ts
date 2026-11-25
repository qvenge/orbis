import { Node } from '@tiptap/core';
import { fileIdSchema } from '../../contracts/files';

// Labels are plain author text. Brackets and backslashes quote themselves. Entities for
// pipes and line endings keep the same inline atom inside GFM tables and list items.
const MARKER = /^(\\?)(!?)(\\?)\[((?:\\[\s\S]|[^\\[\]\r\n])*)\]\(orbis-file:([\da-fA-F-]{36})\)/;
function decodeLabel(label: string): string {
  return label.replace(
    /\\([\\[\]])|&(amp|#10|#13|#124);/g,
    (whole, escaped, entity) =>
      escaped ?? { amp: '&', '#10': '\n', '#13': '\r', '#124': '|' }[entity as string] ?? whole,
  );
}
function encodeLabel(label: string): string {
  return label
    .replaceAll('&', '&amp;')
    .replaceAll('|', '&#124;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;')
    .replace(/([\\[\]])/g, '\\$1');
}

export const FileRef = Node.create({
  name: 'fileRef',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({
    fileId: { default: null, parseHTML: (element) => element.getAttribute('data-file-id') },
    display: { default: 'link', parseHTML: (element) => element.getAttribute('data-display') },
    label: { default: '', parseHTML: (element) => element.textContent },
  }),
  parseHTML: () => [{ tag: 'span[data-file-id]' }],
  renderHTML: ({ node }) => [
    'span',
    { 'data-file-id': node.attrs.fileId, 'data-display': node.attrs.display },
    node.attrs.label,
  ],
  markdownTokenizer: {
    name: 'fileRef',
    level: 'inline',
    start: (src) => src.search(/\\?!?\\?\[/),
    tokenize: (src) => {
      const match = MARKER.exec(src);
      if (!match) return undefined;
      const id = fileIdSchema.safeParse(match[5]);
      if (!id.success) return undefined;
      // Either escaped introducer is literal, including the common spelling \\![...].
      if (match[1] || match[3]) {
        return { type: 'escape', raw: match[0], text: match[0].replace('\\', '') };
      }
      return {
        type: 'fileRef',
        raw: match[0],
        fileId: id.data,
        display: match[2] ? 'image' : 'link',
        label: decodeLabel(match[4] ?? ''),
      };
    },
  },
  parseMarkdown: (token) => ({
    type: 'fileRef',
    attrs: { fileId: token.fileId, display: token.display, label: token.label },
  }),
  renderMarkdown: (node) =>
    `${node.attrs?.display === 'image' ? '!' : ''}[${encodeLabel(node.attrs?.label ?? '')}](orbis-file:${node.attrs?.fileId})`,
});
