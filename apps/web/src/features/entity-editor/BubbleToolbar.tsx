import type { ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, type Selection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Bold, Code, Italic, Strikethrough, Trash2 } from 'lucide-react';
import { Button } from '../../ui/Button';

/** Диапазон документа — то, что уйдёт под нож. */
type Range = { from: number; to: number };

/**
 * Свой блок позиции: ближайший предок, чей РОДИТЕЛЬ — документ либо список.
 *
 * Правило выбрано по радиусу поражения (решение И1 раунда правок 1). Три соседних варианта
 * ошибочны, и каждый — по-своему:
 * - `$from.parent` (план v1) внутри пункта даёт внутренний параграф: он исчезал, а пустой
 *   буллет оставался на экране;
 * - блок ВЕРХНЕГО уровня (первая редакция задачи) сносил чеклист из двадцати пунктов из-за
 *   каретки в седьмом — потеря данных за иконкой в четырнадцать пикселей и без подтверждения;
 * - «подняться ровно на один уровень» вернуло бы первый случай во вложенном списке.
 *
 * Список опознаётся ГРУППОЙ СХЕМЫ (`list`), а не перечнем имён: `bulletList`, `orderedList` и
 * `taskList` объявляют `group: 'block list'`, причём последний живёт в отдельном пакете
 * (@tiptap/extension-list). Список имён разошёлся бы со схемой на первой же новой ноде, и
 * чеклист вёл бы себя иначе, чем маркированный список, выглядя на экране так же.
 *
 * Родитель на глубине 0 — всегда сам документ, поэтому корень проверяется глубиной, а не
 * именем ноды: имя `doc` в схеме не гвоздём прибито.
 */
function ownBlock($pos: ResolvedPos): Range | null {
  for (let depth = $pos.depth; depth >= 1; depth--) {
    if (depth === 1 || $pos.node(depth - 1).type.isInGroup('list')) {
      return { from: $pos.before(depth), to: $pos.after(depth) };
    }
  }
  // Глубина 0 — AllSelection (Cmd+A): своего блока у такой позиции нет вовсе.
  return null;
}

/**
 * Что уберёт «Удалить блок».
 *
 * Концы диапазона считаются по ОБОИМ краям выделения (решение И3 раунда правок 1). Выделение
 * поперёк двух абзацев ставится мышью тривиально, и прежний код, смотревший только на `$from`,
 * убирал первый абзац, оставляя подсвеченный хвост второго — результат, которого никто не
 * просил. Радиус жеста при этом ограничен ровно тем, что человек видел выделенным: блоки, до
 * которых выделение не дотянулось, не трогаются.
 *
 * ВНИМАНИЕ: правило НЕ то же, что у Alt+↑/↓ (`blockTarget` в move-block.ts — блок верхнего
 * уровня). Расхождение осознанное: перемещение оставлено требованием 4 плана как есть, а
 * согласование гранулярности двух жестов вынесено вопросом к дизайну Задачи 17. Копировать
 * одно правило в другое НЕЛЬЗЯ, пока это решение не пересмотрено.
 */
function rangeToDelete(selection: Selection): Range | null {
  // NodeSelection на блоке (клик по смарт-листу, по raw-блоку, по горизонтальной черте):
  // целью служит сам узел — иного способа его убрать у атома нет.
  if (selection instanceof NodeSelection && selection.node.isBlock) {
    return { from: selection.from, to: selection.from + selection.node.nodeSize };
  }
  const first = ownBlock(selection.$from);
  const last = ownBlock(selection.$to);
  if (first === null || last === null) return null;
  return { from: first.from, to: last.to };
}

/**
 * Панель над выделением: форматирование текста и одно действие над блоком.
 *
 * Действия над блоком живут ЗДЕСЬ, а не на drag handle: расширение drag handle тянет
 * `extension-collaboration` + `y-tiptap` + `yjs` (около 25 кБ gzip из своих 40) — инфраструктуру
 * соредактирования, которую эта работа сознательно не строит (Р13 дизайна). Порядок блоков
 * меняют Alt+↑/↓ (move-block.ts), а убрать блок можно отсюда.
 *
 * Панель — ProseMirror-плагин поверх готового вида: ни ноды, ни марки она не заводит, и схема
 * редактора остаётся равной схеме документа (стережёт тест, а не рассуждение).
 *
 * Показом и позицией распоряжается `extension-bubble-menu`, и он элемент именно УДАЛЯЕТ из
 * дерева, когда показывать нечего (`element.remove()`), а не прячет стилем. Показывается он на
 * любом НЕПУСТОМ выделении — в том числе на NodeSelection (клик по смарт-листу) и на
 * AllSelection (Cmd+A); оба случая разобраны в `rangeToDelete` выше.
 */
export function BubbleToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;

  function deleteBlock(): void {
    if (editor === null) return;
    const range = rangeToDelete(editor.state.selection);
    // Блока «под выделением» нет — значит выделен весь документ (Cmd+A): удаляем ровно то,
    // что выделено. Обращение к `$from.node(1)` тут падало бы TypeError: у такого выделения
    // `$from.depth === 0`.
    if (range === null) {
      editor.chain().focus().deleteSelection().run();
      return;
    }
    editor.chain().focus().deleteRange(range).run();
  }

  return (
    // Классы — на самом элементе панели: плагин распоряжается только его позицией и
    // видимостью (`position/left/top/visibility/opacity/width`), className и data-атрибуты
    // остаются нашими. Оформление — по конвенции проекта (ui/DropdownMenu.tsx, slash/SlashMenu):
    // `bg-surface` + `shadow-pop` + `border-line`. Токена `surface-1` в теме НЕТ вовсе — с ним
    // панель вышла бы прозрачной поверх текста.
    <BubbleMenu
      editor={editor}
      data-testid="bubble-toolbar"
      className="z-50 flex items-center gap-0.5 rounded-card border border-line bg-surface p-1 shadow-pop"
    >
      <Button
        size="icon"
        variant="ghost"
        aria-label="Жирный"
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold size={14} aria-hidden />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Курсив"
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic size={14} aria-hidden />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Зачёркнутый"
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough size={14} aria-hidden />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Код"
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <Code size={14} aria-hidden />
      </Button>
      {/* Разрушающее действие отделено чертой и покрашено в danger. Варианта `danger` у Button
          нет — конвенция репозитория для такого случая — `ghost` + `text-danger`. */}
      <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
      <Button
        size="icon"
        variant="ghost"
        aria-label="Удалить блок"
        className="text-danger hover:text-danger"
        onClick={deleteBlock}
      >
        <Trash2 size={14} aria-hidden />
      </Button>
    </BubbleMenu>
  );
}
