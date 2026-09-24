import { Node } from '@tiptap/core';

/**
 * Блоки обвязки записи тела v3 (спека страниц 1а §5.3): `{{title}}`, `{{tags}}`, … и карточка
 * аспекта `{{card: …}}`. Оба — атомы: показывают запись `this`, своего текста у них нет.
 *
 * Разбора markdown у нод нет: маркеры распознаёт только листовой препроход `page-grammar.ts`
 * (одна копия правил, РП-6), узлы собирает `parseBody`.
 *
 * Печать атома обязана совпадать с его строкой в `collectText` диффа (`doc/diff.ts`): тот же
 * текст читает страховка записи `projectionKeepsEverything`, и расхождение увело бы тело в raw.
 * Импортировать печать отсюда дифф не может — он листовой по закону, — поэтому равенство
 * сторожит тест (`convert.test.ts`, «печатная форма атомов»).
 */

/**
 * `name` — одно из `RECORD_BLOCK_NAMES` (`page-grammar.ts`). Умолчание `null` — не «блок по
 * умолчанию», а честное «имени нет»: такой узел (его мог прислать только клиент) печатается
 * пустой строкой — выдуманное имя поменяло бы смысл тела при повторном разборе. Имя печатается
 * без сверки со списком: чужое имя даёт строку, которую разбор оставит текстом, то есть текст
 * цел, а сверка потребовала бы второй копии списка в листовом диффе.
 */
export const RecordBlock = Node.create({
  name: 'recordBlock',
  group: 'block',
  atom: true,
  addAttributes: () => ({ name: { default: null } }),
  parseHTML: () => [
    {
      tag: 'div[data-record-block]',
      getAttrs: (el: HTMLElement) => ({ name: el.getAttribute('data-record-block') }),
    },
  ],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-record-block': HTMLAttributes.name ?? '' }],
  renderMarkdown: (node: { attrs?: { name?: unknown } }) => {
    const name = node.attrs?.name;
    return typeof name === 'string' ? `{{${name}}}` : '';
  },
});

/**
 * Карточка аспекта. Атрибуты — как у `queryBlock` и по той же причине (довод
 * `nodes/query-block.ts`): печать «ключом» требует реестра, а у `renderMarkdown` его нет.
 *
 *  - `aspect` — id аспекта реестра либо `null`, если текст не узнан (опечатка, чужой граф);
 *  - `text` — ключ аспекта при `aspect !== null`, иначе строка как написана (ключ или подпись
 *    в кавычках).
 *
 * Согласованными их ставит только привязка (`bindQueryBlocks`, `doc/bind-query.ts`); разбор
 * markdown реестра не видит и всегда отдаёт `{aspect: null, text}`.
 */
export const AspectCard = Node.create({
  name: 'aspectCard',
  group: 'block',
  atom: true,
  addAttributes: () => ({ aspect: { default: null }, text: { default: '' } }),
  parseHTML: () => [
    {
      tag: 'div[data-aspect-card]',
      getAttrs: (el: HTMLElement) => ({
        text: el.getAttribute('data-aspect-card') ?? '',
        aspect: el.getAttribute('data-aspect'),
      }),
    },
  ],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    {
      'data-aspect-card': HTMLAttributes.text ?? '',
      ...(typeof HTMLAttributes.aspect === 'string'
        ? { 'data-aspect': HTMLAttributes.aspect }
        : {}),
    },
  ],
  renderMarkdown: (node: { attrs?: { text?: unknown } }) =>
    `{{card: ${typeof node.attrs?.text === 'string' ? node.attrs.text : ''}}}`,
});
