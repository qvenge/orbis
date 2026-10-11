import { Node } from '@tiptap/core';
import { parsePageText } from '../page-grammar';
import { PAGE_BLOCK_GROUP } from '../placement';

/**
 * Параметр страницы — `{{param: …}}` (спека 1в §5.1): переключатель на месте блока, значение
 * которого блоки данных страницы читают ссылкой `$<имя>`. Атом группы `pageBlock`, как блок хоста
 * 1б: место (верх тела или часть контейнера) держит схема, работает он на странице и в шаблоне
 * (матрица мест, `placement.ts`).
 *
 * Атрибут один — `text`: строка маркера ДОСЛОВНО (без хвостовых пробелов строки). Не разобранное
 * объявление: маркер пишет и человек, и в нём бывает ошибка блока (неверное умолчание, чужой
 * токен) — текст обязан пережить круг «разбор → печать» байт-в-байт, чтобы владелец чинил то, что
 * написал. Объявление читают из текста тем же препроходом (`parsePageText`, одна копия правил).
 * Значение параметра в тело не пишется (§5.1): это состояние экрана, и в документе ему места нет.
 *
 * Разбора markdown у ноды нет: маркер распознаёт только препроход (РП-6), узел собирает `parseBody`.
 * Печать — сам текст; её же строка — в `collectText` диффа (`doc/diff.ts`, равенство сторожит тест
 * «печатная форма атомов», `convert.test.ts`). Текст, который препроход маркером параметра не
 * узнаёт, бывает только в документе клиента, и рубежи те же, что у блока хоста: вставка HTML его не
 * создаёт (`getAttrs`), а печать при повторном разборе — абзац, скелет расходится, и страховка
 * записи уводит документ в `rawBlock` с текстом целиком.
 */

/** Узнаёт ли препроход в тексте ровно один маркер параметра. */
function isParamMarker(text: string): boolean {
  const nodes = parsePageText(text);
  return nodes.length === 1 && nodes[0]?.kind === 'param';
}

export const ParamBlock = Node.create({
  name: 'paramBlock',
  group: PAGE_BLOCK_GROUP,
  atom: true,
  addAttributes: () => ({ text: { default: '' } }),
  parseHTML: () => [
    {
      tag: 'div[data-param-block]',
      getAttrs: (el: HTMLElement) => {
        const text = el.getAttribute('data-param-block');
        return text !== null && isParamMarker(text) ? { text } : false;
      },
    },
  ],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-param-block': HTMLAttributes.text ?? '' }],
  renderMarkdown: (node: { attrs?: { text?: unknown } }) => {
    const text = node.attrs?.text;
    return typeof text === 'string' ? text : '';
  },
});
