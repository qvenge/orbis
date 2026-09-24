import { Node } from '@tiptap/core';
import { RECORD_BLOCK_NAMES } from '../page-grammar';

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

const KNOWN_NAMES: ReadonlySet<string> = new Set(RECORD_BLOCK_NAMES);

/**
 * `name` — одно из `RECORD_BLOCK_NAMES` (`page-grammar.ts`, единственная копия списка). Разбор
 * markdown узла с чужим именем не родит: препроход узнаёт только имена списка. Чужое имя, `null`
 * или `''` бывают лишь в документе КЛИЕНТА, и два рубежа их не пропускают:
 *  - вставка HTML — `getAttrs` ниже отвергает имя вне списка (узел не создаётся);
 *  - JSON-документ на записи — страховка сверяет скелет документа с разбором его печати
 *    (`projectionKeepsEverything`): `{{foo}}` при повторном разборе — текст, `null` печатается
 *    пустой строкой, и такой документ уходит в `rawBlock` с текстом целиком.
 * Печать поэтому имени не сверяет: чужое имя даёт строку, которую разбор оставит текстом.
 */
export const RecordBlock = Node.create({
  name: 'recordBlock',
  group: 'block',
  atom: true,
  addAttributes: () => ({ name: { default: null } }),
  parseHTML: () => [
    {
      tag: 'div[data-record-block]',
      getAttrs: (el: HTMLElement) => {
        const name = el.getAttribute('data-record-block');
        return name !== null && KNOWN_NAMES.has(name) ? { name } : false;
      },
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
