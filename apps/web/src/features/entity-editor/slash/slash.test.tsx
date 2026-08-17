import { aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { DOC_EXTENSIONS, parseBody } from '@orbis/shared/doc';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getSchema } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { afterEach, expect, test, vi } from 'vitest';
import { installCrashTrap, renderWithProviders, trpcError } from '../../../test/harness';
import { Toaster } from '../../../ui/Toast';
import { BodyEditor } from '../BodyEditor';
import { BODY_PLACEHOLDER } from '../body-box';
import { EditorShell } from '../EditorShell';
import { EDITOR_EXTENSIONS } from '../extensions';
import { NEW_QUERY_BLOCK, SLASH_ITEMS } from './items';
import { suggestionExtensions } from './suggestion';

// Реестр аспектов — настоящий (как в editor.test.tsx и query-widget.test.tsx): с пустым
// каталогом ЛЮБОЙ блок падал бы плашкой qb-error, и «смарт-лист встал живым» проходило бы
// по ложной причине.
const realAspects = BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) }));

type Suggestion = { id: string; title: string; emoji: string | null; status: string | null };
const suggestion = (id: string, title: string): Suggestion => ({
  id,
  title,
  emoji: null,
  status: null,
});

const KUPIT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NEW_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * СТРОГИЙ мок: `entity.suggest` отвечает ТОЛЬКО про тот `term`, о котором спросили, и только
 * если спросили именно полем `term`. Щедрый мок (отдающий список на что угодно) сделал бы
 * неотличимыми правильный вызов и вызов с полем `prefix`/`query` — контракт переименовали
 * коммитом 6df313f, и тест обязан ловить возврат старого имени.
 *
 * `entity.query` тоже отвечает по спрошенному запросу: виджет со СТАРЫМ атрибутом иначе был
 * бы неотличим от виджета с новым (тот же приём, что в query-widget.test.tsx).
 */
const api =
  (opts: {
    byTerm?: Record<string, Suggestion[]>;
    byQuery?: Record<string, { id: string; title: string }[]>;
    created?: { id: string; title: string };
    createFails?: boolean;
  }) =>
  (path: string, input: unknown): unknown => {
    if (path === 'aspect.list') return realAspects;
    if (path === 'entity.query') return opts.byQuery?.[(input as { query: string }).query] ?? [];
    if (path === 'entity.suggest') {
      const term = (input as { term?: unknown }).term;
      if (typeof term !== 'string') throw trpcError('BAD_REQUEST', 'ожидалось поле term');
      return opts.byTerm?.[term] ?? [];
    }
    if (path === 'entity.resolveRefs') {
      const ids = new Set((input as { ids: string[] }).ids);
      const rows = [
        ...Object.values(opts.byTerm ?? {}).flat(),
        ...(opts.created ? [suggestion(opts.created.id, opts.created.title)] : []),
      ];
      return rows.filter((r) => ids.has(r.id)).map((r) => ({ ...r, archived: false }));
    }
    if (path === 'entity.create') {
      if (opts.createFails) throw trpcError('BAD_REQUEST', 'создание не удалось');
      const title = (input as { input: { title: string } }).input.title;
      return { id: opts.created?.id ?? NEW_ID, title };
    }
    return {};
  };

type Held = { editor: Editor | null };

/**
 * Редактор с телом `md`, каретка в КОНЦЕ текста.
 *
 * Набирают тесты через `userEvent.keyboard`, а не через `userEvent.type(area, …)`: `type()`
 * перед вводом КЛИКАЕТ, а клик по contenteditable jsdom разрешает по геометрии, которой нет
 * (все прямоугольники нулевые, elementFromPoint отдаёт null — tests/prosemirror-polyfill.ts),
 * и каретка каждый раз укладывается в НАЧАЛО абзаца. Замерено: `type(area, ' /заг')` по телу
 * «привет» даёт текст « /загпривет». Тесту про вставку «в позицию каретки» такая адресация
 * не годится вовсе — она проверяла бы вставку в начало. `keyboard()` печатает в то, что
 * сфокусировано, и оставляет позицию за `commands.focus`.
 */
async function mountEditor(md: string, handler: (p: string, i: unknown) => unknown) {
  const onChange = vi.fn();
  const h: Held = { editor: null };
  const r = renderWithProviders(
    <>
      <BodyEditor
        doc={parseBody(md)}
        onChange={onChange}
        onReady={(e) => {
          h.editor = e;
        }}
      />
      <Toaster />
    </>,
    handler,
  );
  await waitFor(() => expect(h.editor).not.toBeNull());
  const area = (await screen.findByTestId('body-editor')).querySelector(
    '[contenteditable]',
  ) as HTMLElement;
  // Клик — ОДИН раз и здесь, и он нужен ради ФОКУСА, а не сам по себе: `userEvent.keyboard`
  // печатает в `document.activeElement`, и без фокуса набор не доезжает никуда. Прежняя
  // запись этого замера («без клика user-event не вставляет в contenteditable вовсе») мерила
  // не то: после НАСТОЯЩЕГО фокуса — `commands.focus()` плюс кадр, который тот ждёт через
  // requestAnimationFrame, — набор доезжает и без единого клика (перемерено ре-ревью пакета B;
  // на этом стоят тесты фокуса в editor.test.tsx). Клик оставлен потому, что он короче
  // ожидания кадра. Он же укладывает каретку в начало, поэтому позицию задаём СЛЕДОМ,
  // командой редактора.
  await userEvent.click(area);
  h.editor?.commands.focus('end');
  return { r, h, onChange, area };
}

/**
 * Inline-дети первого абзаца. Отдельным помощником, потому что `JSONContent` у Tiptap —
 * объединение с текстовым узлом, у которого `attrs` нет вовсе, и обращение к нему по месту
 * не проходит проверку типов.
 */
function inline(editor: Editor | null): { type?: string; attrs?: Record<string, unknown> }[] {
  const first = editor?.getJSON().content?.[0] as
    | { content?: { type?: string; attrs?: Record<string, unknown> }[] }
    | undefined;
  return first?.content ?? [];
}

/** Текст блока верхнего уровня по номеру — та же причина отдельного помощника, что у `inline`. */
function blockText(editor: Editor | null, index: number): string | undefined {
  const block = editor?.getJSON().content?.[index] as { content?: { text?: string }[] } | undefined;
  return block?.content?.[0]?.text;
}

const rows = () => screen.getAllByRole('option').map((o) => o.textContent ?? '');
const activeRow = () =>
  screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')
    ?.textContent ?? null;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Клавиатура меню и вставка идут через обработчики событий: крах там не роняет тест, а только
// код возврата прогона. Ставится файлом, не глобально: см. harness.
installCrashTrap();

// --- инвариант: ноды и марки редактора ⊆ DOC_EXTENSIONS -----------------------------------

test('плейсхолдер и suggestion не приносят редактору ни одной ноды и марки', () => {
  // Серверный путь записи спрашивает схему документа напрямую: НОДОВОЕ или МАРОЧНОЕ
  // расширение, добавленное только в редактор, сделает нерабочим КАЖДОЕ сохранение — не
  // одно, а все. Плейсхолдер и suggestion по замыслу плагины/декорации, но «по замыслу» тут
  // не довод: проверяем ЗАПУСКОМ, на том же составе, что уходит в useEditor.
  const doc = getSchema(DOC_EXTENSIONS as never);
  const full = getSchema([
    ...EDITOR_EXTENSIONS,
    ...suggestionExtensions({ onOpen: () => {}, onClose: () => {}, onKeyDown: () => false }),
  ] as never);
  expect(Object.keys(full.nodes).sort()).toEqual(Object.keys(doc.nodes).sort());
  expect(Object.keys(full.marks).sort()).toEqual(Object.keys(doc.marks).sort());
  // Страж вакуумности: сверять действительно есть что — оба расширения в составе.
  const names = EDITOR_EXTENSIONS.map((e) => (e as { name: string }).name);
  expect(names).toContain('placeholder');
  expect(
    suggestionExtensions({ onOpen: () => {}, onClose: () => {}, onKeyDown: () => false }),
  ).toHaveLength(2);
});

test('схема ЖИВОГО редактора совпадает со схемой документа', async () => {
  // То же самое, но на настоящем экземпляре: массив констант мог бы разойтись с тем, что
  // BodyEditor в действительности отдаёт useEditor (suggestion-расширения он собирает сам).
  const { h } = await mountEditor('привет', api({}));
  const doc = getSchema(DOC_EXTENSIONS as never);
  expect(Object.keys(h.editor?.schema.nodes ?? {}).sort()).toEqual(Object.keys(doc.nodes).sort());
  expect(Object.keys(h.editor?.schema.marks ?? {}).sort()).toEqual(Object.keys(doc.marks).sort());
  // Страж вакуумности: suggestion-расширения в живом редакторе ЕСТЬ (иначе равенство схем
  // ничего не утверждает — оно верно и у редактора без меню вовсе).
  const live = h.editor?.extensionManager.extensions.map((e) => e.name) ?? [];
  expect(live).toContain('orbisSlash');
  expect(live).toContain('orbisMention');
});

// --- `/`: открытие и фильтрация ------------------------------------------------------------

test('«/» открывает меню, «/заг» фильтрует его до заголовков', async () => {
  const { h } = await mountEditor('привет', api({}));
  await userEvent.keyboard(' /');
  await screen.findByTestId('slash-menu');
  // Страж вакуумности: без фильтра в меню весь список, и «фильтрует» есть с чего проверять.
  expect(rows()).toHaveLength(SLASH_ITEMS.length);
  expect(rows().length).toBeGreaterThan(3);

  await userEvent.keyboard('заг');
  await waitFor(() => expect(rows()).toEqual(['Заголовок 1', 'Заголовок 2', 'Заголовок 3']));

  // Отфильтрованный список ДЕЙСТВУЮЩИЙ, и мышью тоже: меню зовут набором, но выбрать строку
  // указателем — законный путь, а он идёт через другой обработчик (onMouseDown, а не
  // клавиатурный хендлер). Без этого «фильтрует» было бы правдой и у нажимаемого списка
  // картинок.
  fireEvent.mouseDown(screen.getAllByRole('option')[1] as HTMLElement);
  await waitFor(() => expect(h.editor?.getJSON().content?.map((n) => n.type)).toEqual(['heading']));
  expect(h.editor?.getJSON().content?.[0]?.attrs?.level).toBe(2);
});

test('Esc закрывает меню, «/» остаётся текстом', async () => {
  const { h, onChange } = await mountEditor('привет', api({}));
  await userEvent.keyboard(' /заг');
  await screen.findByTestId('slash-menu');

  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByTestId('slash-menu')).toBeNull());
  // Документ не тронут: закрытие меню — не правка. Проверка по ФОРМЕ и тексту, а не по
  // отсутствию меню: `exitSuggestion` обязан снять декорацию, не трогая документ.
  expect(h.editor?.getJSON().content?.map((n) => n.type)).toEqual(['paragraph']);
  expect(h.editor?.getText()).toBe('привет /заг');

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: механизм жив — новый «/» снова открывает меню.
  // Без него «меню закрылось» было бы правдой и у меню, которое не открывается никогда.
  await userEvent.keyboard(' /');
  await screen.findByTestId('slash-menu');
  expect(onChange).toHaveBeenCalled(); // набор — правка, и она доехала
});

// --- `/`: пункты меняют документ ------------------------------------------------------------

test('«Заголовок 1» превращает абзац в heading, а «/заг» съедает', async () => {
  const { h } = await mountEditor('привет', api({}));
  await userEvent.keyboard(' /заг');
  await screen.findByTestId('slash-menu');
  expect(activeRow()).toBe('Заголовок 1');

  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByTestId('slash-menu')).toBeNull());
  // Ассерт по ФОРМЕ документа: markdown-проекция абзаца с литералом `# …` дала бы ту же
  // строку, и `toContain('# привет')` был бы зелен и без всякого heading.
  const json = h.editor?.getJSON();
  expect(json?.content?.map((n) => n.type)).toEqual(['heading']);
  expect(json?.content?.[0]?.attrs?.level).toBe(1);
  expect(h.editor?.getText()).toBe('привет ');
});

test('«Смарт-лист» вставляет БЛОК в позицию каретки, и он оживает виджетом', async () => {
  // Сегодня вставить `{{query:…}}` из интерфейса нельзя ВОВСЕ: редактор блока открывается
  // только на уже существующем блоке. Это новая возможность, а не перенос.
  const { h } = await mountEditor(
    'привет',
    api({ byQuery: { [NEW_QUERY_BLOCK]: [{ id: 'a', title: 'Разобрать почту' }] } }),
  );
  await userEvent.keyboard(' /смарт');
  await screen.findByTestId('slash-menu');
  expect(rows()).toEqual(['Смарт-листживой список по запросу']);

  await userEvent.keyboard('{Enter}');
  // Ассерт по ФОРМЕ документа: абзац с буквальным `{{query:…}}` сериализуется в ровно ту же
  // строку (convert.test.ts: «обёртка не с колонки 1 блоком не считается»), поэтому
  // `toContain('{{query:')` был бы зелен и при вставке текста вместо блока.
  await waitFor(() =>
    expect(h.editor?.getJSON().content?.map((n) => n.type)).toContain('queryBlock'),
  );
  const types = h.editor?.getJSON().content?.map((n) => n.type) ?? [];
  expect(types[0]).toBe('paragraph');
  expect(types[1]).toBe('queryBlock');
  // Блок ЖИВОЙ: строка списка рисуется только ответом entity.query, а строгий мок отвечает
  // лишь на запрос нового блока.
  expect(await screen.findByTestId('qb-item')).toHaveTextContent('Разобрать почту');
  expect(screen.queryByTestId('qb-error')).toBeNull();
});

test('«Смарт-лист» встаёт ПОСЛЕ абзаца с кареткой, а не в конце документа', async () => {
  // Раунд правок 1 (М-1). На теле из ОДНОГО абзаца ассерт `['paragraph','queryBlock']` не
  // различает вставку в позицию каретки и дописывание в конец документа — оба дают одно и
  // то же. Различает только тело, у которого после каретки ЕЩЁ ЧТО-ТО есть.
  const { h } = await mountEditor('первый\n\nвторой', api({ byQuery: { [NEW_QUERY_BLOCK]: [] } }));
  // Каретка — в конец ПЕРВОГО абзаца: он занимает позиции 1..7 («первый» — шесть символов).
  h.editor?.commands.focus(7);
  await userEvent.keyboard(' /смарт');
  await screen.findByTestId('slash-menu');
  await userEvent.keyboard('{Enter}');

  await waitFor(() =>
    expect(h.editor?.getJSON().content?.map((n) => n.type)).toEqual([
      'paragraph',
      'queryBlock',
      'paragraph',
    ]),
  );
  // Стражи вакуумности: блок — ТОТ САМЫЙ (а не пустая нода), первый абзац лишился `/смарт`,
  // а второй цел и стоит ПОСЛЕ блока. Иначе равенство типов выше можно было бы получить и
  // разрушив документ. Сверка по дереву, а не по `getText()`: queryBlock — атом, и в
  // текстовой проекции он оборачивается разделителями блоков.
  const content = h.editor?.getJSON().content ?? [];
  expect(content[1]?.attrs?.query).toBe(NEW_QUERY_BLOCK);
  expect(blockText(h.editor, 0)).toBe('первый ');
  expect(blockText(h.editor, 2)).toBe('второй');
});

test('«Ссылка на сущность» передаёт набор в `@`-поиск, а не заводит свой пикер', async () => {
  const { h } = await mountEditor(
    'см',
    api({ byTerm: { куп: [suggestion(KUPIT, 'Купить кроссовки')] } }),
  );
  await userEvent.keyboard(' /ссыл');
  await screen.findByTestId('slash-menu');
  expect(rows()).toEqual(['Ссылка на сущностьили @']);

  await userEvent.keyboard('{Enter}');
  // `/ссыл` съеден, на его месте `@` — и это НЕ картинка: следующие буквы уже ищут сущность.
  await waitFor(() => expect(h.editor?.getText()).toBe('см @'));
  await userEvent.keyboard('куп');
  await waitFor(() => expect(rows()[0]).toBe('Купить кроссовки'));

  // Положительный контроль: выбор из этого меню вставляет чип — путь дошёл до конца, а не
  // оборвался на открытом списке.
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(inline(h.editor)[1]?.attrs?.entityId).toBe(KUPIT));
});

test('каждый пункт меню действительно меняет документ', async () => {
  // Пункты — команды самой схемы, и промах мимо неё МОЛЧАЛИВ: `toggleTaskList` без TaskList
  // и `insertTable` без TableKit возвращают false и не делают ничего. Меню при этом
  // открывается, строка подсвечивается, Enter «срабатывает» — и не происходит ничего.
  const { h } = await mountEditor('привет', api({}));
  const editor = h.editor as Editor;
  const before = parseBody('привет').doc;
  for (const item of SLASH_ITEMS) {
    editor.commands.setContent(before, { emitUpdate: false });
    editor.commands.focus('end');
    const start = JSON.stringify(editor.getJSON());
    item.run(editor);
    expect(JSON.stringify(editor.getJSON()), `пункт «${item.label}» ничего не сделал`).not.toBe(
      start,
    );
  }
  // Страж вакуумности: список не пуст и не схлопнулся до пары строк.
  expect(SLASH_ITEMS.length).toBeGreaterThan(8);
});

// --- блок кода: оба входа молчат (итоговое ревью, находка 3) ---------------------------------

test('внутри блока кода ни «/», ни «@» меню не открывают', async () => {
  // Умолчание `@tiptap/suggestion` — «разрешено всегда», а префиксом служит пробел, поэтому
  // меню открывали самые обычные строки кода: ` /usr/bin`, `a / b`, ` @media`, ` @import`.
  // Цена промаха несоразмерна опечатке: Enter после ` @media` (поиск ничего не нашёл, в меню
  // одна строка «Создать «media»») ЗАВОДИЛ БЫ В ГРАФЕ настоящую сущность и вставлял в блок
  // кода inline-ноду, которой там не место; Enter после одиночного ` /` превращал блок кода в
  // заголовок и съедал набранный хвост.
  const { h } = await mountEditor('привет\n\n```\nкод\n```', api({}));
  const editor = h.editor as Editor;
  editor.commands.focus('end');
  // Страж вакуумности: каретка ДЕЙСТВИТЕЛЬНО в блоке кода, иначе тест ничего не утверждает.
  expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock');

  await userEvent.keyboard(' @media');
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByTestId('slash-menu')).toBeNull();
  await userEvent.keyboard(' /');
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByTestId('slash-menu')).toBeNull();
  // Набранное осталось КОДОМ: молчание меню не значит съеденных букв.
  expect(blockText(editor, 1)).toBe('код @media /');
  expect(editor.getJSON().content?.map((n) => n.type)).toEqual(['paragraph', 'codeBlock']);

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: в обычном абзаце оба входа по-прежнему открывают
  // меню. Без него «меню не открылось» было бы правдой и у наглухо выключенных плагинов.
  editor.commands.focus(7); // конец первого абзаца («привет» — шесть букв)
  await userEvent.keyboard(' /');
  await screen.findByTestId('slash-menu');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByTestId('slash-menu')).toBeNull());
  await userEvent.keyboard(' @куп');
  await screen.findByTestId('slash-menu');
});

// --- `@`: поиск и вставка --------------------------------------------------------------------

test('«@куп» ищет через entity.suggest и вставляет entityRef', async () => {
  const { r, h } = await mountEditor(
    'см',
    api({ byTerm: { куп: [suggestion(KUPIT, 'Купить кроссовки')] } }),
  );
  await userEvent.keyboard(' @куп');
  await screen.findByTestId('slash-menu');
  await waitFor(() => expect(rows()[0]).toBe('Купить кроссовки'));
  // Спрошено ИМЕННО полем `term` и ИМЕННО набранным: строгий мок отдаёт список только на
  // 'куп', поэтому строка выше уже доказывает форму входа, — но вызов сверяем и напрямую.
  expect(r.calls.filter((c) => c.path === 'entity.suggest').map((c) => c.input)).toContainEqual({
    term: 'куп',
  });

  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByTestId('slash-menu')).toBeNull());
  expect(inline(h.editor).map((n) => n.type)).toEqual(['text', 'entityRef', 'text']);
  expect(inline(h.editor)[1]?.attrs?.entityId).toBe(KUPIT);
  // Чип на экране — с актуальным заголовком: вставленная ссылка сразу читается как ссылка.
  expect(await screen.findByTestId('entity-chip')).toHaveTextContent('Купить кроссовки');
});

test('последний пункт создаёт сущность из набранного и тут же ставит чип', async () => {
  // Иначе «упомянуть то, чего ещё нет» требовало бы уйти с экрана и потерять мысль.
  const { r, h } = await mountEditor(
    'см',
    api({ byTerm: {}, created: { id: NEW_ID, title: 'Стирка' } }),
  );
  await userEvent.keyboard(' @Стирка');
  await screen.findByTestId('slash-menu');
  // Совпадений нет — в меню ровно одна строка, и это создание.
  await waitFor(() => expect(rows()).toEqual(['Создать «Стирка»']));

  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(r.calls.some((c) => c.path === 'entity.create')).toBe(true));
  // Форма входа — та, которую принимает роутер: `{input, source}`, а не голая сущность.
  expect(r.calls.find((c) => c.path === 'entity.create')?.input).toEqual({
    input: { title: 'Стирка', tags: [] },
    source: 'ui',
  });
  await waitFor(() => {
    expect(inline(h.editor).map((n) => n.type)).toEqual(['text', 'entityRef', 'text']);
    expect(inline(h.editor)[1]?.attrs?.entityId).toBe(NEW_ID);
  });
  expect(await screen.findByTestId('entity-chip')).toHaveTextContent('Стирка');
});

test('пока поиск не ответил, «Создать» не предлагается — быстрый Enter не заводит дубль', async () => {
  // Иначе Enter, нажатый быстрее ответа сети, молча создавал бы ВТОРУЮ сущность с тем же
  // именем — и человек этого не заметил бы: чип с правильной подписью на экране появился бы.
  let release: (rows: Suggestion[]) => void = () => {};
  const slow = new Promise<Suggestion[]>((res) => {
    release = res;
  });
  const rest = api({});
  const { r, h } = await mountEditor('см', (path, input) =>
    path === 'entity.suggest' ? slow : rest(path, input),
  );
  await userEvent.keyboard(' @Стирка');
  await waitFor(() => expect(rows()).toEqual(['Поиск…']));

  await userEvent.keyboard('{Enter}');
  await new Promise((res) => setTimeout(res, 50));
  expect(r.calls.some((c) => c.path === 'entity.create')).toBe(false);
  // И переносом строки Enter тоже не стал: меню его забрало, документ не тронут.
  expect(h.editor?.getJSON().content).toHaveLength(1);
  expect(h.editor?.getText()).toBe('см @Стирка');

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: ответ приехал — строка создания появилась и
  // работает. Без него ассерты выше зелены и у меню, которое не предлагает создание НИКОГДА.
  release([]);
  await waitFor(() => expect(rows()).toEqual(['Создать «Стирка»']));
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(r.calls.some((c) => c.path === 'entity.create')).toBe(true));
});

test('упавший поиск говорит об этом и тоже не предлагает создание', async () => {
  // Отказ поиска — не повод молча создавать: сущность с таким именем может уже быть, а
  // проверить это сейчас нечем. Тот же довод, что у «Поиск…», только причина другая.
  const rest = api({});
  const { r, h } = await mountEditor('см', (path, input) => {
    if (path === 'entity.suggest') throw trpcError('INTERNAL_SERVER_ERROR');
    return rest(path, input);
  });
  await userEvent.keyboard(' @Стирка');
  await waitFor(() => expect(rows()).toEqual(['Поиск недоступен']));
  await userEvent.keyboard('{Enter}');
  await new Promise((res) => setTimeout(res, 50));
  expect(r.calls.some((c) => c.path === 'entity.create')).toBe(false);
  expect(h.editor?.getText()).toBe('см @Стирка');
});

test('набор во время создания не оставляет хвоста после чипа', async () => {
  // Между выбором строки и вставкой стоит сеть. Диапазон, снятый в момент выбора, к моменту
  // ответа уже не покрывает того, что человек успел дописать, — и дописанное осталось бы
  // висеть ПОСЛЕ чипа обрывком слова.
  let release: (v: { id: string; title: string }) => void = () => {};
  const slow = new Promise<{ id: string; title: string }>((res) => {
    release = res;
  });
  const rest = api({ created: { id: NEW_ID, title: 'Стирка' } });
  const { h } = await mountEditor('см', (path, input) => {
    if (path === 'entity.create') return slow;
    if (path === 'entity.suggest') return [];
    return rest(path, input);
  });
  await userEvent.keyboard(' @Стирка');
  await waitFor(() => expect(rows()).toEqual(['Создать «Стирка»']));
  await userEvent.keyboard('{Enter}');
  await userEvent.keyboard('дв'); // человек продолжил печатать, пока запрос ехал

  release({ id: NEW_ID, title: 'Стирка' });
  await waitFor(() => expect(inline(h.editor)[1]?.attrs?.entityId).toBe(NEW_ID));
  // Проверка по ТЕКСТУ, а не по составу узлов: дописанные буквы слились бы с хвостовым
  // пробелом в ОДИН текстовый узел, и список типов ['text','entityRef','text'] остался бы
  // тем же самым (проверено мутацией — на составе узлов тест не падает).
  expect(h.editor?.getText()).toBe('см  ');
});

test('отказ создания — громкий, и набранное остаётся в тексте', async () => {
  // Молча проглоченное создание — та же потеря мысли, только без следа.
  const { h } = await mountEditor('см', api({ createFails: true }));
  await userEvent.keyboard(' @Стирка');
  await screen.findByTestId('slash-menu');
  await waitFor(() => expect(rows()).toEqual(['Создать «Стирка»']));
  await userEvent.keyboard('{Enter}');

  await screen.findByText(/не удалось/i);
  expect(JSON.stringify(h.editor?.getJSON())).not.toContain('entityRef');
  expect(h.editor?.getText()).toBe('см @Стирка');
});

// --- живой диапазон и объявление меню (итоговое ревью, мелкие находки) -----------------------

test('буква, влезшая между кадром рендера и Enter, не остаётся хвостом после пункта', async () => {
  // Пункт `/`-меню снимал диапазон из КАДРА РЕНДЕРА, тогда как рядом, в `insertRef`, он берётся
  // из живой ссылки — ровно по этой причине. Ломается при наборе быстрее, чем React
  // отрисовывает: буква, успевшая лечь между последним рендером и Enter, остаётся хвостом
  // после применённого пункта.
  //
  // Форма пробы: букву дописываем ТРАНЗАКЦИЕЙ и тут же, синхронно, шлём Enter тем же путём,
  // каким его приносит клавиатура (`handleKeyDown` в props плагинов — это и есть путь
  // ProseMirror). React между двумя шагами перерисоваться не успевает — это и есть «набор
  // быстрее рендера».
  const { h } = await mountEditor('привет', api({}));
  const editor = h.editor as Editor;
  await userEvent.keyboard(' /заг');
  await screen.findByTestId('slash-menu');
  expect(activeRow()).toBe('Заголовок 1'); // страж: применится ИМЕННО этот пункт

  const view = editor.view;
  view.dispatch(view.state.tr.insertText('о')); // «/заго» — диапазон плагина стал длиннее
  const taken = view.someProp('handleKeyDown', (f) =>
    f(view, new KeyboardEvent('keydown', { key: 'Enter' })),
  );
  expect(taken).toBe(true); // страж: Enter забрало МЕНЮ, а не разрыв абзаца

  await waitFor(() => expect(editor.getJSON().content?.map((n) => n.type)).toEqual(['heading']));
  // Хвоста нет: съеден весь запрос целиком, включая букву, набранную «после кадра».
  expect(editor.getText()).toBe('привет ');
});

test('открытое меню объявлено полю ввода, а закрытое — нет', async () => {
  // Фокус намеренно остаётся в редакторе (меню зовут набором), поэтому программа чтения с
  // экрана узнаёт об открытии списка и о перемещении выбора ТОЛЬКО из атрибутов на самом поле.
  // Без них клавиатурный путь рабочий, а незрячий не знает ни что меню открылось, ни что
  // стрелка что-то подвинула.
  const { area } = await mountEditor('привет', api({}));
  // Закрытое меню не объявлено ничем: иначе программа чтения вечно рапортовала бы об открытом
  // списке, которого на экране нет.
  expect(area.getAttribute('aria-expanded')).toBeNull();
  expect(area.getAttribute('aria-activedescendant')).toBeNull();

  await userEvent.keyboard(' /заг');
  const menu = await screen.findByTestId('slash-menu');
  const selected = () =>
    screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true');
  expect(menu.id).not.toBe(''); // страж вакуумности: сравнивать есть с чем
  expect(selected()?.id ?? '').not.toBe('');
  expect(area).toHaveAttribute('aria-expanded', 'true');
  expect(area).toHaveAttribute('aria-controls', menu.id);
  expect(area).toHaveAttribute('aria-activedescendant', selected()?.id as string);

  // Выбор поехал — объявление поехало вместе с ним.
  await userEvent.keyboard('{ArrowDown}');
  await waitFor(() => expect(selected()?.textContent).toBe('Заголовок 2'));
  expect(area).toHaveAttribute('aria-activedescendant', selected()?.id as string);

  // Закрылось — снято ВСЁ, а не только видимость.
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByTestId('slash-menu')).toBeNull());
  expect(area.getAttribute('aria-expanded')).toBeNull();
  expect(area.getAttribute('aria-controls')).toBeNull();
  expect(area.getAttribute('aria-activedescendant')).toBeNull();
});

// --- клавиатура: через suggestion, а не через window ------------------------------------------

test('клавиши меню идут через suggestion, а не через слушателя окна в capture-фазе', async () => {
  // Слушатель на окне глушил бы стрелки, Enter и Escape во ВСЁМ приложении, пока меню
  // открыто, и конкурировал бы с самим @tiptap/suggestion (ревью И18).
  const seen: { key: string; prevented: boolean; from: string }[] = [];
  const spy = vi.spyOn(window, 'addEventListener');
  const outside = document.createElement('input');
  outside.setAttribute('data-testid', 'outside');
  document.body.appendChild(outside);
  const watcher = (e: Event) =>
    seen.push({
      key: (e as KeyboardEvent).key,
      prevented: e.defaultPrevented,
      from: (e.target as HTMLElement).getAttribute('data-testid') ?? 'editor',
    });
  window.addEventListener('keydown', watcher);
  try {
    await mountEditor('привет', api({}));
    spy.mockClear();
    await userEvent.keyboard(' /');
    await screen.findByTestId('slash-menu');

    // (а) структурно: пока меню открыто, НИ ОДНОГО keydown-слушателя в capture-фазе на окне
    // наша реализация не завела.
    const capturing = spy.mock.calls.filter(
      ([type, , opts]) =>
        type === 'keydown' &&
        (opts === true || (opts as AddEventListenerOptions)?.capture === true),
    );
    expect(capturing).toEqual([]);

    // (б) стрелка вниз в ЧУЖОМ поле доходит до него НЕТРОНУТОЙ и выбор в меню не двигает.
    const first = activeRow();
    fireEvent.keyDown(outside, { key: 'ArrowDown' });
    expect(seen.at(-1)).toEqual({ key: 'ArrowDown', prevented: false, from: 'outside' });
    expect(activeRow()).toBe(first);

    // (в) положительный контроль В ТОМ ЖЕ ТЕСТЕ: та же стрелка В РЕДАКТОРЕ выбор двигает и
    // гасится редактором (defaultPrevented) — без этого (б) зелен и у меню без клавиатуры.
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(activeRow()).not.toBe(first));
    expect(seen.at(-1)?.from).toBe('editor');
    expect(seen.at(-1)?.prevented).toBe(true);
  } finally {
    window.removeEventListener('keydown', watcher);
    outside.remove();
  }
});

test('стрелки ходят ПО КРУГУ: вверх с первой строки — на последнюю', async () => {
  // Раунд правок 1 (М-2). Ветка ArrowUp — единственная арифметика с оборачиванием во всём
  // меню, и до этого теста её не проверяло ничто. Список из трёх строк (`/заг`) выбран
  // затем, что круг на нём виден целиком.
  await mountEditor('привет', api({}));
  await userEvent.keyboard(' /заг');
  await screen.findByTestId('slash-menu');
  expect(rows()).toEqual(['Заголовок 1', 'Заголовок 2', 'Заголовок 3']);
  expect(activeRow()).toBe('Заголовок 1');

  await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(activeRow()).toBe('Заголовок 3')); // через край назад
  await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(activeRow()).toBe('Заголовок 2')); // и дальше просто вверх

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: вниз через край — обратно на первую.
  await userEvent.keyboard('{ArrowDown}{ArrowDown}');
  await waitFor(() => expect(activeRow()).toBe('Заголовок 1'));
});

test('выбранная строка прокручивается в видимую область', async () => {
  // Раунд правок 1 (М-3). Панель ограничена по высоте и скроллится, а пунктов двенадцать:
  // без прокрутки строки ниже восьмой выбирались бы стрелкой ЗА КРАЕМ панели, и обещание
  // «набрал → стрелка → Enter» держалось бы только для верхней трети меню.
  // `scrollIntoView` в jsdom не реализован вовсе — подставляем его сами и следим за вызовом.
  const scrolled: (string | null)[] = [];
  const proto = HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
  const had = 'scrollIntoView' in proto;
  proto.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    scrolled.push(this.textContent);
  };
  try {
    await mountEditor('привет', api({}));
    await userEvent.keyboard(' /');
    await screen.findByTestId('slash-menu');
    scrolled.length = 0;

    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(activeRow()).toBe('Заголовок 2'));
    // Прокручена ИМЕННО ставшая активной строка, а не первая попавшаяся.
    expect(scrolled.at(-1)).toBe('Заголовок 2');

    // Положительный контроль: край списка тоже доезжает — стрелка вверх с первой строки
    // уводит выбор на ПОСЛЕДНИЙ пункт, тот самый, что и не влезает в панель.
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    await waitFor(() => expect(activeRow()).toBe('Ссылка на сущностьили @'));
    expect(scrolled.at(-1)).toBe('Ссылка на сущностьили @');
  } finally {
    if (!had) proto.scrollIntoView = undefined;
  }
});

// --- жизненный цикл меню: всё, что происходит МИМО документа ----------------------------------

test('клик мимо редактора закрывает меню, а клик по самому меню — нет', async () => {
  // Раунд правок 1 (И-1). Плагин пересчитывает состояние ТОЛЬКО на транзакциях редактора
  // (ни blur, ни handleDOMEvents у него нет), а клик по сайдбару транзакции не даёт: панель
  // `fixed z-50` осталась бы висеть поверх всего приложения до возвращения в редактор.
  const outside = document.createElement('button');
  outside.textContent = 'снаружи';
  document.body.appendChild(outside);
  try {
    const { h } = await mountEditor('привет', api({}));
    await userEvent.keyboard(' /');
    await screen.findByTestId('slash-menu');

    // Клик ПО МЕНЮ меню не закрывает — иначе выбор строки мышью был бы невозможен: страж
    // висит в capture-фазе и приходит РАНЬШЕ обработчика строки.
    fireEvent.pointerDown(screen.getAllByRole('option')[0] as HTMLElement);
    await new Promise((res) => setTimeout(res, 30));
    expect(screen.getByTestId('slash-menu')).toBeInTheDocument();

    fireEvent.pointerDown(outside);
    await waitFor(() => expect(screen.queryByTestId('slash-menu')).toBeNull());
    // Закрытие — не правка: набранное осталось текстом (тот же путь, что у Esc).
    expect(h.editor?.getJSON().content?.map((n) => n.type)).toEqual(['paragraph']);
    expect(h.editor?.getText()).toBe('привет /');
  } finally {
    outside.remove();
  }
});

test('уход фокуса из редактора закрывает меню', async () => {
  // Фокус уводят и табом, и программно — указателя при этом нет вовсе, и страж «клик
  // снаружи» такого ухода не увидел бы.
  const { h, area } = await mountEditor('привет', api({}));
  await userEvent.keyboard(' /');
  await screen.findByTestId('slash-menu');

  h.editor?.commands.blur();
  await waitFor(() => expect(screen.queryByTestId('slash-menu')).toBeNull());
  expect(h.editor?.getText()).toBe('привет /');

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: механизм жив — вернулись в редактор, и меню
  // снова открывается. Без него «меню закрылось» было бы правдой и у мёртвого меню.
  //
  // Возвращаемся КЛИКОМ, а не одним `commands.focus`, — но не потому, что указатель обязателен:
  // `commands.focus` берёт фокус через requestAnimationFrame, то есть СЛЕДУЮЩИМ кадром, и
  // набор, посланный тем же тиком, приходит ещё на `<body>`. Клик фокусирует немедленно. Прежняя
  // запись замера («user-event перестаёт доставлять набор, пока указатель не побывал в нём
  // снова») называла причиной указатель, а причина — время: дождавшись кадра, тот же набор
  // доезжает и без клика (перемерено ре-ревью пакета B). Порядок тот же, что при монтировании.
  await userEvent.click(area);
  h.editor?.commands.focus('end');
  await userEvent.keyboard(' /');
  await screen.findByTestId('slash-menu');
});

test('прокрутка не закрывает меню, а пересчитывает его координаты', async () => {
  // Каретка на месте — уехала только её проекция на экран. В jsdom вся геометрия нулевая
  // (tests/prosemirror-polyfill.ts), поэтому прямоугольник узла декорации подменяем сами:
  // без подмены сверять было бы нечего, и тест был бы зелен при любой реализации.
  let top = 100;
  const real = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.matches('[data-decoration-id]')
      ? ({
          left: 40,
          bottom: top,
          top,
          right: 40,
          width: 0,
          height: 0,
          x: 40,
          y: top,
          toJSON: () => ({}),
        } as DOMRect)
      : real.call(this);
  });

  await mountEditor('привет', api({}));
  await userEvent.keyboard(' /');
  const menu = await screen.findByTestId('slash-menu');
  // Страж вакуумности: узел декорации в дереве ЕСТЬ, значит подмена вообще работает, и
  // координаты приехали именно из неё.
  expect(document.querySelector('[data-decoration-id]')).not.toBeNull();
  expect(menu.style.top).toBe('100px');
  expect(menu.style.left).toBe('40px');

  top = 20; // страница прокрутилась — каретка уехала вверх
  fireEvent.scroll(window);
  await waitFor(() => expect(screen.getByTestId('slash-menu').style.top).toBe('20px'));
  // И меню при этом ОСТАЛОСЬ открытым: прокрутка — не уход, закрывать её нечем.
  expect(screen.getByTestId('slash-menu')).toBeInTheDocument();
});

// --- плейсхолдер ------------------------------------------------------------------------------

test('плейсхолдер редактора — ДОСЛОВНО тот же текст, что рисует первый кадр', async () => {
  // Иначе при подмене первого кадра редактором подсказка дёрнулась бы на другую строку.
  vi.stubGlobal('requestIdleCallback', () => 1); // редактор встаёт только по клику
  renderWithProviders(<EditorShell doc={parseBody('')} markdown="" onChange={vi.fn()} />, api({}));
  const preview = await screen.findByTestId('editor-preview');
  expect(preview).toHaveTextContent(BODY_PLACEHOLDER);

  fireEvent.click(preview);
  const area = () => screen.getByTestId('body-editor').querySelector('[contenteditable]');
  await screen.findByTestId('body-editor');
  await waitFor(() => expect(area()).not.toBeNull());
  await waitFor(() =>
    expect((area() as HTMLElement).querySelector('[data-placeholder]')).not.toBeNull(),
  );
  expect(
    (area() as HTMLElement).querySelector('[data-placeholder]')?.getAttribute('data-placeholder'),
  ).toBe(BODY_PLACEHOLDER);
});

test('в непустом теле плейсхолдера нет — ни под текстом, ни на пустой строке', async () => {
  // Положительный контроль к тесту выше: подсказка обязана быть УСЛОВНОЙ, а не вечной.
  const { h, area } = await mountEditor('привет', api({}));
  await new Promise((r) => setTimeout(r, 50));
  expect(area.querySelector('[data-placeholder]')).toBeNull();

  // И на СВЕЖЕЙ пустой строке посреди записи её тоже нет. `BODY_PLACEHOLDER` приглашает
  // заполнить пустое ТЕЛО (первый кадр рисует его только на пустом теле), а умолчание
  // расширения вешает подсказку на любой пустой блок под кареткой — «Заметки…» всплывали бы
  // под каждым Enter в уже написанной записи.
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(h.editor?.getJSON().content).toHaveLength(2)); // страж: строка есть
  expect(area.querySelector('[data-placeholder]')?.getAttribute('data-placeholder') ?? '').toBe('');
});
