import { SEED_SMART_LISTS } from '@orbis/server/src/seed/smart-lists';
import { aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { DOC_EXTENSIONS, parseBody, serializeBody } from '@orbis/shared/doc';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getSchema } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { BodyEditor, htmlToPlainParagraphs } from './BodyEditor';
import { BODY_PLACEHOLDER } from './body-box';
import { EditorShell } from './EditorShell';
import { EDITOR_EXTENSIONS } from './extensions';

// Реестр аспектов — настоящий (как в detail.test.tsx): с пустым каталогом любой блок падал бы
// плашкой qb-error, и «первый кадр рисует виджет» проходило бы по ложной причине.
const realAspects = BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) }));
const handler = (path: string) => {
  if (path === 'aspect.list') return realAspects;
  if (path === 'entity.query') return [];
  return {};
};

// Держатель, а не `let editor: Editor | null`: после присваивания в колбэке TS сужает
// переменную до null и каждое обращение приходится глушить `!`.
type Held = { editor: Editor | null };
const held = (): Held => ({ editor: null });

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  // UniqueID проставляет id транзакцией после монтирования (гасится stripIds-сравнением).
  const onChange = vi.fn();
  const h = held();
  const md = 'текст\n\n{{query: aspect=orbis/task, status=inbox}}'; // кончается блоком — худший случай
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
  const md = 'привет\n\n{{query: aspect=orbis/task, status=inbox}}';
  renderWithProviders(
    <BodyEditor doc={parseBody(md)} onChange={onChange} onReady={(e) => (h.editor = e)} />,
    handler,
  );
  const area = (await screen.findByTestId('body-editor')).querySelector('[contenteditable]');
  await waitFor(() => expect(h.editor).not.toBeNull());
  h.editor?.commands.focus('start');
  await userEvent.type(area as HTMLElement, '!');
  await waitFor(() => expect(onChange).toHaveBeenCalled());

  // Проверка по ФОРМЕ ДОКУМЕНТА, а не по markdown-проекции: абзац с буквальным текстом
  // `{{query:…}}` сериализуется в ровно ту же строку (это закреплено convert.test.ts —
  // «обёртка не с колонки 1 блоком не считается», где канон литерала равен входу), поэтому
  // `toContain('{{query: …}}')` оставался бы зелёным и при схлопывании блока в текст.
  const next = onChange.mock.calls.at(-1)?.[0] as { doc: { content?: { type: string }[] } };
  expect(next.doc.content?.map((n) => n.type)).toEqual(['paragraph', 'queryBlock']);
  expect(serializeBody(next)).toContain('{{query: aspect=orbis/task, status=inbox}}');
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
  class FakeClipboardEvent extends Event {
    clipboardData: unknown = null;
  }
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
