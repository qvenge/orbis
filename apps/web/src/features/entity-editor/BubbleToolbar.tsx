import type { ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, Selection } from '@tiptap/pm/state';
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
 *
 * ТАБЛИЦА — названное исключение, а не побочность (решение раунда правок 2). `tableRow` и
 * `tableCell` групп не объявляют вовсе (замерено), подъём проходит их насквозь, и каретка в
 * ячейке убирает ВСЮ таблицу. Так и оставлено: удалять ячейку бессмысленно — таблица обязана
 * оставаться прямоугольной, — а удаление строки это уже другая семантика, которой в задаче
 * нет. Случай закреплён тестом, чтобы следующий читатель видел решение.
 */
function ownBlock($pos: ResolvedPos): Range | null {
  let depth = 0;
  for (let d = $pos.depth; d >= 1; d--) {
    if (d === 1 || $pos.node(d - 1).type.isInGroup('list')) {
      depth = d;
      break;
    }
  }
  // Глубина 0 — AllSelection (Cmd+A): своего блока у такой позиции нет вовсе.
  if (depth === 0) return null;
  // Единственный ребёнок — целью становится РОДИТЕЛЬ. Содержимое списка объявлено как
  // `listItem+`, поэтому удалить последний пункт «в одиночку» нельзя: ProseMirror чинит
  // документ, воссоздавая ПУСТОЙ пункт, — на экране это ровно тот баг v1, против которого
  // написано всё правило, только приехавший другим путём. Замерено пробой на вложенном списке:
  // от него оставался пустой каркас `bulletList > listItem > paragraph`.
  //
  // Цикл, а не одна проверка: пустым может оказаться и родитель родителя (вложенный список —
  // единственное содержимое пункта, тот — единственный пункт своего списка).
  while (depth > 1 && $pos.node(depth - 1).childCount === 1) depth -= 1;
  return { from: $pos.before(depth), to: $pos.after(depth) };
}

/**
 * Правый край выделения — как ТЕКСТОВАЯ позиция, а не как граница.
 *
 * Протянуть выделение из середины абзаца вниз-влево до левого края следующего — обычный жест
 * мыши (и то же даёт Shift+клик в начало абзаца). `$to` встаёт на смещение 0 следующего блока:
 * подсвечено в нём НИЧЕГО, а по правилу «оба конца» он уходил бы целиком — против самого
 * критерия, которым решено брать оба конца («радиус ограничен ровно тем, что видно выделенным»).
 *
 * Отступаем к ближайшей текстовой позиции ЛЕВЕЕ, а не «на один символ»: `resolve(to - 1)` не
 * годится, и это замерено пробой на обеих формах. В списке позиция перед параграфом второго
 * пункта разрешается всё в тот же ВТОРОЙ пункт (ничего не изменилось бы), а между двумя
 * абзацами она лежит на глубине 0 — `ownBlock` вернул бы `null`, и кнопка вместо блока удаляла
 * бы одно выделение. `Selection.near(…, -1)` уходит на конец предыдущего текстового блока в
 * обоих случаях.
 *
 * Выделения ячеек (`CellSelection`) сюда не попадают: у них `$to.parentOffset` — смещение
 * внутри ячейки и нулём не бывает (замерено на таблице 3×3 по трём разным парам ячеек).
 */
function lastTouched(selection: Selection): ResolvedPos {
  if (selection.empty || selection.$to.parentOffset > 0) return selection.$to;
  return Selection.near(selection.$to.doc.resolve(selection.to - 1), -1).$from;
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
  const last = ownBlock(lastTouched(selection));
  if (first === null || last === null) return null;
  // Страховки «а вдруг правый край уехал левее левого» здесь НЕТ намеренно, и это замерено, а
  // не понадеялось: отступ ищет ближайшую текстовую позицию ЛЕВЕЕ `to`, а `from` — сам такая
  // позиция и лежит не правее `to - 1`, поэтому отступ не может уйти за начало выделения
  // (проверено перебором всех выделений с нулевым смещением на трёх абзацах). Мёртвая ветка
  // защиты была бы хуже её отсутствия: она выглядит как разобранный случай, не будучи им.
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
