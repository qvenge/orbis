import type { Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Bold, Code, Italic, Strikethrough, Trash2 } from 'lucide-react';
import { Button } from '../../ui/Button';
import { blockTarget } from './move-block';

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
 * AllSelection (Cmd+A); оба случая разобраны в `blockTarget`.
 */
export function BubbleToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;

  function deleteBlock(): void {
    if (editor === null) return;
    const target = blockTarget(editor.state.selection);
    // Блока «под выделением» нет — значит выделен весь документ (Cmd+A): удаляем ровно то,
    // что выделено. Обращение к `$from.node(1)` тут падало бы TypeError: у такого выделения
    // `$from.depth === 0`.
    if (target === null) {
      editor.chain().focus().deleteSelection().run();
      return;
    }
    editor
      .chain()
      .focus()
      .deleteRange({ from: target.from, to: target.from + target.node.nodeSize })
      .run();
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
