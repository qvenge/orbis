import { aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { DOC_EXTENSIONS, parseBody, serializeBody } from '@orbis/shared/doc';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getSchema } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
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

/**
 * Панель показывается с задержкой: `updateDelay` у `extension-bubble-menu` — 250 мс (гасит
 * мигание во время протягивания выделения). Прячется она, наоборот, сразу.
 */
const toolbar = (): Promise<HTMLElement> =>
  screen.findByTestId('bubble-toolbar', {}, { timeout: 2000 });

const ALT_DOWN = '{Alt>}{ArrowDown}{/Alt}';
const ALT_UP = '{Alt>}{ArrowUp}{/Alt}';

/**
 * Ловушка для КРАХОВ В ОБРАБОТЧИКАХ. Половина этой задачи — про «не бросает»: горячая клавиша
 * и кнопка панели работают внутри обработчиков событий, а ошибка оттуда до ассертов НЕ
 * доезжает — jsdom её гасит и докладывает отдельно. Прогон при этом краснеет кодом возврата,
 * но САМ ТЕСТ остаётся зелёным, потому что документ после краха, разумеется, не изменился.
 * Проверено мутацией (М6 таблицы отчёта): со снятой проверкой края все четырнадцать тестов
 * файла оставались зелёными, а прогон возвращал 1 — то есть падало «что-то», без единого слова
 * о том, что именно. С этой ловушкой та же мутация роняет ДВА названных теста.
 */
const crashes: string[] = [];
const catchCrash = (e: ErrorEvent) => crashes.push(String(e.error ?? e.message));

beforeEach(() => {
  crashes.length = 0;
  window.addEventListener('error', catchCrash);
});

afterEach(() => {
  window.removeEventListener('error', catchCrash);
  expect(crashes).toEqual([]);
});

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

test('«Удалить блок» в списке сносит ВЕСЬ список, не оставляя пустого пункта', async () => {
  // Код плана v1 удалял `$from.parent` — параграф ВНУТРИ пункта, и на экране оставался пустой
  // пункт списка. Здесь удаляется блок ВЕРХНЕГО уровня (тот же уровень, что двигает Alt+↑/↓):
  // весь список целиком, а не его половина и не пустой каркас.
  const { editor } = await mountEditor('- один\n- два\n\nхвост');
  expect(types(editor)).toEqual(['bulletList', 'paragraph']); // страж вакуумности
  editor.commands.focus();
  // Выделение ВНУТРИ первого пункта: панель показывается только на непустом выделении.
  editor.commands.setTextSelection({ from: 4, to: 7 });
  expect(editor.state.selection.$from.node(1).type.name).toBe('bulletList'); // страж адреса
  await toolbar();

  await userEvent.click(screen.getByLabelText('Удалить блок'));
  const json = JSON.stringify(editor.getJSON());
  expect(json).not.toContain('listItem'); // ни одного пункта — ни полного, ни пустого
  expect(json).not.toContain('bulletList');
  // Положительный контроль: удалён ИМЕННО блок, а не документ — соседний абзац цел.
  expect(texts(editor)).toEqual(['хвост']);
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
