/**
 * Тело страницы и шаблона в редакторе (спека страниц 1а §9.1, §5.5; задача 16): контейнеры —
 * подписанными рамками одна под другой, блоки обвязки — подписанными заглушками без данных, блоки
 * данных — живыми. В заметке такой блок — плашка, а текст его цел (С1а-2, половина редактора).
 *
 * Образец — `query-widget.test.tsx`: настоящий `BodyEditor`, реестр фикстуры, строгий мок пачки.
 */
import {
  type BodyDoc,
  bindQueryBlocks,
  bodyPairFromDoc,
  DOC_SCHEMA_VERSION,
  parseBody,
  serializeBody,
} from '@orbis/shared/doc';
import { GRAMMAR_ERROR_MESSAGES } from '@orbis/shared/doc/page-grammar';
import type { BodyKind } from '@orbis/shared/doc/placement';
import { MISPLACED_HINT } from '@orbis/shared/doc/placement';
import { FIXTURE_PARSE_REGISTRY } from '@orbis/shared/query/fixtures';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { BodyKindProvider } from '../../../lib/query-blocks/body-kind';
import {
  blocksReply,
  blockTexts,
  installCrashTrap,
  renderWithProviders,
  wireEntity,
} from '../../../test/harness';
import { registryReply } from '../../../test/registry';
import { BodyEditor } from '../BodyEditor';
import { EditorShell, isBodyGesture } from '../EditorShell';
import { EDITOR_EXTENSIONS } from '../extensions';

installCrashTrap();

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Строгий мок: реестр и пачка блоков по тексту блока; всё прочее — пусто. */
const api =
  (byQuery: Record<string, { id: string; title: string }[]> = {}) =>
  (path: string, input: unknown): unknown => {
    const rows = Object.fromEntries(
      Object.entries(byQuery).map(([q, list]) => [q, list.map((e) => wireEntity(e))]),
    );
    return registryReply(path) ?? blocksReply(rows)(path, input) ?? {};
  };

type Held = { editor: Editor | null };

function mountEditor(
  kind: BodyKind,
  md: string | BodyDoc,
  handler: (p: string, i: unknown) => unknown = api(),
  extra?: ReactNode,
) {
  const onChange = vi.fn<(doc: BodyDoc) => void>();
  const h: Held = { editor: null };
  const r = renderWithProviders(
    <BodyKindProvider kind={kind}>
      <BodyEditor
        doc={typeof md === 'string' ? parseBody(md) : md}
        onChange={onChange}
        onReady={(e) => {
          h.editor = e;
        }}
      />
      {extra}
    </BodyKindProvider>,
    handler,
  );
  return { r, h, onChange };
}

const LAYOUT =
  '{{columns}}\n{{column}}\nлевая\n{{/column}}\n{{column}}\nправая\n{{/column}}\n{{/columns}}\n\n' +
  '{{tabs}}\n{{tab: Тред}}\nвнутри вкладки\n{{/tab}}\n{{/tabs}}';

const frameLabels = () =>
  screen.getAllByTestId('layout-frame-label').map((n) => n.textContent ?? '');
const stubLabels = () => screen.getAllByTestId('record-stub').map((n) => n.textContent ?? '');

/** Позиция конца текста `needle` в документе — чтобы поставить туда каретку. */
function endOf(editor: Editor, needle: string): number {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isText && node.text === needle) at = pos + needle.length;
  });
  if (at === -1) throw new Error(`нет текста «${needle}»`);
  return at;
}

test('в EDITOR_EXTENSIONS каждый из шести узлов тела v3 — ровно один', () => {
  // Замена фильтром+concat: промахнись фильтр мимо имени — в составе оказались бы два узла с одним
  // именем (схемы и вида), и какой победит, решал бы порядок массива.
  const names = EDITOR_EXTENSIONS.map((e) => (e as { name: string }).name);
  for (const name of ['columns', 'column', 'tabs', 'tab', 'recordBlock', 'aspectCard']) {
    expect(
      names.filter((n) => n === name),
      name,
    ).toHaveLength(1);
  }
});

test('тело страницы: рамки «Колонка 1», «Колонка 2», «Вкладка: Тред» одна под другой, текст внутри правится', async () => {
  const { h, onChange } = mountEditor('page', LAYOUT);
  await waitFor(() => expect(h.editor).not.toBeNull());
  await waitFor(() => expect(frameLabels()).toEqual(['Колонка 1', 'Колонка 2', 'Вкладка: Тред']));
  // Одна под другой — рамками, а не раскладкой показа: сетки колонок и вкладок в редакторе нет.
  expect(screen.queryByTestId('page-columns')).toBeNull();
  expect(screen.queryByTestId('page-tabs')).toBeNull();
  const frames = screen.getAllByTestId('layout-frame');
  expect(within(frames[0] as HTMLElement).getByText('левая')).toBeInTheDocument();
  expect(within(frames[1] as HTMLElement).getByText('правая')).toBeInTheDocument();
  expect(within(frames[2] as HTMLElement).getByText('внутри вкладки')).toBeInTheDocument();

  // Текст части — обычное тело: набор доезжает до документа, в ту же колонку.
  const editor = h.editor as Editor;
  await userEvent.click(
    screen.getByTestId('body-editor').querySelector('[contenteditable]') as HTMLElement,
  );
  editor.commands.focus(endOf(editor, 'левая'));
  await userEvent.keyboard('!');
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  const last = onChange.mock.lastCall?.[0] as BodyDoc;
  expect(serializeBody(last)).toContain('{{column}}\nлевая!\n{{/column}}');
  // Печать правленого документа разбирается обратно в те же контейнеры — запись не уйдёт в raw.
  expect(bodyPairFromDoc(last).doc.doc.content?.map((n) => n.type)).toEqual(['columns', 'tabs']);
});

test('обвязка — заглушки без данных, блок данных — живой (одной пачкой)', async () => {
  const q = 'aspect=orbis/task';
  const md = `{{title}}\n\n{{cards}}\n\n{{card: orbis/goal}}\n\n{{query: ${q}}}`;
  const { r, h } = mountEditor('page', md, api({ [q]: [{ id: 'a', title: 'Разобрать почту' }] }));
  await waitFor(() => expect(h.editor).not.toBeNull());
  await waitFor(() =>
    expect(stubLabels()).toEqual([
      '[Заголовок записи]',
      '[Карточки аспектов]',
      '[Карточка: Цель]Сменить',
    ]),
  );
  expect(await screen.findByTestId('qb-item')).toHaveTextContent('Разобрать почту');
  // Без запросов данных записи: ни `entity.get`, ни карточек — только реестр и одна пачка блоков
  // ровно с блоком данных.
  expect(new Set(r.calls.map((c) => c.path))).toEqual(
    new Set(['registry.effective', 'entity.blocks']),
  );
  const batches = r.calls.filter((c) => c.path === 'entity.blocks');
  expect(batches).toHaveLength(1);
  expect(blockTexts(batches[0] as { input: unknown }).map((t) => t.trim())).toEqual([q]);
  // Заглушки — не текст тела: клик по ним не зовёт редактор (страж первого кадра).
  for (const stub of screen.getAllByTestId('record-stub')) {
    expect(isBodyGesture(stub)).toBe(false);
  }
});

test('первый кадр страницы — те же рамки и заглушки, что редактор', async () => {
  // Редактор встаёт по простою — простой заглушён: проверяется кадр ДО подъёма.
  vi.stubGlobal('requestIdleCallback', () => 1);
  const md = `${LAYOUT}\n\n{{title}}\n\n{{card: orbis/goal}}`;
  renderWithProviders(
    <BodyKindProvider kind="page">
      <EditorShell doc={parseBody(md)} markdown={md} onChange={vi.fn()} />
    </BodyKindProvider>,
    api(),
  );
  await waitFor(() => expect(stubLabels()).toEqual(['[Заголовок записи]', '[Карточка: Цель]']));
  expect(frameLabels()).toEqual(['Колонка 1', 'Колонка 2', 'Вкладка: Тред']);
  expect(screen.queryByTestId('body-editor')).toBeNull();
  // Текст в рамке — текст тела: касание его зовёт редактор.
  expect(isBodyGesture(screen.getByText('левая'))).toBe(true);
});

test('первый кадр страницы: сломанный контейнер — тем же тоном, что на показе (ошибка), неуместный — спокойно', async () => {
  vi.stubGlobal('requestIdleCallback', () => 1);
  const md = 'до\n\n{{columns}}\n{{column}}\nтекст';
  renderWithProviders(
    <BodyKindProvider kind="page">
      <EditorShell doc={parseBody(md)} markdown={md} onChange={vi.fn()} />
    </BodyKindProvider>,
    api(),
  );
  // Показ страницы рисует эту строку плашкой ошибки (`Renderer`, `issueTone`) — первый кадр тоже.
  expect(await screen.findByTestId('qb-error')).toHaveTextContent(
    GRAMMAR_ERROR_MESSAGES.CONTAINER_UNCLOSED,
  );
  expect(screen.queryByTestId('block-misplaced')).toBeNull();
});

test('заметка: {{title}} вставкой — плашка «сделать страницей?», после сохранения текст узла цел', async () => {
  const { h, onChange } = mountEditor('note', 'текст');
  await waitFor(() => expect(h.editor).not.toBeNull());
  // Вставка агентом или из буфера — узел в документе заметки, минуя меню «/».
  (h.editor as Editor).commands.insertContentAt((h.editor as Editor).state.doc.content.size, {
    type: 'recordBlock',
    attrs: { name: 'title' },
  });
  const plaque = await screen.findByTestId('block-misplaced');
  expect(plaque).toHaveTextContent(MISPLACED_HINT);
  expect(screen.queryByTestId('record-stub')).toBeNull();
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  const pair = bodyPairFromDoc(onChange.mock.lastCall?.[0] as BodyDoc);
  expect(pair.body).toBe('текст\n\n{{title}}');
  expect(pair.doc.doc.content?.map((n) => n.type)).toEqual(['paragraph', 'recordBlock']);
});

test('заметка: колонки — одна плашка на контейнер, рамок нет, содержимое в документе цело', async () => {
  const { h } = mountEditor('note', LAYOUT);
  await waitFor(() => expect(h.editor).not.toBeNull());
  await waitFor(() => expect(screen.getAllByTestId('block-misplaced')).toHaveLength(2));
  expect(screen.getAllByTestId('block-misplaced')[0]).toHaveTextContent(MISPLACED_HINT);
  // Части остались в документе, но не показаны: их рамки — только внутри спрятанного содержимого.
  for (const frame of screen.queryAllByTestId('layout-frame')) {
    expect(frame.closest('.hidden')).not.toBeNull();
  }
  expect(serializeBody({ v: DOC_SCHEMA_VERSION, doc: (h.editor as Editor).getJSON() })).toBe(
    LAYOUT,
  );
});

test('«Сменить» у карточки пишет новый ключ и ОБНУЛЯЕТ аспект — привязка не вернёт прежний', async () => {
  // Документ, как его отдаёт сервер: карточка привязана (аспект — id цели).
  const bound = bindQueryBlocks(parseBody('{{card: orbis/goal}}'), FIXTURE_PARSE_REGISTRY);
  const goal = bound.doc.content?.[0]?.attrs?.aspect;
  expect(goal).toBe(FIXTURE_PARSE_REGISTRY.aspects.get('orbis/goal')?.id);
  const { h, onChange } = mountEditor('page', bound);
  await waitFor(() => expect(stubLabels()).toEqual(['[Карточка: Цель]Сменить']));

  fireEvent.click(screen.getByRole('button', { name: 'Сменить' }));
  const chooser = await screen.findByTestId('aspect-chooser');
  fireEvent.click(within(chooser).getByRole('button', { name: 'Проект' }));

  await waitFor(() => expect(stubLabels()).toEqual(['[Карточка: Проект]Сменить']));
  const card = (h.editor as Editor).getJSON().content?.[0];
  expect(card?.attrs?.aspect).toBeNull();
  expect(card?.attrs?.text).toBe('orbis/project');
  // Привязка при записи ставит аспект по НОВОМУ тексту: оставь виджет прежний id, она вернула бы
  // карточке ключ цели (приоритет атрибута, `bindCardAttrs`).
  const saved = onChange.mock.lastCall?.[0] as BodyDoc;
  const rebound = bindQueryBlocks(saved, FIXTURE_PARSE_REGISTRY).doc.content?.[0]?.attrs;
  expect(rebound?.aspect).toBe(FIXTURE_PARSE_REGISTRY.aspects.get('orbis/project')?.id);
  expect(rebound?.text).toBe('orbis/project');
});

test('Backspace в начале колонки 2 выделяет колонку 1 ВИДИМО и ничего не стирает', async () => {
  // Первое нажатие ставит выделение узлом на соседнюю часть; без видимого выделения следующее
  // нажатие молча стирало бы её текст (фикс-раунд 1 задачи 16).
  const { h } = mountEditor('page', LAYOUT);
  await waitFor(() => expect(h.editor).not.toBeNull());
  await waitFor(() => expect(frameLabels()).toHaveLength(3));
  const editor = h.editor as Editor;
  const frames = () => screen.getAllByTestId('layout-frame');
  expect(frames().some((f) => f.dataset.selected === 'true')).toBe(false);

  await userEvent.click(
    screen.getByTestId('body-editor').querySelector('[contenteditable]') as HTMLElement,
  );
  editor.commands.focus(endOf(editor, 'правая') - 'правая'.length);
  await userEvent.keyboard('{Backspace}');
  await waitFor(() => expect(frames()[0]?.dataset.selected).toBe('true'));
  expect(frames()[1]?.dataset.selected).toBeUndefined();
  expect('node' in editor.state.selection).toBe(true);
  expect(serializeBody({ v: DOC_SCHEMA_VERSION, doc: editor.getJSON() })).toBe(LAYOUT);
});

test('выделенная заглушка обвязки видна выделенной', async () => {
  const { h } = mountEditor('page', 'текст\n\n{{title}}');
  await waitFor(() => expect(stubLabels()).toEqual(['[Заголовок записи]']));
  const editor = h.editor as Editor;
  editor.commands.setNodeSelection(editor.state.doc.child(0).nodeSize);
  await waitFor(() => expect(screen.getByTestId('record-stub').dataset.selected).toBe('true'));
});

/**
 * Страж места узлов страницы (§5.2, `layout-guard.ts`): меню «/» — лишь один вход, а вставка
 * своего буфера, обёртки StarterKit и перетаскивание кладут контейнер и блок записи в пункт
 * списка, цитату или третьим уровнем. Сохранение такого документа увело бы ВСЁ тело в `rawBlock`.
 */
const COLUMNS_CLIPBOARD =
  '<div data-columns="" data-pm-slice="0 0 []"><div data-column=""><p>а</p></div>' +
  '<div data-column=""><p>б</p></div></div>';

/** Путь вставки ProseMirror (`doPaste`); в jsdom нет `ClipboardEvent` — событие простое. */
const pasteColumns = (editor: Editor) =>
  editor.view.pasteHTML(COLUMNS_CLIPBOARD, new Event('paste') as ClipboardEvent);

/** Типы верхнего уровня того, что ушло бы в `body_doc` при сохранении. */
const savedTop = (editor: Editor) =>
  bodyPairFromDoc({ v: DOC_SCHEMA_VERSION, doc: editor.getJSON() } as BodyDoc).doc.doc.content?.map(
    (n) => n.type,
  );

/** Есть ли узел `child` под предком `ancestor`. */
function nested(editor: Editor, ancestor: string, child: string): boolean {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name !== ancestor) return true;
    node.descendants((inner) => {
      if (inner.type.name === child) found = true;
    });
    return false;
  });
  return found;
}

/** Глубина вложенности контейнеров (колонки/вкладки) в документе. */
function containerDepth(editor: Editor): number {
  let max = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'columns' && node.type.name !== 'tabs') return true;
    const $pos = editor.state.doc.resolve(pos);
    let depth = 1;
    for (let d = 0; d <= $pos.depth; d++) {
      const name = $pos.node(d).type.name;
      if (name === 'columns' || name === 'tabs') depth += 1;
    }
    max = Math.max(max, depth);
    return true;
  });
  return max;
}

test('страж места: свой буфер с колонками на верх тела вставляется (контроль пути вставки)', async () => {
  const { h } = mountEditor('page', 'Шапка');
  await waitFor(() => expect(h.editor).not.toBeNull());
  const editor = h.editor as Editor;
  editor.commands.setTextSelection(endOf(editor, 'Шапка'));
  pasteColumns(editor);
  expect(savedTop(editor)).toContain('columns');
});

test('страж места: свой буфер с колонками в пункт списка — не в пункте, тело не rawBlock', async () => {
  const { h } = mountEditor('page', 'Шапка\n\n- пункт');
  await waitFor(() => expect(h.editor).not.toBeNull());
  const editor = h.editor as Editor;
  editor.commands.setTextSelection(endOf(editor, 'пункт'));
  pasteColumns(editor);
  expect(nested(editor, 'listItem', 'columns')).toBe(false);
  expect(savedTop(editor)).not.toContain('rawBlock');
});

test('страж места: toggleBlockquote и toggleBulletList через блок записи — блок не уходит в цитату и пункт', async () => {
  const { h } = mountEditor('page', 'до\n\n{{title}}\n\nпосле');
  await waitFor(() => expect(h.editor).not.toBeNull());
  const editor = h.editor as Editor;
  const select = () => editor.commands.setTextSelection({ from: 1, to: endOf(editor, 'после') });

  select();
  editor.commands.toggleBlockquote();
  expect(nested(editor, 'blockquote', 'recordBlock')).toBe(false);
  expect(savedTop(editor)).not.toContain('rawBlock');

  select();
  editor.commands.toggleBulletList();
  expect(nested(editor, 'listItem', 'recordBlock')).toBe(false);
  expect(savedTop(editor)).not.toContain('rawBlock');
});

test('страж места: колонки во вкладку внутри колонки — глубина не растёт, тело не rawBlock', async () => {
  const md =
    '{{columns}}\n{{column}}\n{{tabs}}\n{{tab: T}}\nвнутри\n{{/tab}}\n{{/tabs}}\n{{/column}}\n' +
    '{{column}}\nсоседняя\n{{/column}}\n{{/columns}}';
  const { h } = mountEditor('page', md);
  await waitFor(() => expect(h.editor).not.toBeNull());
  const editor = h.editor as Editor;
  expect(containerDepth(editor)).toBe(2);
  editor.commands.setTextSelection(endOf(editor, 'внутри'));
  pasteColumns(editor);
  expect(containerDepth(editor)).toBe(2);
  expect(savedTop(editor)).not.toContain('rawBlock');
});
