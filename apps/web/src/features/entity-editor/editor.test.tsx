import { SEED_SMART_LISTS } from '@orbis/server/src/seed/smart-lists';
import { DOC_EXTENSIONS, DOC_SCHEMA_VERSION, parseBody, serializeBody } from '@orbis/shared/doc';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getSchema } from '@tiptap/core';
import { EditorView } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { installCrashTrap, renderWithProviders } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { BodyEditor, htmlToPlainParagraphs } from './BodyEditor';
import { BODY_PLACEHOLDER } from './body-box';
import { EditorShell } from './EditorShell';
import { EDITOR_EXTENSIONS } from './extensions';
import { canonicalDoc, MARK_ATTR_DEFAULTS, NODE_ATTR_DEFAULTS, UNIQUE_ID_TYPES } from './strip-ids';

/** Сущность, на которую ссылается чип в телах ниже. */
const KUPIT = '0f8fad5b-d9cb-469f-a165-70867728950e';

// Реестр аспектов — настоящий (как в detail.test.tsx): с пустым каталогом любой блок падал бы
// плашкой qb-error, и «первый кадр рисует виджет» проходило бы по ложной причине.
const handler = (path: string) => {
  const reg = registryReply(path);
  if (reg !== undefined) return reg;
  if (path === 'entity.query') return [];
  // Резолв подписей чипа и поиск `@` — пустыми списками, а не `{}`: форма ответа у обоих
  // массив, и объект уронил бы рисование чипа и строк меню на `.map` (замерено пробой).
  if (path === 'entity.resolveRefs') return [];
  if (path === 'entity.suggest') return [];
  return {};
};

/** Буфера обмена в jsdom нет вовсе; `view.pasteHTML` конструирует ClipboardEvent сам. */
class FakeClipboardEvent extends Event {
  clipboardData: unknown = null;
}

// Держатель, а не `let editor: Editor | null`: после присваивания в колбэке TS сужает
// переменную до null и каждое обращение приходится глушить `!`.
type Held = { editor: Editor | null };
const held = (): Held => ({ editor: null });

afterEach(() => {
  vi.unstubAllGlobals();
  // Подмена ставится и на ПРОТОТИП EditorView (разрешение координат клика), а её `vi.stubGlobal`
  // не снимает: без этой строки мок уехал бы в следующие тесты файла.
  vi.restoreAllMocks();
});

// Крах в обработчике события (эффект, NodeView, горячая клавиша) не роняет тест — только код
// возврата прогона. Ровно этим ловилась ошибка `editor.isDestroyed` из Задачи 7: ассерты были
// зелёными, а прогон красным. Ставится файлом, не глобально: см. harness.
installCrashTrap();

// --- состав расширений (И19, инвариант «ноды редактора ⊆ схемы») -------------------------

test('EDITOR_EXTENSIONS не приносит ни одной ноды и марки сверх DOC_EXTENSIONS', () => {
  // Серверный путь записи спрашивает схему документа напрямую: НОДОВОЕ или МАРОЧНОЕ
  // расширение, добавленное только в редактор, сделает нерабочим КАЖДОЕ сохранение.
  // Атрибутные расширения (UniqueID) безопасны — разбор молча отбрасывает незнакомые attrs.
  const doc = getSchema(DOC_EXTENSIONS as never);
  const editor = getSchema(EDITOR_EXTENSIONS as never);
  expect(Object.keys(editor.nodes).sort()).toEqual(Object.keys(doc.nodes).sort());
  expect(Object.keys(editor.marks).sort()).toEqual(Object.keys(doc.marks).sort());
  // Страж вакуумности: обе схемы обязаны быть непустыми и содержать наши ноды.
  expect(Object.keys(editor.nodes)).toContain('queryBlock');
  expect(Object.keys(editor.nodes)).toContain('entityRef');
});

test('подменённые ноды в составе редактора ровно по одной — замена, а не вторая нода', () => {
  // Задачи 8 и 9 меняют ноды их же версиями с NodeView через filter+concat. Промахнись
  // фильтр мимо имени (ровно так в плане v1 умер белый список протоколов) — в массиве
  // оказались бы ДВЕ ноды с этим именем, а схемы выше остались бы равными: имена-то те же.
  // Имена перечислены поимённо, а не сверяются со списком concat: общий фильтр по двум
  // именам может промахнуться мимо ЛЮБОГО из них, и промах по второму молча пережил бы
  // проверку по первому.
  expect(EDITOR_EXTENSIONS.filter((e) => e.name === 'entityRef')).toHaveLength(1);
  expect(EDITOR_EXTENSIONS.filter((e) => e.name === 'queryBlock')).toHaveLength(1);
});

test('таблицы умолчаний strip-ids совпадают со схемой — поимённо и по значению', () => {
  /**
   * `NODE_ATTR_DEFAULTS`/`MARK_ATTR_DEFAULTS` — копия умолчаний схемы, снятая РУКАМИ: файл
   * сравнения листовой, и чтение настоящей схемы утащило бы её 156 кБ в чанк записи (докблок
   * strip-ids.ts). Копия без стража — это ровно тот дефект, который она лечит: расходится она
   * МОЛЧА, а расплата — фантомная правка (открытие записи двигает `updated_at`; «Принять» в
   * слое шлёт `edits.body` без единого нажатия).
   *
   * Сверка ДВУСТОРОННЯЯ (`toEqual`, а не «каждый ключ таблицы есть в схеме»): пропущенный
   * атрибут возвращает фантом, а лишний — прячет настоящую правку владельца. Ошибиться можно
   * в обе стороны, и красить обязано тоже в обе.
   */
  type AttrSpec = { hasDefault: boolean; default?: unknown };
  // Таблицу атрибутов prosemirror-model в своих типах не публикует — она есть только в рантайме.
  const defaultsOf = (type: unknown): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries((type as { attrs: Record<string, AttrSpec> }).attrs)
        .filter(([, a]) => a.hasDefault)
        .map(([k, a]) => [k, a.default]),
    );
  const tableOf = (types: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(types)
        .map(([name, t]) => [name, defaultsOf(t)] as const)
        .filter(([, d]) => Object.keys(d).length > 0),
    );

  const doc = getSchema(DOC_EXTENSIONS as never);
  expect(tableOf(doc.nodes)).toEqual(NODE_ATTR_DEFAULTS);
  expect(tableOf(doc.marks)).toEqual(MARK_ATTR_DEFAULTS);
  // Страж вакуумности: сорвись каст выше — обе таблицы вышли бы пустыми, и `toEqual` сравнивал
  // бы пустоту с пустотой ровно до первой правки strip-ids.ts.
  expect(MARK_ATTR_DEFAULTS.link?.rel).toBe('noopener noreferrer nofollow');
  expect(NODE_ATTR_DEFAULTS.tableCell?.colspan).toBe(1);

  /**
   * Схема РЕДАКТОРА добавляет к тем же типам ровно один атрибут — блочный `id` UniqueID, и
   * ровно у типов из `UNIQUE_ID_TYPES`. В таблицах умолчаний его нет НАМЕРЕННО: он снимается
   * безусловно, а не по равенству умолчанию (правка, меняющая только `id`, правкой не
   * является ни при каком его значении). Появись у редактора ещё один свой атрибут — сверка
   * выше о нём не узнала бы вовсе, потому что смотрит на схему ДОКУМЕНТА.
   */
  const editor = getSchema(EDITOR_EXTENSIONS as never);
  const extra = Object.entries(editor.nodes).flatMap(([name, t]) => {
    const before = new Set(Object.keys(defaultsOf(doc.nodes[name])));
    return Object.keys(defaultsOf(t))
      .filter((a) => !before.has(a))
      .map((a) => `${name}.${a}`);
  });
  expect(extra.sort()).toEqual([...UNIQUE_ID_TYPES].map((t) => `${t}.id`).sort());
});

test('UniqueID в составе редактора и его НЕТ в схеме документа', () => {
  // Атрибут id ставится только в редакторе (см. «Известные границы» дизайна): попав в
  // DOC_EXTENSIONS, он появился бы и на серверном разборе, где его никто не чистит.
  const names = (list: unknown[]) => list.map((e) => (e as { name: string }).name);
  expect(names(EDITOR_EXTENSIONS)).toContain('uniqueID');
  expect(names(DOC_EXTENSIONS)).not.toContain('uniqueID');
});

// --- Б4: открытие сущности НЕ пишет в БД -------------------------------------------------

test('монтирование документа с сервера НЕ зовёт onChange — открытие не пишет в БД', async () => {
  // Два фантома, пойманные ревью: trailingNode дописывал пустой абзац (выключен в схеме),
  // UniqueID проставляет id транзакцией после монтирования (гасится canonicalDoc-сравнением).
  const onChange = vi.fn();
  const h = held();
  const md = 'текст\n\n{{query: aspect=orbis/task, orbis/task_status=inbox}}'; // кончается блоком — худший случай
  renderWithProviders(
    <BodyEditor doc={parseBody(md)} onChange={onChange} onReady={(e) => (h.editor = e)} />,
    handler,
  );
  await screen.findByTestId('body-editor');
  await new Promise((r) => setTimeout(r, 50)); // даём UniqueID диспатчнуть свою транзакцию

  // Страж вакуумности: без этих двух ассертов тест зелен и когда редактор вовсе не ожил
  // (тогда и транзакции простановки id не было, и гасить было нечего).
  const json = h.editor?.getJSON();
  expect(json?.content?.map((n) => n.type)).toEqual(['paragraph', 'queryBlock']);
  expect(json?.content?.every((n) => typeof n.attrs?.id === 'string')).toBe(true);

  expect(onChange).not.toHaveBeenCalled();
});

test('жирный текст в теле при открытии тоже не зовёт onChange (порядок ключей)', async () => {
  // Отдельный тест, потому что причина отказа тут ДРУГАЯ, чем у id: parseBody отдаёт
  // текстовый узел как {type,text,marks}, а ProseMirror — {type,marks,text}. Сравнение
  // сырых строк JSON (как в брифе) считало бы правкой открытие любой записи с жирным,
  // курсивом или ссылкой.
  const onChange = vi.fn();
  const h = held();
  const md = 'обычный и **жирный** текст\n\n{{query: aspect=orbis/task}}';
  renderWithProviders(
    <BodyEditor doc={parseBody(md)} onChange={onChange} onReady={(e) => (h.editor = e)} />,
    handler,
  );
  await screen.findByTestId('body-editor');
  await new Promise((r) => setTimeout(r, 50));
  // Страж вакуумности: марка в документе должна БЫТЬ, иначе тест ничего не утверждает.
  expect(JSON.stringify(h.editor?.getJSON())).toContain('"bold"');
  expect(onChange).not.toHaveBeenCalled();
});

test('ссылка, нумерованный список и таблица при открытии не зовут onChange (умолчания атрибутов)', async () => {
  /**
   * Третья причина того же отказа, и самая дорогая: разбор markdown НЕ пишет атрибуты, значения
   * которых подразумеваются, а схема при посадке дописывает их все — марке `link` три
   * (`target`, `rel`, `class`), нумерованному списку `start` и `type`, каждой ячейке таблицы
   * четыре. Пост-маунтовая транзакция UniqueID приносит эту разницу в `onUpdate`, и до
   * `NODE_ATTR_DEFAULTS`/`MARK_ATTR_DEFAULTS` открытие такой записи слало фантомный
   * `entity_update`: markdown байт-в-байт тот же, а `updated_at` новый — от чего живое
   * предложение рутины на этой записи само делалось `stale` (смоук Ш1, Н-1).
   *
   * Тела в ОДНОМ редакторе, а не тремя тестами: причина отказа у всех трёх одна, и разводить
   * её на три стенда значило бы втрое платить за монтирование ради одного и того же довода.
   */
  const onChange = vi.fn();
  const h = held();
  const md = [
    'позвонить в [клинику](https://clinic.example/zuby)',
    '',
    '1. один',
    '2. два',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n');
  renderWithProviders(
    <BodyEditor doc={parseBody(md)} onChange={onChange} onReady={(e) => (h.editor = e)} />,
    handler,
  );
  await screen.findByTestId('body-editor');
  await new Promise((r) => setTimeout(r, 50)); // даём UniqueID диспатчнуть свою транзакцию

  // Страж вакуумности, и он тут обязателен вдвойне: без него тест зелен и когда разбор увёл
  // всё тело в raw-блок (тогда ни ссылки, ни списка, ни таблицы в документе нет вовсе — и
  // гасить нечего). Проверяются ИМЕННО дописанные атрибуты, а не наличие узлов: они и есть
  // предмет.
  const json = JSON.stringify(h.editor?.getJSON());
  expect(h.editor?.getJSON().content?.map((n) => n.type)).toEqual([
    'paragraph',
    'orderedList',
    'table',
  ]);
  expect(json).toContain('"rel":"noopener noreferrer nofollow"');
  expect(json).toContain('"colspan":1');

  expect(onChange).not.toHaveBeenCalled();
});

test('ни один из пяти сидов при открытии не зовёт onChange', async () => {
  // Все пять сидированных тел кончаются блоком смарт-листа — тот самый вход, на котором
  // trailingNode дописывал абзац и автосейв слал фантомный entity_updated.
  const onChange = vi.fn();
  renderWithProviders(
    SEED_SMART_LISTS.map((s) => (
      <BodyEditor key={s.slug} doc={parseBody(s.body)} onChange={onChange} />
    )),
    handler,
  );
  const editors = await screen.findAllByTestId('body-editor');
  expect(editors).toHaveLength(SEED_SMART_LISTS.length);
  await new Promise((r) => setTimeout(r, 50));
  expect(onChange).not.toHaveBeenCalled();
});

// --- правка: onChange зовётся и документ остаётся документом ------------------------------

test('набор в редакторе отдаёт новый документ через onChange', async () => {
  const onChange = vi.fn();
  const h = held();
  renderWithProviders(
    <BodyEditor doc={parseBody('начало')} onChange={onChange} onReady={(e) => (h.editor = e)} />,
    handler,
  );
  const area = (await screen.findByTestId('body-editor')).querySelector('[contenteditable]');
  await waitFor(() => expect(h.editor).not.toBeNull());
  h.editor?.commands.focus('end');
  await userEvent.type(area as HTMLElement, ' и хвост');
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(serializeBody(onChange.mock.calls.at(-1)?.[0])).toContain('и хвост');
});

test('смарт-лист переживает набор рядом с ним и не превращается в текст', async () => {
  // Главное обещание работы: во время правки блок остаётся блоком, а не фигурными скобками.
  const onChange = vi.fn();
  const h = held();
  const md = 'привет\n\n{{query: aspect=orbis/task, orbis/task_status=inbox}}';
  renderWithProviders(
    <BodyEditor doc={parseBody(md)} onChange={onChange} onReady={(e) => (h.editor = e)} />,
    handler,
  );
  const area = (await screen.findByTestId('body-editor')).querySelector('[contenteditable]');
  await waitFor(() => expect(h.editor).not.toBeNull());
  h.editor?.commands.focus('start');
  // Набор адресован САМОМУ АБЗАЦУ, а не коробке редактора, и это не косметика.
  // `type()` перед вводом КЛИКАЕТ, и текст уходит в выделение, которое поставил этот клик, —
  // `commands.focus('start')` тут только фокусирует. Клик по коробке jsdom разрешает по
  // геометрии, которой нет (все прямоугольники нулевые, elementFromPoint отдаёт null —
  // tests/prosemirror-polyfill.ts), и под нагрузкой он один раз уложил каретку gap-курсором
  // ПОСЛЕ блока смарт-листа (Gapcursor входит в StarterKit): набор создал третий абзац, и тест
  // упал «лишним paragraph» — рассказывая про схлопывание блока, которого не было.
  // Воспроизведено пробой (focus('end') даёт ту же подпись) и ею же проверено лечение: с
  // адресацией в абзац тест проходит даже при focus('end'), то есть от позиции каретки,
  // оставленной focus(), он больше не зависит. `skipClick` не годится — без клика user-event
  // не вставляет в contenteditable вовсе (проверено: onChange не зовётся).
  const firstParagraph = (area as HTMLElement).querySelector('p');
  await userEvent.type(firstParagraph as HTMLElement, '!');
  await waitFor(() => expect(onChange).toHaveBeenCalled());

  // Проверка по ФОРМЕ ДОКУМЕНТА, а не по markdown-проекции: абзац с буквальным текстом
  // `{{query:…}}` сериализуется в ровно ту же строку (это закреплено convert.test.ts —
  // «обёртка не с колонки 1 блоком не считается», где канон литерала равен входу), поэтому
  // `toContain('{{query: …}}')` оставался бы зелёным и при схлопывании блока в текст.
  const next = onChange.mock.calls.at(-1)?.[0] as { doc: { content?: { type: string }[] } };
  expect(next.doc.content?.map((n) => n.type)).toEqual(['paragraph', 'queryBlock']);
  expect(serializeBody(next)).toContain('{{query: aspect=orbis/task, orbis/task_status=inbox}}');
});

// --- Б5: белый список протоколов --------------------------------------------------------

test('setLink: проходит только белый список протоколов схемы', async () => {
  // Через набор текста этого не проверить: набранный текст не автолинкуется, поэтому
  // прежний тест был зелен и БЕЗ всякой защиты (ревью Б5).
  const h = held();
  renderWithProviders(
    <BodyEditor doc={parseBody('текст')} onChange={vi.fn()} onReady={(e) => (h.editor = e)} />,
    handler,
  );
  await waitFor(() => expect(h.editor).not.toBeNull());
  h.editor?.commands.selectAll();
  expect(h.editor?.commands.setLink({ href: 'javascript:alert(1)' })).toBe(false);
  // `ftp:` и `tel:` — те, на которых виден НАШ список: одного `javascript:` мало, его
  // современный Link отвергает и с умолчаниями, и тест не поймал бы повторную потерю
  // конфига схемы — ровно сценарий Б5, ради которого переписан v2.
  expect(h.editor?.commands.setLink({ href: 'ftp://example.com/x' })).toBe(false);
  expect(h.editor?.commands.setLink({ href: 'tel:+79990000000' })).toBe(false);
  expect(h.editor?.commands.setLink({ href: 'https://example.com' })).toBe(true);
  expect(h.editor?.commands.setLink({ href: 'mailto:a@b.c' })).toBe(true);
  // Внутренняя ссылка приложения — путь без протокола, SAFE_URI её пропускает.
  expect(h.editor?.commands.setLink({ href: '/e/0f8fad5b' })).toBe(true);
});

// --- И11: вставка HTML ------------------------------------------------------------------

test('вставка HTML сохраняет границы блоков и не тащит содержимое <style>', () => {
  // Голый regex `html.replace(/<[^>]*>/g, '')` из v1 склеивал абзацы в одну строку и
  // приносил в документ текст правил CSS.
  const html =
    '<style>.a{color:red}</style><p>первый</p><p>второй</p><script>alert(1)</script>' +
    '<div>третий<br>четвёртый</div>';
  const out = htmlToPlainParagraphs(html);
  expect(out).toBe('<p>первый</p><p>второй</p><p>третий</p><p>четвёртый</p>');
  expect(out).not.toContain('color:red');
  expect(out).not.toContain('alert(1)');
});

test('вставка HTML экранирует разметку в тексте и не растит хвост пустых абзацев', () => {
  // Экранируются `&` и `<` — те два символа, что заводят разметку. Голый `>` в тексте
  // элемента разметкой не является и обратно читается собой (проверяется round-trip'ом ниже).
  const escaped = htmlToPlainParagraphs('<p>a &amp; b &lt;div&gt;</p>');
  expect(escaped).toBe('<p>a &amp; b &lt;div></p>');
  expect(new DOMParser().parseFromString(escaped, 'text/html').body.textContent).toBe(
    'a & b <div>',
  );
  expect(htmlToPlainParagraphs('<p>один</p>\n\n')).toBe('<p>один</p>');
  expect(htmlToPlainParagraphs('<style>.a{}</style>')).toBe('');
  // Вложенная вёрстка (так выглядит вставка почти с любой страницы): границу закрывают и
  // <p>, и обёртка вокруг него — пустых абзацев между строками быть не должно.
  expect(htmlToPlainParagraphs('<div><p>a</p></div><div><p>b</p></div>')).toBe('<p>a</p><p>b</p>');
});

test('вставка через ProseMirror идёт тем же путём: разметка снята, границы целы', async () => {
  // ClipboardEvent в jsdom нет вовсе, а без него не позвать view.pasteHTML. Заглушка местная:
  // проверяем ПРОВОДКУ transformPastedHTML в editorProps, а не сам буфер обмена.
  //
  // Вход подобран так, чтобы тест УМЕЛ ПАДАТЬ. Умолчание prosemirror-model само выбрасывает
  // style/script/head/noscript и само делает из двух <p> два абзаца — на таком входе тест был
  // бы зелен и с выдернутой проводкой. Заголовок и <strong> умолчание, наоборот, СОХРАНИТ:
  // их снимает только наше преобразование.
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
  const h = held();
  renderWithProviders(
    <BodyEditor doc={parseBody('')} onChange={vi.fn()} onReady={(e) => (h.editor = e)} />,
    handler,
  );
  await waitFor(() => expect(h.editor).not.toBeNull());
  h.editor?.commands.focus('end');
  h.editor?.view.pasteHTML(
    '<style>.a{color:red}</style><h1>заголовок</h1><p><strong>жирный</strong></p>',
  );
  const json = JSON.stringify(h.editor?.getJSON());
  expect(json).not.toContain('"heading"');
  expect(json).not.toContain('"bold"');
  expect(json).not.toContain('color:red');
  const text = h.editor?.getText() ?? '';
  expect(text).toContain('заголовок');
  expect(text).toContain('жирный');
  // Границу блоков проверяем по ДОКУМЕНТУ, а не по тексту: склейка в одну строку дала бы
  // один абзац, и `toContain` обеих подстрок оставался бы зелёным.
  expect((h.editor?.getJSON().content ?? []).length).toBeGreaterThan(1);
});

// --- копия ИЗНУТРИ редактора (итоговое ревью, находка 1) ---------------------------------

/** Тело со всем, что круг «скопировал → вставил» обязан донести целым. */
const RICH_BODY = [
  '# Заголовок',
  '',
  `текст с **жирным** и [[entity:${KUPIT}|Купить]] внутри`,
  '',
  '- один',
  '- два',
  '',
  '{{query: aspect=orbis/task, orbis/task_status=inbox}}',
].join('\n');

/** Редактор с телом `md` и проставленными блочными id. */
async function mountBody(md: string, onChange = vi.fn()) {
  const h = held();
  renderWithProviders(
    <BodyEditor doc={parseBody(md)} onChange={onChange} onReady={(e) => (h.editor = e)} />,
    handler,
  );
  await screen.findByTestId('body-editor');
  await waitFor(() => expect(h.editor).not.toBeNull());
  await new Promise((r) => setTimeout(r, 50)); // UniqueID диспатчит свою транзакцию
  return { h, onChange, editor: h.editor as Editor };
}

test('копия ПРИВЯЗАННОГО смарт-листа возвращается с ДЕРЕВОМ, а не с «[object Object]»', async () => {
  // Уже чинившийся дефект, вернувшийся бы молча (итоговое ревью Задачи 9, находка 1): общая
  // нода печатает атрибуты в `data-*`, а умолчание Tiptap ищет обратно атрибут по имени. С
  // объектом в `ast` печать дала бы `data-ast="[object Object]"`, а разбор вернул бы ЭТУ САМУЮ
  // строку в атрибут-дерево — виджет с тем же видом, показывающий не то. Пути ровно один:
  // буфер обмена редактора, и теста на него не было.
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
  const ast = {
    filter: { aspect: 'orbis/task' },
    sortBy: [{ field: 'orbis/updated_at', dir: 'desc' }],
    title: 'Задачи',
  };
  const h = held();
  renderWithProviders(
    <BodyEditor
      doc={{
        v: DOC_SCHEMA_VERSION,
        doc: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'до' }] },
            {
              type: 'queryBlock',
              attrs: { ast, text: 'aspect=orbis/task, sortBy=orbis/updated_at:desc, title=Задачи' },
            },
          ],
        },
      }}
      onChange={vi.fn()}
      onReady={(e) => (h.editor = e)}
    />,
    handler,
  );
  await screen.findByTestId('body-editor');
  await waitFor(() => expect(h.editor).not.toBeNull());
  const editor = h.editor as Editor;

  editor.commands.selectAll();
  const html = editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML;
  // Страж вакуумности: дерево и правда уехало в разметку буфера, и уехало JSON'ом.
  expect(html).toContain('data-ast=');
  expect(html).not.toContain('[object Object]');

  editor.view.pasteHTML(html);
  const block = (editor.getJSON().content ?? []).find((n) => n.type === 'queryBlock');
  expect(block?.attrs?.ast).toEqual(ast);
  expect(block?.attrs?.text).toBe('aspect=orbis/task, sortBy=orbis/updated_at:desc, title=Задачи');
});

test('копия ИЗНУТРИ редактора вставляется целой: чип, смарт-лист и разметка живы', async () => {
  // Бытовой жест: выделить кусок тела, Cmd+C, Cmd+V. Санитайзер вставки стоял на ВСЯКОМ HTML,
  // включая свой собственный (`parseFromClipboard` зовёт `transformPastedHTML` ДО того, как
  // ищет `data-pm-slice`), а собирал он результат из `textContent` — у чипа и смарт-листа
  // текста в разметке схемы нет вовсе. Потеря молчаливая: человек видит вставленный текст,
  // решает, что всё на месте, удаляет оригинал и теряет ссылку насовсем.
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
  const { editor } = await mountBody(RICH_BODY);
  const before = editor.getJSON();

  // Cmd+C кладёт в буфер разметку СХЕМЫ (`DOMSerializer.fromSchema`), а не то, что рисует
  // NodeView, — поэтому у чипа и блока в ней нет ни буквы текста.
  editor.commands.selectAll();
  const html = editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML;
  // Стражи вакуумности: копировать действительно есть что, разметка своя и помеченная, а у
  // чипа она и правда пустая — вот и причина, по которой сборка «из textContent» его теряла.
  expect(html).toContain('data-pm-slice');
  expect(html).toContain(`data-entity-id="${KUPIT}"`);
  expect(html).toContain('data-label="Купить"></span>');
  expect(html).toContain('data-query=" aspect=orbis/task, orbis/task_status=inbox"></div>');

  // Cmd+V поверх того же выделения: документ обязан остаться ТЕМ ЖЕ.
  editor.view.pasteHTML(html);
  const after = editor.getJSON();
  // Поимённо — чтобы падение называло потерю, а не показывало два дерева. Чип обязан приехать
  // С АТРИБУТАМИ: нода без entityId — это ссылка, потерянная так же начисто, как и снятая.
  const para = after.content?.[1] as {
    content?: { type?: string; attrs?: Record<string, unknown> }[];
  };
  expect(para?.content?.map((n) => n.type)).toEqual(['text', 'text', 'text', 'entityRef', 'text']);
  expect(para?.content?.[3]?.attrs?.entityId).toBe(KUPIT);
  expect(after.content?.map((n) => n.type)).toEqual([
    'heading',
    'paragraph',
    'bulletList',
    'queryBlock',
  ]);
  // `text` — тот же неразобранный текст: круг «копия → вставка» идёт через HTML буфера, и
  // читает его атрибутный parseHTML ноды (`data-query`/`data-ast`). Дерева у блока, собранного
  // разбором markdown, нет — реестра в этом слое не бывает (Р-21-1).
  expect(after.content?.[3]?.attrs?.text).toBe(' aspect=orbis/task, orbis/task_status=inbox');
  expect(after.content?.[3]?.attrs?.ast).toBeNull();
  // И целиком, с точностью до того, что редактор дописывает сам (блочные id, умолчания
  // атрибутов): круг копирования документ не меняет.
  expect(canonicalDoc(after)).toEqual(canonicalDoc(before));

  // Тот же круг, но с прибавкой, которую делает настоящий браузер: он дописывает к содержимому
  // буфера `<meta charset=…>` и разметку границ фрагмента. Признак читается у первого ЭЛЕМЕНТА,
  // и оба этих довеска обязаны пройти мимо него.
  editor.commands.selectAll();
  editor.view.pasteHTML(`<meta charset="utf-8"><!--StartFragment-->${html}<!--EndFragment-->`);
  expect(JSON.stringify(editor.getJSON())).toContain(KUPIT);

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: чужой HTML по-прежнему приходит ПЛОСКИМ — пропуск
  // сделан ровно для своей разметки, а не для любой.
  editor.commands.selectAll();
  editor.view.pasteHTML('<h1>чужой</h1><p><strong>жирный</strong></p>');
  const foreign = JSON.stringify(editor.getJSON());
  expect(foreign).not.toContain('"heading"');
  expect(foreign).not.toContain('"bold"');
  expect(foreign).toContain('чужой');
});

test('копия ОДНОГО блока смарт-листа вставляется блоком, а не пустотой', async () => {
  // Худший случай находки: у копии блока `textContent` пуст, преобразование возвращало `''`,
  // и вставка не приносила ВООБЩЕ НИЧЕГО — молча.
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
  const { editor } = await mountBody('привет\n\n{{query: aspect=orbis/task}}');
  // Адресуемся к блоку по ТИПУ, а не по арифметике: NodeSelection обязана стоять на нём.
  let pos = -1;
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'queryBlock') pos = offset;
  });
  expect(pos).toBeGreaterThan(-1); // страж вакуумности
  editor.commands.setNodeSelection(pos);
  const html = editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML;
  expect(new DOMParser().parseFromString(html, 'text/html').body.textContent).toBe(''); // текста нет

  editor.commands.focus('start');
  editor.view.pasteHTML(html);
  expect(editor.getJSON().content?.filter((n) => n.type === 'queryBlock')).toHaveLength(2);
});

test('подстрока признака в ТЕКСТЕ чужой статьи мимо санитайзера не пропускает', async () => {
  // Признак читается у ПЕРВОГО элемента разобранного документа, а не ищется подстрокой во всей
  // строке. Иначе обычная статья про ProseMirror — где `data-pm-slice` набран внутри `<code>` —
  // проходила бы мимо санитайзера ЦЕЛИКОМ: заголовок оставался заголовком, `<strong>` маркой.
  // Подделка требует умысла, а сюда довольно скопировать техническую статью (ре-ревью пакета B).
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
  const { editor } = await mountBody('привет');
  editor.commands.selectAll();
  editor.view.pasteHTML(
    '<h1>Как устроен буфер ProseMirror</h1>' +
      '<p>Срез помечается атрибутом <code>data-pm-slice</code> на первом элементе, ' +
      'и <strong>это важно</strong>.</p>',
  );
  const json = JSON.stringify(editor.getJSON());
  // Страж вакуумности: подстрока в тексте статьи ЕСТЬ — иначе тест ничего не утверждает.
  expect(json).toContain('data-pm-slice');
  expect(json).not.toContain('"heading"');
  expect(json).not.toContain('"bold"');
  expect(json).not.toContain('"code"');
  // Границы блоков санитайзер, как и прежде, бережёт: статья приехала абзацами, а не строкой.
  expect((editor.getJSON().content ?? []).length).toBeGreaterThan(1);
});

test('признак НЕ на первом элементе своим не считается', async () => {
  // `parseFromClipboard` ищет признак `querySelector`ом, то есть на ЛЮБОЙ глубине, — значит
  // проверка «есть ли подстрока» и проверка «свой ли это буфер» расходились ещё и здесь.
  // Заодно это самый дешёвый способ подделки, и он же ронял вставку: контекст среза,
  // называющий обёрткой атомарную ноду, бросает TypeError прямо в обработчике (замерено).
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
  const { editor } = await mountBody('привет');
  editor.commands.selectAll();
  // Не бросает — потому что до разбора ProseMirror эта разметка уже не доходит.
  editor.view.pasteHTML('<div><h1 data-pm-slice=\'2 2 ["queryBlock",{}]\'>чужое</h1></div>');
  const json = JSON.stringify(editor.getJSON());
  expect(json).toContain('чужое'); // страж вакуумности: вставка вообще случилась
  expect(json).not.toContain('"heading"');
});

test('пропуск по data-pm-slice не проносит в документ ни стилей, ни скриптов', async () => {
  // Цена пропуска названа прямо: подделать признак в чужом HTML можно, и тогда разметка идёт в
  // разбор ProseMirror. Рубеж там свой и он не наш собственный код, а СХЕМА: `<style>`,
  // `<script>` и `<head>` prosemirror-model выбрасывает сам, ноды и марки вне схемы не
  // создаются, а протоколы ссылок стережёт белый список (тест Б5 выше).
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
  const { editor } = await mountBody('привет');
  editor.commands.selectAll();
  editor.view.pasteHTML(
    '<p data-pm-slice="0 0 []">чужой</p><style>.a{color:red}</style><script>alert(1)</script>',
  );
  const json = JSON.stringify(editor.getJSON());
  expect(json).toContain('чужой'); // страж вакуумности: вставка вообще случилась
  expect(json).not.toContain('color:red');
  expect(json).not.toContain('alert(1)');
});

// --- приезд чужой версии документа ПОД ФОКУСОМ ---------------------------------------------

/** Экран, у которого документ подменяется кнопкой — так выглядит рефетч с чужим телом. */
function DocSwapper({
  first,
  second,
  focusAt,
  onChange,
}: {
  first: string;
  second: string;
  focusAt?: { left: number; top: number };
  onChange: (doc: ReturnType<typeof parseBody>) => void;
}) {
  const [doc, setDoc] = useState(() => parseBody(first));
  return (
    <>
      <button type="button" data-testid="push-doc" onClick={() => setDoc(parseBody(second))}>
        приехало извне
      </button>
      <BodyEditor doc={doc} onChange={onChange} focusAt={focusAt} />
    </>
  );
}

test('чужая правка доезжает в НЕТРОНУТЫЙ редактор, даже если он в фокусе', async () => {
  // Страж подмены смотрит на «человек уже набирал», а не на один фокус, и различать их
  // пришлось из-за находки 2: пока клик по телу редактор не фокусировал, признаки совпадали по
  // совпадению. Оставь тут голое `isFocused` — и чужая правка переставала бы доезжать до
  // редактора, в котором не набрали ни буквы (ровно это ловят два теста detail.test.tsx).
  const onChange = vi.fn();
  renderWithProviders(
    <DocSwapper first="тело" second="извне" focusAt={{ left: 10, top: 10 }} onChange={onChange} />,
    handler,
  );
  await screen.findByTestId('body-editor');
  await waitFor(() => expect(document.activeElement).toBe(field())); // страж: фокус ВЗЯТ
  fireEvent.click(screen.getByTestId('push-doc'));
  await waitFor(() => expect(screen.getByTestId('body-editor')).toHaveTextContent('извне'));
  // Подмена — не правка: наружу она не уезжает, иначе чужое тело вернулось бы в базу.
  expect(onChange).not.toHaveBeenCalled();
});

test('а вот НАБРАННОЕ чужая правка не затирает — даже придя следом', async () => {
  // Положительный контроль к тесту выше и вторая сторона той же границы: подмена под руками —
  // потеря написанного, и её страж обязан ловить.
  const onChange = vi.fn();
  renderWithProviders(
    <DocSwapper first="тело" second="извне" focusAt={{ left: 10, top: 10 }} onChange={onChange} />,
    handler,
  );
  await screen.findByTestId('body-editor');
  await waitFor(() => expect(document.activeElement).toBe(field()));
  await userEvent.keyboard(' и хвост');
  await waitFor(() => expect(onChange).toHaveBeenCalled()); // страж: набор ДОЕХАЛ

  fireEvent.click(screen.getByTestId('push-doc'));
  // Даём подмене шанс случиться: «не затёрло» обязано значить «не затрёт», а не «не дождались».
  await new Promise((r) => setTimeout(r, 60));
  expect(screen.getByTestId('body-editor')).toHaveTextContent('и хвост');
  expect(screen.getByTestId('body-editor')).not.toHaveTextContent('извне');
});

// --- StrictMode (итоговое ревью, мелкая находка) -------------------------------------------

test('под StrictMode редактор поднимается целым: NodeViewʼы, оба меню и панель', async () => {
  // Приложение в разработке живёт под StrictMode (main.tsx), и именно двойной прогон эффектов
  // потребовал стража `editor.isDestroyed` в BodyEditor. До сих пор под ним не гонялся ни один
  // тест редактора — то есть монтирование NodeViewʼов, двух suggestion-плагинов и всплывающей
  // панели под двойным прогоном не проверяло ничто.
  const onChange = vi.fn();
  const h = held();
  const md = `текст [[entity:${KUPIT}|Купить]]\n\n{{query: aspect=orbis/task}}`;
  renderWithProviders(
    <BodyEditor doc={parseBody(md)} onChange={onChange} onReady={(e) => (h.editor = e)} />,
    handler,
    { strict: true },
  );
  await screen.findByTestId('body-editor');
  await waitFor(() => expect(h.editor).not.toBeNull());
  const editor = h.editor as Editor;
  // Экземпляр ЖИВОЙ. Двойной прогон РЕНДЕРА создаёт два редактора, и один из них тут же
  // сносится; `onReady` обязан отдать уцелевший, иначе всякий тест под StrictMode получал бы
  // редактор с `view === null` и падал на первой же команде (замерено).
  expect(editor.isDestroyed).toBe(false);
  await new Promise((r) => setTimeout(r, 50));

  // NodeViewʼы смонтированы по ОДНОМУ разу, а не по два.
  expect(screen.getAllByTestId('entity-chip')).toHaveLength(1);
  expect(screen.getAllByTestId('qb-count')).toHaveLength(1);
  expect(screen.getAllByTestId('body-editor')).toHaveLength(1);

  // Оба suggestion-плагина живы: меню открывается набором и закрывается по Esc.
  const area = screen.getByTestId('body-editor').querySelector('[contenteditable]') as HTMLElement;
  await userEvent.click(area);
  editor.commands.focus(1);
  await userEvent.keyboard(' /');
  await screen.findByTestId('slash-menu');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByTestId('slash-menu')).toBeNull());

  // Панель выделения тоже: она — ProseMirror-плагин поверх готового вида.
  editor.commands.setTextSelection({ from: 1, to: 5 });
  await screen.findByTestId('bubble-toolbar', {}, { timeout: 2000 });

  // И правка доезжает наружу — редактор не «тихо мёртв».
  expect(onChange).toHaveBeenCalled();
});

// --- И4/И5/И6: двухфазность --------------------------------------------------------------

const ALL_TASKS = SEED_SMART_LISTS.find((s) => s.slug === 'all-tasks');

test('первый кадр рисует ЖИВЫЕ виджеты, а не текст {{query:…}}', async () => {
  // У сида All Tasks тело — ровно один блок: голый <Markdown> в первом кадре показал бы
  // фигурные скобки, которые через мгновение прыгнули бы на виджет (ревью И4).
  const md = ALL_TASKS?.body ?? '';
  // requestIdleCallback, которого никто не дёрнет: редактор не должен встать сам собой и
  // подменить собой то, что мы проверяем.
  vi.stubGlobal('requestIdleCallback', () => 1);
  renderWithProviders(
    <EditorShell doc={parseBody(md)} markdown={md} onChange={vi.fn()} />,
    handler,
  );
  expect(screen.queryByText(/\{\{query:/)).toBeNull();
  expect(screen.queryByTestId('body-editor')).toBeNull();
  // Виджет именно ЖИВОЙ: счётчик появляется только после каталога полей и entity.query.
  await screen.findByTestId('qb-count');
  expect(screen.queryByTestId('qb-error')).toBeNull();
  expect(screen.getByText('Все незакрытые задачи')).toBeInTheDocument();
});

// Тело со ВСЕМИ тремя видами того, по чему кликают не ради правки: ссылка в разметке,
// живой виджет и просто текст. Простоя в этих тестах нет — монтирует только клик, поэтому
// «редактор не встал» значит «страж сработал», а не «мы не дождались».
const GUARDED_BODY = 'смотри [ссылку](https://example.com) тут\n\n{{query: aspect=orbis/task}}';

const shell = () => (
  <EditorShell doc={parseBody(GUARDED_BODY)} markdown={GUARDED_BODY} onChange={vi.fn()} />
);

/**
 * Отрицательный ассерт «редактор не встал» честен только если он УСПЕЛ БЫ встать. Поэтому
 * здесь сперва прогон вхолостую: смонтировать редактор кликом, дождаться и снести. Он греет
 * и ленивый модуль, и первую (самую дорогую) сборку схемы ProseMirror — без него первый в
 * файле клик не укладывается в паузу отрицательного ассерта, и тест «клик по ссылке ничего
 * не монтирует» проходил, даже когда стража не было вовсе (проверено снятием стражей).
 */
async function renderGuarded() {
  vi.stubGlobal('requestIdleCallback', () => 1);
  const warmup = renderWithProviders(shell(), handler);
  fireEvent.click(await warmup.findByTestId('editor-preview'));
  await warmup.findByTestId('body-editor');
  warmup.unmount();

  const r = renderWithProviders(shell(), handler);
  await screen.findByTestId('qb-count'); // виджет ожил — дерево первого кадра целиком на месте
  expect(screen.queryByTestId('body-editor')).toBeNull();
  return r;
}

/** Положительный контроль: тем же жестом по пустому месту тела редактор ВСТАЁТ. Без него
 *  отрицательный ассерт зелен и на наглухо сломанном первом кадре. */
async function expectStillMountable() {
  fireEvent.click(screen.getByTestId('editor-preview'));
  await screen.findByTestId('body-editor');
}

test('касание тела монтирует редактор сразу, не дожидаясь простоя', async () => {
  await renderGuarded();
  fireEvent.click(screen.getByTestId('editor-preview'));
  await screen.findByTestId('body-editor');
});

test('клик по ссылке в теле редактор НЕ монтирует', async () => {
  // Иначе переход по ссылке не срабатывает вовсе: подмена первого кадра редактором меняет
  // корень поддерева, и click до самой ссылки не доезжает (тот же довод, что у
  // DetailScreen.startEditing).
  await renderGuarded();
  fireEvent.click(screen.getByRole('link', { name: 'ссылку' }));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByTestId('body-editor')).toBeNull();
  expect(screen.getByTestId('editor-preview')).toBeInTheDocument();
  await expectStillMountable();
});

test('клик по живому виджету редактор НЕ монтирует', async () => {
  // У All Tasks весь body — один блок: подмена его редактором роняла бы экран смарт-листа
  // от случайного клика по строке списка.
  await renderGuarded();
  fireEvent.click(screen.getByTestId('qb-count'));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByTestId('body-editor')).toBeNull();
  await expectStillMountable();
});

test('клик при непустом выделении редактор НЕ монтирует', async () => {
  // Текст выделяют, чтобы скопировать: подмена первого кадра редактором выделение теряет.
  await renderGuarded();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(screen.getByTestId('editor-preview'));
  selection?.removeAllRanges();
  selection?.addRange(range);
  expect(selection?.isCollapsed).toBe(false); // страж вакуумности: выделение реально есть
  fireEvent.click(screen.getByTestId('editor-preview'));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByTestId('body-editor')).toBeNull();
  selection?.removeAllRanges(); // выделение снято — тот же жест обязан сработать
  await expectStillMountable();
});

test('фокус на ссылке тела редактор НЕ монтирует — иначе фокус пропадает', async () => {
  // Монтирование по onFocus (первая редакция) было ловушкой для клавиатуры: фокусируемое в
  // первом кадре — только ссылки и кнопки виджетов, то есть onFocus срабатывал БЕЗ ИСКЛЮЧЕНИЙ
  // на них, подменял дерево и терял фокус вместе со ссылкой, до которой человек дошёл табом.
  // Клавиатурного пути этим не отняли: редактор всё равно встаёт по простою.
  await renderGuarded();
  const link = screen.getByRole('link', { name: 'ссылку' });
  link.focus();
  fireEvent.focus(link);
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByTestId('body-editor')).toBeNull();
  expect(document.activeElement).toBe(link); // фокус остался там, куда его довели табом
  await expectStillMountable();
});

test('пустое тело: первый кадр рисует приглашение, а не пустую коробку', async () => {
  vi.stubGlobal('requestIdleCallback', () => 1);
  renderWithProviders(<EditorShell doc={parseBody('')} markdown="" onChange={vi.fn()} />, handler);
  expect(screen.getByText(BODY_PLACEHOLDER)).toBeInTheDocument();
});

test('тело из одного смарт-листа приглашения НЕ показывает', async () => {
  // Текста нет, но смотреть есть на что: «Заметки…» печатались бы над живым списком задач
  // (тот же довод, что в DetailScreen).
  const md = ALL_TASKS?.body ?? '';
  vi.stubGlobal('requestIdleCallback', () => 1);
  renderWithProviders(
    <EditorShell doc={parseBody(md)} markdown={md} onChange={vi.fn()} />,
    handler,
  );
  await screen.findByTestId('qb-count');
  expect(screen.queryByText(BODY_PLACEHOLDER)).toBeNull();
});

test('простой монтирует редактор без всякого касания', async () => {
  const md = ALL_TASKS?.body ?? '';
  const idle = vi.fn((cb: () => void) => {
    setTimeout(cb, 0);
    return 1;
  });
  vi.stubGlobal('requestIdleCallback', idle);
  renderWithProviders(
    <EditorShell doc={parseBody(md)} markdown={md} onChange={vi.fn()} />,
    handler,
  );
  await screen.findByTestId('body-editor');
  expect(idle).toHaveBeenCalled();
});

test('после раскрытия Suspense в редактор МОЖНО НАБИРАТЬ, а не только смотреть', async () => {
  // Долг Задачи 7. В BodyEditor стоит страж `editor.isDestroyed`: он гасит крах эффекта,
  // который React 19 переигрывает при раскрытии Suspense (reconnectPassiveEffects). Цена
  // стража — тихо мёртвый редактор, если экземпляр однажды перестанет пересоздаваться:
  // `findByTestId('body-editor')` останется зелёным, а набор не доедет никуда. Все прочие
  // тесты файла ходят либо мимо Suspense (BodyEditor напрямую), либо только смотрят.
  const onChange = vi.fn();
  vi.stubGlobal('requestIdleCallback', () => 1);
  renderWithProviders(
    <EditorShell doc={parseBody('начало')} markdown="начало" onChange={onChange} />,
    handler,
  );
  fireEvent.click(await screen.findByTestId('editor-preview'));
  // Ждём именно ПОЛЕ ВВОДА, и запрашиваем коробку каждый раз заново: EditorContent
  // перемонтируется, когда useEditor отдаёт экземпляр (у него key, завязанный на editor),
  // поэтому первая найденная коробка к этому моменту уже оторвана от документа.
  await screen.findByTestId('body-editor');
  const field = () => screen.getByTestId('body-editor').querySelector('[contenteditable]');
  await waitFor(() => expect(field()).not.toBeNull());
  const area = field() as HTMLElement;
  await userEvent.click(area);
  await userEvent.type(area, ' и хвост');
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(serializeBody(onChange.mock.calls.at(-1)?.[0])).toContain('и хвост');
});

// --- фокус при монтировании (итоговое ревью, находка 2) -----------------------------------

/** Поле ввода редактора — запрашивается заново: EditorContent перемонтируется вместе с ним. */
const field = () => screen.getByTestId('body-editor').querySelector('[contenteditable]');

test('первый клик по телу ставит каретку: набор доезжает БЕЗ второго клика', async () => {
  // Клик поднимал редактор, но каретку не ставил — фокус оставался на <body>. Пока едет
  // ленивый чанк, на экране висит предпросмотр, то есть целевого поля ввода в момент клика нет
  // вовсе, и браузерное «клик поставил каретку» тут не помощник: первый клик уходил впустую,
  // набранное не появлялось нигде, а на планшете не поднималась экранная клавиатура.
  vi.stubGlobal('requestIdleCallback', () => 1);
  const onChange = vi.fn();
  renderWithProviders(
    <EditorShell doc={parseBody('начало')} markdown="начало" onChange={onChange} />,
    handler,
  );
  fireEvent.click(await screen.findByTestId('editor-preview'), { clientX: 120, clientY: 240 });
  await screen.findByTestId('body-editor');
  await waitFor(() => expect(field()).not.toBeNull());
  // Фокус берётся ОТЛОЖЕННО: команда `focus` у Tiptap уходит в requestAnimationFrame.
  await waitFor(() => expect(document.activeElement).toBe(field()));
  // И это не только activeElement: набор доезжает в документ без единого лишнего жеста.
  await userEvent.keyboard(' и хвост');
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(serializeBody(onChange.mock.calls.at(-1)?.[0])).toContain('и хвост');
});

test('каретка встаёт ТУДА, КУДА ткнули, а не в начало тела', async () => {
  // Голый фокус уложил бы каретку в начало документа: ткнув в конец длинной записи, человек
  // получил бы курсор на первой строке. Координаты клика едут в редактор и разрешаются
  // `view.posAtCoords`. В jsdom геометрии нет вовсе (elementFromPoint отдаёт null,
  // tests/prosemirror-polyfill.ts), поэтому разрешение подменено на прототипе: проверяется
  // ПРОВОДКА координат, а не измерение — измерять в jsdom нечего.
  vi.stubGlobal('requestIdleCallback', () => 1);
  const posAtCoords = vi
    .spyOn(EditorView.prototype, 'posAtCoords')
    .mockReturnValue({ pos: 4, inside: -1 });
  const onChange = vi.fn();
  renderWithProviders(
    <EditorShell doc={parseBody('начало')} markdown="начало" onChange={onChange} />,
    handler,
  );
  fireEvent.click(await screen.findByTestId('editor-preview'), { clientX: 120, clientY: 240 });
  await screen.findByTestId('body-editor');
  await waitFor(() => expect(field()).not.toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(field()));
  // Спрошено ИМЕННО про точку клика, а не про какую-нибудь свою.
  expect(posAtCoords).toHaveBeenCalledWith({ left: 120, top: 240 });

  await userEvent.keyboard('X');
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  // Позиция 4 — середина слова «начало»: буква легла ТУДА, а не в начало и не в конец.
  expect(serializeBody(onChange.mock.calls.at(-1)?.[0])).toContain('начXало');
});

test('монтирование ПО ПРОСТОЮ фокус не забирает — он мог быть в чужом поле', async () => {
  // Простой наступает сам собой, в том числе пока человек пишет в другом поле экрана
  // (заголовок, поиск). Забрать фокус там значило бы вырвать набор из-под рук.
  const outside = document.createElement('input');
  outside.setAttribute('data-testid', 'outside');
  document.body.appendChild(outside);
  try {
    const idle = vi.fn((cb: () => void) => {
      setTimeout(cb, 0);
      return 1;
    });
    vi.stubGlobal('requestIdleCallback', idle);
    renderWithProviders(
      <EditorShell doc={parseBody('начало')} markdown="начало" onChange={vi.fn()} />,
      handler,
    );
    outside.focus();
    expect(document.activeElement).toBe(outside); // страж вакуумности: фокус реально снаружи
    await screen.findByTestId('body-editor');
    await waitFor(() => expect(field()).not.toBeNull());
    await new Promise((r) => setTimeout(r, 80)); // дольше, чем кадр отложенного фокуса
    expect(document.activeElement).toBe(outside);

    // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: фокус этот редактор ПРИНИМАЕТ — он его просто не
    // забирает. Без контроля «фокус не увели» было бы правдой и у мёртвой коробки.
    await userEvent.click(field() as HTMLElement);
    expect(document.activeElement).toBe(field());
  } finally {
    outside.remove();
  }
});

test('без requestIdleCallback редактор встаёт по запасному таймеру', async () => {
  // jsdom и Safari живут без requestIdleCallback; setTimeout(0) из v1 тянул чанк ~160 kB при
  // КАЖДОМ чисто читательском открытии, поэтому запасной путь — заметная задержка, а не ноль.
  const md = ALL_TASKS?.body ?? '';
  expect((window as { requestIdleCallback?: unknown }).requestIdleCallback).toBeUndefined();
  renderWithProviders(
    <EditorShell doc={parseBody(md)} markdown={md} onChange={vi.fn()} />,
    handler,
  );
  expect(screen.queryByTestId('body-editor')).toBeNull();
  await waitFor(() => expect(screen.getByTestId('body-editor')).toBeInTheDocument(), {
    timeout: 3000,
  });
});

test('без документа редактор не встаёт ВООБЩЕ — ни по касанию, ни по простою', async () => {
  // `doc === null` — «документа нет» (в wire-схеме `bodyDoc` и опционален, и nullable).
  // Подставить вместо него пустышку нельзя: редактор выглядел бы стёртым телом, а первое же
  // нажатие клавиши отправило бы эту пустоту в базу поверх настоящего текста. Тело при этом
  // остаётся читаемым — первый кадр рисуется из markdown.
  const md = ALL_TASKS?.body ?? '';
  const empty = renderWithProviders(
    <EditorShell doc={null} markdown={md} onChange={vi.fn()} />,
    handler,
  );
  await screen.findByTestId('qb-count'); // первый кадр жив, и виджеты в нём настоящие
  fireEvent.click(screen.getByTestId('editor-preview'));
  // Ждём ДОЛЬШЕ запасного таймера простоя (1500 мс): «не встал» обязано значить «не встанет»,
  // а не «мы не дождались».
  await new Promise((r) => setTimeout(r, 1800));
  expect(screen.queryByTestId('body-editor')).toBeNull();
  expect(screen.getByTestId('editor-preview')).toBeInTheDocument();
  empty.unmount(); // иначе два первых кадра на странице разом, и запросы ниже неоднозначны

  // Положительный контроль: с документом тот же жест редактор поднимает — иначе отрицательный
  // ассерт был бы зелен и у наглухо сломанного EditorShell.
  renderWithProviders(
    <EditorShell doc={parseBody(md)} markdown={md} onChange={vi.fn()} />,
    handler,
  );
  fireEvent.click(await screen.findByTestId('editor-preview'));
  await waitFor(() => expect(screen.getByTestId('body-editor')).toBeInTheDocument(), {
    timeout: 3000,
  });
});
