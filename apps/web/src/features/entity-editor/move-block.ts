import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, Selection } from '@tiptap/pm/state';

/** Блок, к которому относится жест: его позиция и он сам. */
export type BlockTarget = { from: number; node: ProseMirrorNode };

/**
 * Что считать «блоком под выделением» — общее правило для перемещения и для «Удалить блок»:
 * два соседних жеста обязаны означать одно и то же.
 *
 * Три случая, и все три встречаются мышью:
 * 1. NodeSelection на БЛОЧНОМ узле (клик по смарт-листу, по raw-блоку, по горизонтальной
 *    черте) — целью служит сам узел. У такого выделения `$from.depth === 0`, и `$from.node(1)`
 *    там `undefined`: код планов v1/v2 обращался к нему напрямую и падал TypeError прямо в
 *    горячей клавише — то есть ровно на тех блоках, у которых иного способа переставить или
 *    убрать себя нет вовсе (пробы ревью И9/И10).
 * 2. Каретка или выделение внутри текста — цель — предок ВЕРХНЕГО уровня. Не `$from.parent`:
 *    внутри пункта списка или цитаты это внутренний параграф, и удаление оставляло бы пустой
 *    каркас, а перемещение вырывало бы абзац из пункта. Следствие зафиксировано как
 *    поведение: каретка во вложенном списке двигает и удаляет ВЕСЬ список.
 * 3. Всё остальное — `null`. Это AllSelection (Cmd+A): блока «под кареткой» у него нет,
 *    `$from.depth === 0`, и путь достижим мышью — на выделении всего документа bubble-панель
 *    показывается, потому что выделение непустое.
 *
 * NodeSelection на INLINE-узле (чип сущности) сюда попадает вторым случаем и даёт содержащий
 * его блок — это и требуется: чип не блок, двигать и удалять поштучно его нечего.
 */
export function blockTarget(selection: Selection): BlockTarget | null {
  if (selection instanceof NodeSelection && selection.node.isBlock) {
    return { from: selection.from, node: selection.node };
  }
  if (selection.$from.depth >= 1) {
    return { from: selection.$from.before(1), node: selection.$from.node(1) };
  }
  return null;
}

/**
 * Перемещение блока с клавиатуры — замена перетаскиванию мышью.
 *
 * Перетаскивания в этой работе нет намеренно: расширение drag handle тянет
 * `extension-collaboration` + `y-tiptap` + `yjs` — около 25 кБ gzip из своих 40 — ради
 * инфраструктуры соредактирования, которую работа сознательно не строит (Р13 дизайна). Жест
 * Alt+↑/↓ знаком по редакторам кода, работает с внешней клавиатурой на планшете и весит ноль:
 * это команды самого ProseMirror. Перетаскивание вернётся вместе с CRDT, когда yjs будет в
 * бандле по любому и handle подешевеет втрое.
 *
 * Известная граница (принята, обхода не изобретаем): на macOS Alt+↑/↓ спорит с системной
 * навигацией по абзацам. Жест работает при фокусе в редакторе — обработчик возвращает `true`
 * и на краях документа тоже, поэтому клавиша не проваливается наружу и каретка не прыгает.
 */
export const MoveBlock = Extension.create({
  name: 'moveBlock',
  addKeyboardShortcuts() {
    const move = (dir: -1 | 1) => (): boolean => {
      const { state, view } = this.editor;
      const target = blockTarget(state.selection);
      if (target === null) return true;
      const { from, node } = target;
      // Соседей считаем у РОДИТЕЛЯ целевого блока, а не у документа всегда. Для каретки это
      // одно и то же (цель — блок верхнего уровня), но NodeSelection может стоять и на
      // вложенном узле, и тогда индекс по документу означал бы совсем другой узел: жест дал
      // бы ложный отказ на границе (у документа детей меньше, чем у списка) и вставку по
      // чужому адресу.
      const $at = state.doc.resolve(from);
      const parent = $at.parent;
      const index = $at.index();
      const swapWith = index + dir;
      // Край — не ошибка: просто ничего не делаем, чтобы жест не прыгал с конца в начало.
      if (swapWith < 0 || swapWith >= parent.childCount) return true;
      const neighbor = parent.child(swapWith);
      // Сосед после удаления блока стоит вплотную к `from` (вниз) либо не двигается вовсе
      // (вверх) — в обоих случаях `insertAt` и есть новое начало перемещаемого блока.
      const insertAt = dir === 1 ? from + neighbor.nodeSize : from - neighbor.nodeSize;
      const tr = state.tr.delete(from, from + node.nodeSize);
      tr.insert(insertAt, node);
      // Выделение едет ВМЕСТЕ с блоком. Без этого оно остаётся на прежней позиции — то есть
      // внутри соседа, занявшего место блока, — и второе нажатие двигает уже СОСЕДА: замерено
      // пробой, «один два три» ходило туда-обратно между двумя состояниями, а выделенный
      // смарт-лист терял выделение с первого же нажатия. Смещение считается от старого
      // положения каретки и зажимается в границы блока: выделение могло начинаться в этом
      // блоке, а кончаться в следующем, который никуда не уехал.
      const caret = Math.min(
        Math.max(state.selection.from + (insertAt - from), insertAt),
        insertAt + node.nodeSize - 1,
      );
      // `Selection.near`, а не TextSelection: у атомарного блока (смарт-лист) внутри нет
      // текстовой позиции вовсе, и near сам вернёт на нём NodeSelection — то же выделение,
      // с которого жест начался.
      tr.setSelection(Selection.near(tr.doc.resolve(caret)));
      view.dispatch(tr.scrollIntoView());
      return true;
    };
    return { 'Alt-ArrowUp': move(-1), 'Alt-ArrowDown': move(1) };
  },
});
