import { aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { DOC_EXTENSIONS, parseBody, serializeBody } from '@orbis/shared/doc';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getSchema } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { expect, test, vi } from 'vitest';
import { installCrashTrap, renderWithProviders } from '../../test/harness';
import { BodyEditor } from './BodyEditor';
import { EDITOR_EXTENSIONS } from './extensions';

// Реестр аспектов — настоящий (как в editor.test.tsx и slash.test.tsx): с пустым каталогом
// любой смарт-лист падал бы плашкой qb-error, и тесты про NodeSelection на живом блоке
// проходили бы по ложной причине.
const realAspects = BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) }));
const handler = (path: string): unknown => {
  if (path === 'aspect.list') return realAspects;
  if (path === 'entity.query') return [];
  return {};
};

type Held = { editor: Editor | null };

/**
 * Редактор с телом `md` и фокусом внутри.
 *
 * Клик по коробке — ОДИН раз и здесь: без него user-event не доставляет набор в
 * contenteditable вовсе (замерено в Задаче 10), а горячие клавиши перемещения блока идут
 * именно набором. Позицию каретки задаёт уже вызывающая сторона командами редактора: клик в
 * jsdom разрешается по геометрии, которой нет (tests/prosemirror-polyfill.ts).
 */
async function mountEditor(md: string) {
  const onChange = vi.fn();
  const h: Held = { editor: null };
  const r = renderWithProviders(
    <BodyEditor
      doc={parseBody(md)}
      onChange={onChange}
      onReady={(e) => {
        h.editor = e;
      }}
    />,
    handler,
  );
  await waitFor(() => expect(h.editor).not.toBeNull());
  const area = (await screen.findByTestId('body-editor')).querySelector(
    '[contenteditable]',
  ) as HTMLElement;
  await userEvent.click(area);
  return { r, h, onChange, area, editor: h.editor as Editor };
}

/** Типы блоков верхнего уровня. */
const types = (e: Editor): string[] => e.getJSON().content?.map((n) => n.type ?? '?') ?? [];

/** Текст каждого блока верхнего уровня — «?» для тех, у кого его нет (атомы). */
const texts = (e: Editor): string[] =>
  (e.getJSON().content ?? []).map(
    (n) => (n as { content?: { text?: string }[] }).content?.[0]?.text ?? `<${n.type}>`,
  );

/** Имена ВСЕХ марок документа. Множеством: важно, что марка ровно та, а не «хоть какая-то». */
function markNames(editor: Editor): string[] {
  const names = new Set<string>();
  editor.state.doc.descendants((node) => {
    for (const mark of node.marks) names.add(mark.type.name);
    return true;
  });
  return [...names].sort();
}

/** Позиция первого блока верхнего уровня с таким именем. */
function topPosOf(editor: Editor, name: string): number {
  let pos = -1;
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === name && pos === -1) pos = offset;
  });
  return pos;
}

/** Позиция текстового узла с таким текстом — адресация в глубину без счёта на пальцах. */
function posOfText(editor: Editor, text: string): number {
  let pos = -1;
  editor.state.doc.descendants((node, at) => {
    if (node.isText && node.text === text && pos === -1) pos = at;
    return true;
  });
  expect(pos, `в документе нет текста «${text}»`).toBeGreaterThan(-1);
  return pos;
}

/** Позиция первого узла с таким именем на ЛЮБОЙ глубине. */
function posOfType(editor: Editor, name: string): number {
  let pos = -1;
  editor.state.doc.descendants((node, at) => {
    if (node.type.name === name && pos === -1) pos = at;
    return true;
  });
  expect(pos, `в документе нет ноды «${name}»`).toBeGreaterThan(-1);
  return pos;
}

/** Сколько в документе узлов с таким именем — на любой глубине. */
function countNodes(editor: Editor, name: string): number {
  let n = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === name) n += 1;
    return true;
  });
  return n;
}

/** Тексты пунктов списка, стоящего блоком верхнего уровня под номером `index`. */
function listTexts(editor: Editor, index: number): (string | undefined)[] {
  const list = editor.getJSON().content?.[index] as
    | { content?: { content?: { content?: { text?: string }[] }[] }[] }
    | undefined;
  return (list?.content ?? []).map((item) => item.content?.[0]?.content?.[0]?.text);
}

/**
 * Панель показывается с задержкой: `updateDelay` у `extension-bubble-menu` — 250 мс (гасит
 * мигание во время протягивания выделения). Прячется она, наоборот, сразу.
 */
const toolbar = (): Promise<HTMLElement> =>
  screen.findByTestId('bubble-toolbar', {}, { timeout: 2000 });

const ALT_DOWN = '{Alt>}{ArrowDown}{/Alt}';
const ALT_UP = '{Alt>}{ArrowUp}{/Alt}';

// Половина этой задачи — про «не бросает»: и горячая клавиша, и кнопка панели работают внутри
// обработчиков событий, где крах не роняет тест, а только код возврата прогона (см. описание
// ловушки в harness). Мутация М6б без неё выживала.
installCrashTrap();

// --- инвариант: ноды и марки редактора ⊆ DOC_EXTENSIONS -------------------------------------

test('MoveBlock и bubble-панель не приносят редактору ни одной ноды и марки', async () => {
  // Серверный путь записи спрашивает схему документа напрямую: НОДОВОЕ или МАРОЧНОЕ
  // расширение, добавленное только в редактор, сделает нерабочим КАЖДОЕ сохранение. MoveBlock
  // по замыслу — только горячие клавиши, панель — ProseMirror-плагин поверх готового вида, но
  // «по замыслу» тут не довод: проверяем на ЖИВОМ экземпляре, в котором панель уже смонтирована.
  const { editor } = await mountEditor('привет');
  const doc = getSchema(DOC_EXTENSIONS as never);
  expect(Object.keys(editor.schema.nodes).sort()).toEqual(Object.keys(doc.nodes).sort());
  expect(Object.keys(editor.schema.marks).sort()).toEqual(Object.keys(doc.marks).sort());

  // Стражи вакуумности: сверять действительно есть что — оба механизма в этом редакторе живы.
  expect(EDITOR_EXTENSIONS.map((e) => (e as { name: string }).name)).toContain('moveBlock');
  expect(editor.extensionManager.extensions.map((e) => e.name)).toContain('moveBlock');
  // Плагин панели — в ЖИВОМ наборе плагинов этого редактора. `p.key` (строка вида
  // `bubbleMenu$`), а не `p.spec.key`: второе — объект PluginKey, и сравнение со строкой было
  // бы ложным всегда.
  const keys = editor.view.state.plugins.map((p) => (p as unknown as { key: string }).key);
  expect(keys.some((k) => k.startsWith('bubbleMenu'))).toBe(true);
});

// --- видимость панели ------------------------------------------------------------------------

test('при схлопнутом выделении панели НЕТ В DOM, при непустом — есть', async () => {
  // `extension-bubble-menu` элемент именно УДАЛЯЕТ (`element.remove()`), а не прячет стилем:
  // проверка `style.visibility` из плана v1 была бы зелена всегда — элемента в дереве в этот
  // момент нет вовсе, и `findByTestId` до стиля просто не доехал бы.
  const { editor } = await mountEditor('привет мир');
  expect(screen.queryByTestId('bubble-toolbar')).toBeNull();

  editor.commands.focus();
  editor.commands.setTextSelection({ from: 1, to: 7 });
  const panel = await toolbar();
  // Панель — та самая: с кнопками, а не пустая коробка, и кнопки лежат ВНУТРИ неё (портал
  // React рисует детей именно в элемент плагина, а не куда-то рядом).
  expect(panel.querySelectorAll('button')).toHaveLength(5);
  expect(screen.getByLabelText('Жирный')).toBeInTheDocument();
  expect(screen.getByLabelText('Удалить блок')).toBeInTheDocument();

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: выделение схлопнули — панель ушла ИЗ ДЕРЕВА.
  // Без него «панели нет» в начале теста было бы правдой и у панели, которая не появляется
  // никогда.
  editor.commands.setTextSelection(1);
  await waitFor(() => expect(screen.queryByTestId('bubble-toolbar')).toBeNull());
});

// --- кнопки марок -----------------------------------------------------------------------------

test('каждая кнопка ставит СВОЮ марку, а не соседнюю', async () => {
  // Пять кнопок различаются одной строкой в вызове команды: опечатка «две кнопки зовут
  // toggleBold» проходит любой проверкой вида «после клика появилась хоть какая-то марка».
  const { editor } = await mountEditor('привет мир');
  const cases: [string, string][] = [
    ['Жирный', 'bold'],
    ['Курсив', 'italic'],
    ['Зачёркнутый', 'strike'],
    ['Код', 'code'],
  ];
  for (const [label, mark] of cases) {
    editor.commands.setContent(parseBody('привет мир').doc, { emitUpdate: false });
    editor.commands.focus();
    editor.commands.setTextSelection({ from: 1, to: 7 });
    await toolbar();
    expect(markNames(editor)).toEqual([]); // страж: до клика марок нет вовсе
    await userEvent.click(screen.getByLabelText(label));
    expect(markNames(editor), `кнопка «${label}»`).toEqual([mark]);
  }
  // Проекция в markdown — тоже настоящая: марка не только в дереве, но и в том, что уедет в БД.
  editor.commands.setContent(parseBody('привет мир').doc, { emitUpdate: false });
  editor.commands.focus();
  editor.commands.setTextSelection({ from: 1, to: 7 });
  await toolbar();
  await userEvent.click(screen.getByLabelText('Жирный'));
  expect(serializeBody(editor.getJSON())).toContain('**привет**');
});

// --- «Удалить блок» ---------------------------------------------------------------------------

test('«Удалить блок» на выделенном смарт-листе удаляет ЕГО, а не молчит', async () => {
  // Код плана v1 (`deleteNode($from.parent.type.name)`) на NodeSelection брал `$from.parent` —
  // а это сам документ, и `deleteNode('doc')` не делает НИЧЕГО. То есть ровно там, где кнопка
  // нужнее всего (у атомарного блока нет иного способа его убрать), она молчала.
  const { editor } = await mountEditor('до\n\n{{query: aspect=orbis/task}}\n\nпосле');
  expect(types(editor)).toEqual(['paragraph', 'queryBlock', 'paragraph']); // страж вакуумности
  editor.commands.focus();
  editor.commands.setNodeSelection(topPosOf(editor, 'queryBlock'));
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  expect(types(editor)).toEqual(['paragraph', 'paragraph']);
  // Соседи целы: удалён БЛОК, а не выделение вместе с окрестностями.
  expect(texts(editor)).toEqual(['до', 'после']);
});

test('«Удалить блок» в списке убирает ПУНКТ, а не весь список', async () => {
  // Решение И1 раунда правок 1. Код плана v1 удалял `$from.parent` — параграф ВНУТРИ пункта,
  // и на экране оставался пустой буллет; первая редакция этой задачи лечила это подъёмом до
  // блока ВЕРХНЕГО уровня, то есть сносила чеклист из двадцати пунктов за каретку в седьмом.
  // Радиус поражения решает: «пропал буллет» — мелочь, «пропал список» — потеря данных за
  // иконкой в четырнадцать пикселей и без подтверждения.
  const { editor } = await mountEditor('- один\n- два\n- три\n\nхвост');
  expect(types(editor)).toEqual(['bulletList', 'paragraph']); // страж вакуумности
  editor.commands.focus();
  // Выделение ВНУТРИ первого пункта: панель показывается только на непустом выделении.
  editor.commands.setTextSelection({ from: 4, to: 7 });
  expect(editor.state.selection.$from.node(1).type.name).toBe('bulletList'); // страж адреса
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  // Список ЖИВ и лишился ровно одного пункта — ни пустого каркаса, ни братской могилы.
  expect(types(editor)).toEqual(['bulletList', 'paragraph']);
  expect(listTexts(editor, 0)).toEqual(['два', 'три']);
  expect(texts(editor)[1]).toBe('хвост');
});

test('«Удалить блок» во ВЛОЖЕННОМ списке убирает вложенный пункт, а не внешний', async () => {
  // Правило «ближайший предок, чей родитель — документ ЛИБО список» проверяется именно здесь:
  // подъём до верхнего уровня снёс бы весь внешний список, подъём «на один» — оставил бы
  // пустой каркас. Между этими двумя ошибками и живёт правильный ответ.
  const { editor } = await mountEditor('- один\n  - вложенный\n- два');
  editor.commands.focus();
  // Каретка внутри «вложенный»: путь paragraph<listItem<bulletList<listItem<bulletList<doc.
  const pos = posOfText(editor, 'вложенный');
  editor.commands.setTextSelection({ from: pos + 1, to: pos + 4 });
  expect(editor.state.selection.$from.depth).toBe(5); // страж адреса: каретка правда глубоко
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  const json = JSON.stringify(editor.getJSON());
  expect(json).not.toContain('вложенный');
  // Внешний список цел ЦЕЛИКОМ: оба его пункта на месте.
  expect(listTexts(editor, 0)).toEqual(['один', 'два']);
  // И вложенного списка не осталось ВОВСЕ (Minor 1 раунда правок 2). Без этой пары ассертов
  // тест был слабее своего комментария: `listTexts` читает только ПЕРВЫЙ параграф пункта, и
  // пустой вложенный каркас проходил незамеченным — а он там и оставался, замерено пробой.
  expect(countNodes(editor, 'bulletList')).toBe(1);
  expect(countNodes(editor, 'listItem')).toBe(2);
});

test('«Удалить блок» в чеклисте убирает пункт: список опознаётся по схеме, а не по имени', async () => {
  // taskList — из другого пакета (@tiptap/extension-list), и его в схеме нет у StarterKit.
  // Правило опирается на группу `list` в самой схеме, а не на перечень имён нод, — иначе
  // чеклист вёл бы себя иначе, чем маркированный список, при одинаковом виде на экране.
  const { editor } = await mountEditor('- [ ] первая\n- [ ] вторая');
  expect(types(editor)).toEqual(['taskList']); // страж вакуумности
  editor.commands.focus();
  const pos = posOfText(editor, 'первая');
  editor.commands.setTextSelection({ from: pos + 1, to: pos + 4 });
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  expect(types(editor)).toEqual(['taskList']);
  expect(listTexts(editor, 0)).toEqual(['вторая']);
});

test('«Удалить блок» в цитате убирает ВСЮ цитату: её родитель — документ', async () => {
  // Положительный контроль к правилу: подъём останавливается на списке — и только на нём.
  // У цитаты родитель — сам документ, поэтому внутренний параграф целью не становится
  // (иначе вернулся бы баг v1: пустой каркас цитаты на экране).
  const { editor } = await mountEditor('> цитата\n\nхвост');
  expect(types(editor)).toEqual(['blockquote', 'paragraph']); // страж вакуумности
  editor.commands.focus();
  editor.commands.setTextSelection({ from: 3, to: 6 });
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  expect(types(editor)).toEqual(['paragraph']);
  expect(texts(editor)).toEqual(['хвост']);
});

test('«Удалить блок» на выделении ПОПЕРЁК двух абзацев убирает ОБА', async () => {
  // Решение И3 раунда правок 1. Путь достижим мышью тривиально — протянуть выделение через
  // границу абзацев, панель показывается. Прежний код смотрел только на `$from`: исчезал
  // первый абзац, а подсвеченный хвост второго оставался на экране — результат, которого
  // никто не просил и который ниоткуда не выводится.
  //
  // Выбрано «удалить все блоки, которых выделение КОСНУЛОСЬ»: радиус жеста ограничен ровно
  // тем, что человек видел выделенным, и кнопка «Удалить блок» означает одно и то же при
  // любом выделении — «убрать то, что подсвечено, целыми блоками».
  const { editor } = await mountEditor('первый\n\nвторой\n\nтретий');
  editor.commands.focus();
  editor.commands.setTextSelection({ from: 4, to: 12 }); // из середины первого в середину второго
  expect(editor.state.selection.$from.parent.textContent).toBe('первый'); // стражи адреса
  expect(editor.state.selection.$to.parent.textContent).toBe('второй');
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  // Оба тронутых абзаца исчезли целиком, третий цел: обрывков не осталось.
  expect(texts(editor)).toEqual(['третий']);
});

test('выделение до НАЧАЛА следующего абзаца убирает только ПЕРВЫЙ', async () => {
  // И4 раунда правок 2. Протянуть выделение из середины абзаца вниз-влево до левого края
  // следующего — обычный жест мыши, и `$to` встаёт на смещение 0 второго абзаца: подсвечено
  // в нём НИЧЕГО, а по правилу «оба конца» он уходил целиком. Это противоречило самому
  // критерию, которым решён И3 («радиус ограничен ровно тем, что видно выделенным»), и было
  // регрессией против кода до раунда правок 1.
  const { editor } = await mountEditor('первый\n\nвторой\n\nтретий');
  editor.commands.focus();
  const second = posOfText(editor, 'второй');
  editor.commands.setTextSelection({ from: 4, to: second });
  expect(editor.state.selection.$to.parentOffset).toBe(0); // страж: край тот самый
  expect(editor.state.selection.$to.parent.textContent).toBe('второй');
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  expect(texts(editor)).toEqual(['второй', 'третий']);
});

test('выделение до начала следующего ПУНКТА убирает только первый пункт', async () => {
  // Тот же край внутри списка, и он же опровергает однострочное лечение из задания: взять
  // блок от `doc.resolve(selection.to - 1)` здесь НЕ работает — позиция перед параграфом
  // второго пункта разрешается всё в тот же второй пункт (замерено пробой). Отступать надо
  // до ближайшей ТЕКСТОВОЙ позиции, а не на один символ.
  const { editor } = await mountEditor('- один\n- два\n- три');
  editor.commands.focus();
  const second = posOfText(editor, 'два');
  editor.commands.setTextSelection({ from: 4, to: second });
  expect(editor.state.selection.$to.parentOffset).toBe(0); // страж: край тот самый
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  expect(listTexts(editor, 0)).toEqual(['два', 'три']);
});

test('«Удалить блок» поперёк двух ПУНКТОВ убирает оба пункта, список цел', async () => {
  // То же правило внутри списка: концы диапазона считаются по обоим краям выделения, и
  // каждый — по правилу И1, то есть до пункта, а не до всего списка.
  const { editor } = await mountEditor('- один\n- два\n- три');
  editor.commands.focus();
  const a = posOfText(editor, 'один');
  const b = posOfText(editor, 'два');
  editor.commands.setTextSelection({ from: a + 1, to: b + 2 });
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  expect(types(editor)).toEqual(['bulletList']);
  expect(listTexts(editor, 0)).toEqual(['три']);
});

test('«Удалить блок» на ЕДИНСТВЕННОМ пункте убирает список, не оставляя каркаса', async () => {
  // Найдено пробой раунда правок 2 при усилении теста вложенного списка. Пункт, оставшийся у
  // списка последним, удалить «в одиночку» нельзя: содержимое списка — `listItem+`, и
  // ProseMirror чинит документ, воссоздавая ПУСТОЙ пункт. На экране это ровно тот баг v1,
  // против которого написано всё правило, — пустой буллет, только приехавший другим путём.
  const { editor } = await mountEditor('- одинокий\n\nхвост');
  editor.commands.focus();
  editor.commands.setTextSelection({ from: 4, to: 8 });
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  expect(countNodes(editor, 'bulletList')).toBe(0);
  expect(countNodes(editor, 'listItem')).toBe(0);
  expect(texts(editor)).toEqual(['хвост']);
});

test('«Удалить блок» из ЯЧЕЙКИ ТАБЛИЦЫ убирает всю таблицу — решение, а не побочность', async () => {
  // Решение раунда правок 2 (пункт 5): поведение оставлено, но обязано быть НАЗВАННЫМ.
  // `table` объявляет группу `block`, а `tableRow`/`tableCell` — не объявляют ничего
  // (замерено), поэтому подъём проходит их насквозь и останавливается на глубине 1.
  // Удалять ячейку бессмысленно — таблица обязана оставаться прямоугольной, а удаление
  // строки — другая семантика, которой в задаче нет.
  const { editor } = await mountEditor('до\n\nпосле');
  editor.commands.focus('end');
  expect(editor.commands.insertTable({ rows: 3, cols: 2, withHeaderRow: true })).toBe(true);
  expect(types(editor)).toContain('table'); // страж вакуумности
  // Панель показывается только на непустом выделении, а ячейки пусты — пишем текст в первую.
  const cell = posOfType(editor, 'tableCell');
  editor.commands.insertContentAt(cell + 2, 'ячейка');
  const at = posOfText(editor, 'ячейка');
  editor.commands.setTextSelection({ from: at, to: at + 6 });
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  expect(countNodes(editor, 'table')).toBe(0);
  expect(countNodes(editor, 'tableCell')).toBe(0);
  // Соседи целы: ушла таблица, а не документ.
  expect(texts(editor)).toContain('до');
  expect(texts(editor)).toContain('после');
});

test('«Удалить блок» при выделенном ВСЁМ документе не бросает и чистит тело', async () => {
  // Cmd+A даёт AllSelection: `$from.depth === 0`, и `$from.node(1)` — undefined. Панель при
  // таком выделении показывается (оно непустое), то есть путь достижим мышью, а код плана v2
  // падал бы на нём TypeError прямо в обработчике клика.
  const { editor } = await mountEditor('один\n\nдва');
  editor.commands.focus();
  editor.commands.selectAll();
  expect(editor.state.selection.$from.depth).toBe(0); // страж: селекция та самая
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  expect(editor.getText()).toBe('');
  // Документ остаётся ДОКУМЕНТОМ: пустой абзац, а не ноль блоков.
  expect(types(editor)).toEqual(['paragraph']);
});

// --- Alt+↑/↓: порядок блоков --------------------------------------------------------------------

test('Alt+↓ меняет местами текущий абзац со следующим, Alt+↑ возвращает', async () => {
  const { editor } = await mountEditor('один\n\nдва\n\nтри');
  editor.commands.focus('start');
  await userEvent.keyboard(ALT_DOWN);
  expect(texts(editor)).toEqual(['два', 'один', 'три']);

  await userEvent.keyboard(ALT_UP);
  expect(texts(editor)).toEqual(['один', 'два', 'три']);
});

test('два Alt+↓ подряд двигают ТОТ ЖЕ абзац, а не гоняют его туда-обратно', async () => {
  // Каретка обязана ехать ВМЕСТЕ с блоком. Без этого она остаётся на прежней позиции — то
  // есть внутри соседа, который встал на место блока, — и второе нажатие двигает уже СОСЕДА:
  // замерено на арифметике плана v2, «один два три» ходило туда-сюда между двумя состояниями.
  const { editor } = await mountEditor('один\n\nдва\n\nтри');
  editor.commands.focus('start');
  await userEvent.keyboard(ALT_DOWN);
  await userEvent.keyboard(ALT_DOWN);
  expect(texts(editor)).toEqual(['два', 'три', 'один']);

  // ВЕРХНЯЯ граница (И2 раунда правок 1). Блок стоит последним — третье нажатие обязано не
  // сделать ничего. До этой строки верхний край не жал НИ ОДИН тест: мутация «убрать только
  // `swapWith >= parent.childCount`» давала RangeError, которого никто не провоцировал, и
  // четырнадцать тестов из четырнадцати оставались зелёными (ловушка крахов тоже молчала —
  // краха не случалось).
  //
  // ЗАВИСИМОСТЬ, которую надо видеть: страж держится на ЛОВУШКЕ КРАХОВ (installCrashTrap выше).
  // Ассерт «порядок не изменился» истинен и при RangeError — документ после краха тот же
  // самый. Уберут ловушку из файла — покрытие верхней границы испарится молча, а тест
  // останется зелёным.
  await userEvent.keyboard(ALT_DOWN);
  expect(texts(editor)).toEqual(['два', 'три', 'один']);
});

test('Alt+↑ на ПЕРВОМ блоке ничего не ломает', async () => {
  // Край документа — не ошибка и не повод прыгать в конец: просто ничего не происходит.
  const { editor, onChange } = await mountEditor('один\n\nдва');
  editor.commands.focus('start');
  const before = JSON.stringify(editor.getJSON());
  await userEvent.keyboard(ALT_UP);
  expect(JSON.stringify(editor.getJSON())).toBe(before);
  expect(onChange).not.toHaveBeenCalled(); // и правкой это не считается

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: с той же кареткой Alt+↓ работает — значит
  // «ничего не изменилось» выше про край, а не про мёртвый жест.
  await userEvent.keyboard(ALT_DOWN);
  expect(texts(editor)).toEqual(['два', 'один']);
});

test('Alt+↓ на выделенном смарт-листе не бросает, двигает его и не теряет выделения', async () => {
  // Проба ревью И9: у NodeSelection на атоме `$from.depth === 0`, и `node(1)` — undefined;
  // код плана v1 бросал TypeError прямо в горячей клавише. Второе нажатие проверяет, что
  // выделение уехало вместе с блоком: иначе жест «поднять список повыше» работал бы один раз.
  const { editor } = await mountEditor('{{query: aspect=orbis/task}}\n\nдва\n\nтри');
  editor.commands.focus();
  editor.commands.setNodeSelection(topPosOf(editor, 'queryBlock'));

  await userEvent.keyboard(ALT_DOWN);
  expect(types(editor)).toEqual(['paragraph', 'queryBlock', 'paragraph']);
  await userEvent.keyboard(ALT_DOWN);
  expect(types(editor)).toEqual(['paragraph', 'paragraph', 'queryBlock']);
  // Блок остался ВЫДЕЛЕННЫМ — панель действий над ним никуда не делась.
  expect(editor.state.selection.constructor.name).toBe('NodeSelection');
});

test('каретка во вложенном списке двигает ВЕСЬ список верхнего уровня', async () => {
  // Зафиксированное поведение v2, а не дефект: жест двигает блок ДОКУМЕНТА. Порядок пунктов
  // внутри списка меняют Tab/Shift+Tab и правка текста, а Alt+↑/↓ работает на том же уровне,
  // на котором работает «Удалить блок», — иначе два соседних жеста означали бы разное.
  const { editor } = await mountEditor('- один\n- два\n\nхвост');
  editor.commands.focus('start');
  expect(editor.state.selection.$from.depth).toBe(3); // страж: каретка правда внутри пункта

  await userEvent.keyboard(ALT_DOWN);
  expect(types(editor)).toEqual(['paragraph', 'bulletList']);
  // Список уехал ЦЕЛИКОМ: оба пункта на месте, а не один.
  const list = editor.getJSON().content?.[1] as { content?: unknown[] };
  expect(list.content).toHaveLength(2);
});

test('Alt+↓ при выделенном ВСЁМ документе ничего не делает и не бросает', async () => {
  // Тот же AllSelection, что и у кнопки удаления: `node(1)` — undefined. Жест наш, поэтому
  // клавишу мы забираем (системная навигация по абзацам в редактор не лезет), но документ
  // при этом не трогаем.
  const { editor } = await mountEditor('один\n\nдва');
  editor.commands.focus();
  editor.commands.selectAll();
  const before = JSON.stringify(editor.getJSON());
  await userEvent.keyboard(ALT_DOWN);
  expect(JSON.stringify(editor.getJSON())).toBe(before);

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: без него тест зелен и когда перемещения нет
  // вовсе — проверено запуском ДО реализации, он единственный из четырнадцати прошёл.
  editor.commands.focus('start');
  await userEvent.keyboard(ALT_DOWN);
  expect(texts(editor)).toEqual(['два', 'один']);
});

test('Alt+↓ на выделенном ПУНКТЕ списка двигает пункт внутри списка', async () => {
  // Арифметика перемещения считает соседей у РОДИТЕЛЯ целевого блока, а не у документа
  // всегда. Сегодня NodeSelection на пункте мышью не поставить (пункт — не атом), но
  // зависеть от этого перемещение не должно: `index(0)` по документу дал бы и ложный отказ
  // на границе (у документа детей меньше, чем у списка), и вставку по чужому адресу.
  const { editor } = await mountEditor('- один\n- два\n- три\n\nхвост');
  const items: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'listItem') items.push(pos);
    return true;
  });
  expect(items).toHaveLength(3); // страж вакуумности
  editor.commands.focus();
  editor.commands.setNodeSelection(items[2] as number);

  await userEvent.keyboard(ALT_UP);
  const list = editor.getJSON().content?.[0] as {
    content?: { content?: { content?: { text?: string }[] }[] }[];
  };
  expect((list.content ?? []).map((li) => li.content?.[0]?.content?.[0]?.text)).toEqual([
    'один',
    'три',
    'два',
  ]);
});

// --- панель не мешает тому, что уже работает ------------------------------------------------

test('панель не перехватывает `/`-меню: набор поверх выделения открывает его как обычно', async () => {
  // Панель живёт в дереве редактора и слушает mousedown в capture-фазе — соседство с
  // suggestion-меню обязано быть мирным. Сценарий бытовой: выделили слово, набрали поверх.
  const { editor } = await mountEditor('привет мир');
  editor.commands.focus();
  editor.commands.setTextSelection({ from: 1, to: 7 });
  await toolbar();

  await userEvent.keyboard(' /заг');
  await screen.findByTestId('slash-menu');
  // Панель ушла сама: выделение схлопнулось набором.
  await waitFor(() => expect(screen.queryByTestId('bubble-toolbar')).toBeNull());
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(types(editor)).toEqual(['heading']));
});

test('при ОТКРЫТОМ /-меню Alt+↓ ходит по меню и НЕ двигает блок', async () => {
  // Пункт 4 раунда правок 1: взаимодействие двух наших же фич. `SlashMenu.onKeyDown` берёт
  // стрелки не глядя на модификаторы, а keymap MoveBlock — отдельный плагин; вопрос был в
  // том, кто из них видит клавишу первым.
  //
  // Замерено: первым видит МЕНЮ. Suggestion-расширения приходят в `useEditor` общим массивом
  // (BodyEditor: `[...EDITOR_EXTENSIONS, ...suggest.extensions]`) и в `state.plugins` стоят
  // РАНЬШЕ keymap'а MoveBlock — `orbisSlashSuggestion$` под индексом 12. Через
  // `registerPlugin` (то есть последним) приезжает только bubble-панель.
  //
  // Это и есть нужный порядок, а не случайная удача: пока меню открыто, каретка стоит внутри
  // набранного `/`, и уехавший из-под неё блок утащил бы за собой и запрос, и координаты меню.
  // Тест сторожит именно порядок — он держится на составе расширений, а не на нашем коде.
  const { editor } = await mountEditor('первый\n\nвторой');
  editor.commands.focus('start');
  await userEvent.keyboard(' /');
  await screen.findByTestId('slash-menu');
  const before = texts(editor);
  const first = screen
    .getAllByRole('option')
    .find((o) => o.getAttribute('aria-selected') === 'true')?.textContent;

  await userEvent.keyboard(ALT_DOWN);
  expect(texts(editor)).toEqual(before); // порядок блоков не тронут
  expect(screen.getByTestId('slash-menu')).toBeInTheDocument(); // меню на месте
  // Положительный контроль: клавишу забрало именно МЕНЮ — выбор в нём сдвинулся.
  const now = screen
    .getAllByRole('option')
    .find((o) => o.getAttribute('aria-selected') === 'true')?.textContent;
  expect(now).not.toBe(first);
});
