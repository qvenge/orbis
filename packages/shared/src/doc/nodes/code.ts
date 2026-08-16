import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core';
import { Code } from '@tiptap/extension-code';

/** Имя служебного атрибута марки, через который сериализатору передаётся готовая обёртка. */
export const CODE_FENCE_ATTR = 'orbisFence';

/**
 * Обёртка кодовой вставки ПО СОДЕРЖИМОМУ — та же болезнь, что была у ограды блока кода, но в
 * инлайн-марке (`@tiptap/extension-code/dist/index.js:55`: разделитель всегда ОДНА кавычка).
 *
 * Замерено на исходном коде (ре-ревью, Б2) — это БЕЗВОЗВРАТНАЯ потеря символов, а не оформления:
 *
 *   "`` ` ``"             → канон1 "```"              → канон2 "```\n\n```"
 *                           кавычка ИСЧЕЗЛА, вставка стала пустым блоком кода
 *   "``` `` ```"          → канон1 "````"             → канон2 "```\n\n```"
 *   "вот `` a`b `` конец" → канон1 "вот `a`b` конец"  → канон2 "вот `a`b\` конец"
 *
 * Достижимо всеми тремя путями записи: модель пишет так, показывая markdown внутри markdown;
 * в редакторе достаточно нажать «Код» на выделении, содержащем обратную кавычку; бэкфилл
 * перепишет такое тело необратимо.
 *
 * ПОЧЕМУ ЭТО НЕ ЛЕЧИТСЯ «ТЕМ ЖЕ ПРИЁМОМ», ЧТО ОГРАДА. Марки в @tiptap/markdown сериализуются
 * иначе, чем ноды: `getMarkOpening`/`getMarkClosing` (dist/index.js:1347 и 1380) зовут
 * `renderMarkdown` с ПОДСТАВНЫМ содержимым — плейсхолдером — и режут результат по нему на
 * «открывашку» и «закрывашку». То есть рисовальщик марки СВОЕГО ТЕКСТА НЕ ВИДИТ, и вычислить
 * длину разделителя по содержимому прямо в нём невозможно (проверено пробой: наивная замена
 * renderMarkdown ничего не меняла — обёртка так и оставалась в одну кавычку).
 *
 * Единственное, что доезжает от узла до рисовальщика марки, — `mark.attrs` (они кладутся в
 * подставной узел). Поэтому обёртка считается ЗАРАНЕЕ, при обходе документа перед сериализацией
 * (`withCodeFences` ниже), и передаётся служебным атрибутом. Атрибут живёт только в копии,
 * которая уходит в сериализатор: в документ он не попадает и в схеме не объявлен.
 */
function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return '`'.repeat(Math.max(1, longest + 1));
}

/**
 * Готовая обёртка для содержимого: длина по самой длинной серии кавычек плюс подкладка пробелом,
 * когда край — кавычка.
 *
 * Про подкладку. CommonMark срезает по одному пробелу с обоих краёв кодовой вставки, если оба
 * края пробельные и содержимое не из одних пробелов; поэтому край-кавычка без подкладки слипся
 * бы с разделителем. Пробельные края сюда не попадают: сам менеджер выносит ведущие и хвостовые
 * пробелы ЗА пределы марки (dist/index.js:1249 и 1300) ещё до того, как спросит обёртку.
 * Правило выведено разбором и проверено на 32 содержимых.
 */
export function codeFenceFor(content: string): { open: string; close: string } {
  const fence = fenceFor(content);
  const pad = /^`|`$/.test(content.trim()) ? ' ' : '';
  return { open: `${fence}${pad}`, close: `${pad}${fence}` };
}

/**
 * Копия документа, в которой у каждой кодовой вставки в атрибутах марки лежит готовая обёртка.
 * Копируются ТОЛЬКО узлы по пути к таким маркам — вход не мутируется (в БД едет он же).
 */
export function withCodeFences<T extends JSONContent>(node: T): T {
  const marks = node.marks as Array<{ type: string; attrs?: Record<string, unknown> }> | undefined;
  const codeIndex = (marks ?? []).findIndex((m) => m.type === 'code');
  const children = node.content;
  const nextChildren = children?.map((child) => withCodeFences(child));
  const childrenChanged = nextChildren?.some((c, i) => c !== (children as JSONContent[])[i]);
  if (codeIndex < 0 && !childrenChanged) return node;
  const copy: JSONContent = { ...node };
  if (nextChildren !== undefined) copy.content = nextChildren;
  if (codeIndex >= 0 && marks !== undefined) {
    const mark = marks[codeIndex] as { type: string; attrs?: Record<string, unknown> };
    const nextMarks = marks.slice();
    nextMarks[codeIndex] = {
      ...mark,
      attrs: { ...(mark.attrs ?? {}), [CODE_FENCE_ATTR]: codeFenceFor(node.text ?? '') },
    };
    copy.marks = nextMarks;
  }
  return copy as T;
}

/**
 * Расширяется отдельный `Code`, а StarterKit конфигурируется `code: false` (см. schema.ts):
 * менеджер разметки держит обработчики списком на имя и берёт ПЕРВЫЙ, поэтому вторая
 * регистрация поверх StarterKit была бы мертворождённой. Поле `code: true` наследуется
 * расширением — на нём держится `codeTypes` менеджера, то есть запрет экранировать текст
 * внутри вставки (manager.ts).
 *
 * Запасная обёртка в одну кавычку — на случай, когда узел пришёл мимо `withCodeFences`
 * (чужой вызов менеджера): поведение тогда ровно штатное, а не пустое.
 */
export const OrbisCode = Code.extend({
  renderMarkdown: (node: JSONContent, h: MarkdownRendererHelpers) => {
    if (!node.content) return '';
    const carried = node.attrs?.[CODE_FENCE_ATTR] as { open: string; close: string } | undefined;
    const { open, close } = carried ?? { open: '`', close: '`' };
    return `${open}${h.renderChildren(node.content)}${close}`;
  },
});
