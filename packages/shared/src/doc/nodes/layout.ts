import { type JSONContent, Node } from '@tiptap/core';

/**
 * Контейнеры раскладки тела v3 (спека страниц 1а §5.2): колонки и вкладки.
 *
 * Разбора markdown у нод нет и быть не должно: маркеры `{{columns}}`… распознаёт только
 * листовой препроход `page-grammar.ts` (одна копия правил, РП-6), а узлы из его дерева собирает
 * `parseBody`. Здесь — схема и печать.
 *
 * Части (`column`, `tab`) — СВОИ группы схемы, а не `block` (РП-28): часть вне своего контейнера
 * схема отвергает. Иначе документ с колонкой прямо в `doc` проходил бы проверку, печатался бы
 * маркером без пары, и повторный разбор делал бы из него плашку ошибки — документ не пережил бы
 * собственной печати.
 *
 * Пределы (2–4 колонки, 1–8 вкладок, глубина 2) в `content`-выражение НЕ вписаны намеренно: их
 * держит препроход (`CONTAINER_LIMITS`). Нарушение схемы — отказ записи всего тела, а человеку
 * нужна плашка на месте контейнера с его текстом (§5.8).
 *
 * Канон печати закреплён тестом (`convert.test.ts`): маркер — своей строкой; дети части —
 * через пустую строку; между маркером и первым/последним ребёнком пустой строки нет.
 */

type Children = { renderChildren: (nodes: JSONContent[], separator?: string) => string };

/** Дети части — через пустую строку, как блоки верхнего уровня документа. */
const partBody = (node: JSONContent, h: Children): string =>
  h.renderChildren(node.content ?? [], '\n\n');

export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column+',
  parseHTML: () => [{ tag: 'div[data-columns]' }],
  renderHTML: () => ['div', { 'data-columns': '' }, 0],
  renderMarkdown: (node: JSONContent, h: Children) =>
    `{{columns}}\n${h.renderChildren(node.content ?? [], '\n')}\n{{/columns}}`,
});

export const Column = Node.create({
  name: 'column',
  group: 'column',
  content: 'block+',
  parseHTML: () => [{ tag: 'div[data-column]' }],
  renderHTML: () => ['div', { 'data-column': '' }, 0],
  renderMarkdown: (node: JSONContent, h: Children) =>
    `{{column}}\n${partBody(node, h)}\n{{/column}}`,
});

export const Tabs = Node.create({
  name: 'tabs',
  group: 'block',
  content: 'tab+',
  parseHTML: () => [{ tag: 'div[data-tabs]' }],
  renderHTML: () => ['div', { 'data-tabs': '' }, 0],
  renderMarkdown: (node: JSONContent, h: Children) =>
    `{{tabs}}\n${h.renderChildren(node.content ?? [], '\n')}\n{{/tabs}}`,
});

/**
 * Пустая подпись печатается голым `{{tab}}`: препроход читает его как вкладку без подписи, а
 * `{{tab: }}` для него — не маркер, а текст (§5.7), и такая вкладка при повторном разборе
 * развалила бы весь контейнер.
 */
function tabMarker(label: unknown): string {
  const text = typeof label === 'string' ? label.trim() : '';
  return text === '' ? '{{tab}}' : `{{tab: ${text}}}`;
}

export const Tab = Node.create({
  name: 'tab',
  group: 'tab',
  content: 'block+',
  addAttributes: () => ({ label: { default: '' } }),
  parseHTML: () => [
    {
      tag: 'div[data-tab]',
      getAttrs: (el: HTMLElement) => ({ label: el.getAttribute('data-tab') ?? '' }),
    },
  ],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-tab': HTMLAttributes.label ?? '' }, 0],
  renderMarkdown: (node: JSONContent, h: Children) =>
    `${tabMarker(node.attrs?.label)}\n${partBody(node, h)}\n{{/tab}}`,
});
