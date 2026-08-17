import { Node } from '@tiptap/core';

/**
 * Текст, который схема не смогла разобрать без потерь, — сохраняется ДОСЛОВНО.
 *
 * Своего парсера у ноды нет и быть не может: чтобы поймать «непонятое», надо заранее знать,
 * чего именно мы не знаем. Её создаёт токен-детекция в parseBody — см. там же.
 */
export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  addAttributes: () => ({ markdown: { default: '' } }),
  // HTML-путь содержимое не восстанавливает — этот блок живёт только в JSON-документе.
  parseHTML: () => [],
  renderHTML: ({ HTMLAttributes }) => ['pre', { 'data-raw': '' }, HTMLAttributes.markdown],
  renderMarkdown: (node: { attrs?: { markdown?: string } }) => node.attrs?.markdown ?? '',
});
