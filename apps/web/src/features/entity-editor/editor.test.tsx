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
  expect(serializeBody(onChange.mock.calls.at(-1)?.[0])).toContain(
    '{{query: aspect=orbis/task, status=inbox}}',
  );
});

// --- Б5: белый список протоколов --------------------------------------------------------

test('setLink с javascript: отвергается, https: проходит', async () => {
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
  expect(h.editor?.commands.setLink({ href: 'https://example.com' })).toBe(true);
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

test('вставка через ProseMirror идёт тем же путём: абзацы остаются абзацами', async () => {
  // ClipboardEvent в jsdom нет вовсе, а без него не позвать view.pasteHTML. Заглушка местная:
  // проверяем ПРОВОДКУ transformPastedHTML в editorProps, а не сам буфер обмена.
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
  h.editor?.view.pasteHTML('<style>.a{color:red}</style><p>первый</p><p>второй</p>');
  const text = h.editor?.getText() ?? '';
  expect(text).toContain('первый');
  expect(text).toContain('второй');
  expect(text).not.toContain('color:red');
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

test('касание тела монтирует редактор сразу, не дожидаясь простоя', async () => {
  const md = ALL_TASKS?.body ?? '';
  vi.stubGlobal('requestIdleCallback', () => 1); // простоя не будет — монтирует только касание
  renderWithProviders(
    <EditorShell doc={parseBody(md)} markdown={md} onChange={vi.fn()} />,
    handler,
  );
  await screen.findByTestId('qb-count');
  expect(screen.queryByTestId('body-editor')).toBeNull();
  fireEvent.pointerDown(screen.getByTestId('editor-preview'));
  await screen.findByTestId('body-editor');
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
