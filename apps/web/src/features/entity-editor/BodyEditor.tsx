import { type BodyDoc, bodyRefsFromDoc, DOC_SCHEMA_VERSION } from '@orbis/shared/doc';
import type { EditorOptions, JSONContent } from '@tiptap/core';
import { closeHistory, isHistoryTransaction, undoDepth } from '@tiptap/pm/history';
import { EditorState } from '@tiptap/pm/state';
import { Editor, EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { subscribeUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import {
  bindStepOwner,
  discardRedo,
  resetSteps,
  stepsGeneration,
  syncBodyDepth,
} from './arrows-stack';
import { BubbleToolbar } from './BubbleToolbar';
import { BODY_BOX_CLASS } from './body-box';
import { acquireEditor, releaseEditor } from './editor-cache';
import { EDITOR_EXTENSIONS } from './extensions';
import { RefTitlesProvider } from './nodes/RefTitlesContext';
import { pastedRecordId } from './paste-address';
import { SuggestMenu, useEditorSuggest } from './slash/EditorSuggest';
import { type SuggestHandlers, suggestionExtensions } from './slash/suggestion';
import { sameDoc } from './strip-ids';

/**
 * Признак разметки, которую ProseMirror положил в буфер обмена САМ. Ставит его
 * `_serializeForClipboard` на ПЕРВЫЙ элемент фрагмента (prosemirror-view: `wrap.firstChild`
 * после всех обёрток), и по нему же `parseFromClipboard` потом восстанавливает границы среза.
 */
const OWN_CLIPBOARD_MARK = 'data-pm-slice';

/**
 * Свой ли это буфер. Читаем АТРИБУТ У ПЕРВОГО ЭЛЕМЕНТА, а не ищем подстроку во всей строке, и
 * разница не теоретическая — замерены оба следствия поиска подстрокой (ре-ревью пакета B):
 *
 * - обычная статья про ProseMirror, где `data-pm-slice` набран внутри `<code>`, проходила мимо
 *   санитайзера ЦЕЛИКОМ: заголовок оставался заголовком, `<strong>` — маркой. Подделка требует
 *   умысла, а сюда довольно скопировать техническую статью;
 * - признак, положенный НЕ на первый элемент, тоже считался своим. `parseFromClipboard` ищет
 *   его `querySelector`ом, то есть на любой глубине, — и подделанный контекст среза, называющий
 *   обёрткой атомарную ноду (`["queryBlock",{}]`, `["entityRef",{}]`), роняет вставку
 *   необработанным TypeError. Проверка по первому элементу закрывает самый дешёвый вариант этой
 *   подделки, но не всякий: признак, положенный НА первый элемент, по-прежнему проходит (см.
 *   докблок `transformPastedHTML`).
 *
 * Разбор, а не регэксп по началу строки: браузер дописывает к содержимому буфера `<meta
 * charset=…>` и комментарии `<!--StartFragment-->`, и `firstElementChild` проходит их мимо сам
 * (первое уезжает в `head`, второе — не элемент).
 */
function isOwnClipboardHTML(html: string): boolean {
  const first = new DOMParser().parseFromString(html, 'text/html').body.firstElementChild;
  // `=== true`, а не голая цепочка: у пустой разметки первого элемента нет вовсе, и `?.` дал бы
  // undefined там, где тип обещает boolean.
  return first?.hasAttribute(OWN_CLIPBOARD_MARK) === true;
}

/**
 * Вставка HTML: сохраняем ГРАНИЦЫ блоков, снимая разметку. Вставка из письма или с сайта
 * проходит тот же путь, что текст модели, — произвольному HTML в документе не место.
 *
 * Голый `html.replace(/<[^>]*>/g, '')` из плана v1 склеивал все абзацы в одну строку и тащил
 * в документ содержимое `<style>` и `<script>` — ровно текст, которого на экране не было
 * (ревью И11). Экспортируется ради теста: путь тот же, что у `transformPastedHTML` ниже.
 */
export function htmlToPlainParagraphs(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  // head целиком: title и meta — тоже текст, которого на экране не было.
  for (const bad of parsed.querySelectorAll('style,script,head,noscript')) bad.remove();
  // `<br>` — пустой элемент, дописать текст ВНУТРЬ него нельзя; меняем его самого на перенос.
  for (const br of parsed.querySelectorAll('br')) br.replaceWith('\n');
  for (const block of parsed.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr'))
    block.insertAdjacentText('beforeend', '\n');
  // Подряд идущие переносы схлопываются, хвостовые снимаются вовсе: у вложенной вёрстки
  // (`<div><p>…</p></div>`) границу закрывают ОБА элемента, и без этого каждая вставка со
  // страницы приезжала бы с пустым абзацем между строками и ещё одним в конце.
  const text = (parsed.body.textContent ?? '').replace(/\n{2,}/g, '\n').replace(/\n+$/, '');
  if (text === '') return '';
  return text
    .split('\n')
    .map((line) => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`)
    .join('');
}

/**
 * Что делать с пришедшим HTML. Своя разметка проходит НЕТРОНУТОЙ, чужая — через санитайзер.
 *
 * Почему без этого разбора нельзя. `parseFromClipboard` (prosemirror-view) зовёт
 * `transformPastedHTML` РАНЬШЕ, чем ищет `data-pm-slice`, а в буфер `_serializeForClipboard`
 * кладёт разметку из `DOMSerializer.fromSchema` — то есть по СХЕМЕ, а не по NodeView. По схеме
 * `entityRef` — это `<span data-entity-id …>` БЕЗ текста, а `queryBlock` — `<div data-query=…>`
 * тоже без текста. Санитайзер собирает результат из `textContent`, поэтому обычное
 * Cmd+C/Cmd+V внутри тела уничтожало живое: копия абзаца с чипом теряла чип, копия блока
 * смарт-листа не вставляла ВООБЩЕ ничего (пустой `textContent` → пустая строка), а списки,
 * заголовки и марки приезжали плоскими абзацами. Потеря молчаливая: человек видит вставленный
 * текст, считает, что всё на месте, удаляет оригинал — и теряет ссылку насовсем.
 *
 * Цель санитайзера — чужой HTML из письма и с сайта; внутренняя копия под неё не подпадает.
 * Признак подделать можно — положив его НА ПЕРВЫЙ элемент, — и это осознанная цена. Что за неё
 * платится, замерено, а не оценено:
 *
 * - содержимое идёт в разбор ProseMirror, где рубеж не наш код, а СХЕМА: `<style>`, `<script>`
 *   и `<head>` prosemirror-model выбрасывает сам, ноды и марки вне схемы не создаются,
 *   протоколы ссылок режет белый список схемы (тест «пропуск по data-pm-slice не проносит ни
 *   стилей, ни скриптов»);
 * - подделанный КОНТЕКСТ среза, называющий обёрткой атомарную ноду (`["queryBlock",{}]`,
 *   `["entityRef",{}]`), роняет саму вставку: `parseFromClipboard` бросает TypeError. Документ
 *   при этом цел и чужого в нём не появляется — цена в том, что вставка молча не происходит, а
 *   в ловушку крахов улетает необработанная ошибка. Имя ноды вне схемы (`["evilNode",{}]`),
 *   не-JSON и глубокая вложенность проходят спокойно. До пропуска этот путь для чужого HTML был
 *   недостижим вовсе — санитайзер снимал признак вместе со всей разметкой. Полное закрытие
 *   стоило бы разбора формата среза у себя, то есть копии внутренностей prosemirror-view.
 *
 * Разметка ЧУЖОГО ProseMirror (у неё признак настоящий) тоже пройдёт целиком — и это ровно то
 * же самое: чужие ноды наша схема не знает и не создаёт, а знакомые (заголовок, список,
 * жирный) — законное содержимое тела.
 */
function transformPastedHTML(html: string): string {
  return isOwnClipboardHTML(html) ? html : htmlToPlainParagraphs(html);
}

type Binding = {
  update: ((e: Editor) => void) | null;
  suggest: SuggestHandlers | null;
  typed: boolean;
  generation: number;
};
const bindings = new WeakMap<Editor, Binding>();
/** Привязка меняется при remount; плагины и сама история остаются у экземпляра. */
function bodyEditorOptions(
  entityId: string | undefined,
  content: JSONContent,
  b: Binding,
  suggestionBinding: () => Binding = () => b,
): Partial<EditorOptions> {
  const current = () => b.generation === stepsGeneration();
  return {
    extensions: [
      ...EDITOR_EXTENSIONS,
      ...suggestionExtensions({
        onOpen: (s) => {
          const active = suggestionBinding();
          if (active.generation === stepsGeneration()) active.suggest?.onOpen(s);
        },
        onClose: (kind) => suggestionBinding().suggest?.onClose(kind),
        onKeyDown: (kind, event) => {
          const active = suggestionBinding();
          return active.generation === stepsGeneration()
            ? (active.suggest?.onKeyDown(kind, event) ?? false)
            : false;
        },
      }),
    ],
    content,
    onUpdate: ({ editor: e }) => {
      if (current()) b.update?.(e);
    },
    onTransaction: ({ editor: e, transaction }) => {
      if (entityId === undefined || !current() || isHistoryTransaction(transaction)) return;
      const historyEdit = transaction.docChanged && transaction.getMeta('addToHistory') !== false;
      if (historyEdit) discardRedo(entityId);
      syncBodyDepth(entityId, undoDepth(e.state), historyEdit);
    },
  };
}
function createBodyEditor(entityId: string | undefined, content: JSONContent): Editor {
  const b: Binding = { update: null, suggest: null, typed: false, generation: stepsGeneration() };
  const editor = new Editor(bodyEditorOptions(entityId, content, b));
  const current = () => b.generation === stepsGeneration();
  bindings.set(editor, b);
  if (entityId !== undefined)
    bindStepOwner(entityId, 'body', {
      closeGroup: () => {
        if (current() && !editor.isDestroyed) editor.view.dispatch(closeHistory(editor.state.tr));
      },
      undo: () => current() && editor.isEditable && editor.commands.undo(),
      redo: () => current() && editor.isEditable && editor.commands.redo(),
      reset: () => {
        if (!editor.isDestroyed)
          editor.view.updateState(
            EditorState.create({
              doc: editor.state.doc,
              selection: editor.state.selection,
              plugins: editor.state.plugins,
            }),
          );
      },
    });
  return editor;
}
export function BodyEditor(props: Parameters<typeof BodyEditorInstance>[0]) {
  const epoch = useSyncExternalStore(subscribeUndoEpoch, undoEpoch, undoEpoch);
  return props.entityId === undefined ? (
    <PrivateBodyEditor {...props} />
  ) : (
    <BodyEditorInstance key={`${props.entityId}:${epoch}`} {...props} />
  );
}
/** Частный редактор остаётся под native lifecycle Tiptap, включая отвергнутые StrictMode экземпляры. */
function PrivateBodyEditor(props: Parameters<typeof BodyEditorInstance>[0]) {
  const generation = stepsGeneration();
  const b = useMemo<Binding>(
    () => ({
      update: null,
      suggest: null,
      typed: false,
      generation,
    }),
    [generation],
  );
  // Native plugins сохраняются; live события получают новую binding, async intent — прежнюю epoch.
  const live = useRef(b);
  live.current = b;
  const options = useMemo(
    () => bodyEditorOptions(undefined, props.doc.doc, b, () => live.current),
    [b, props.doc.doc],
  );
  const editor = useEditor(options);
  if (!editor) return null;
  bindings.set(editor, b);
  return <BodyEditorInstance {...props} nativeEditor={editor} />;
}
function BodyEditorInstance({
  nativeEditor,
  doc,
  entityId,
  readOnly = false,
  onChange,
  onAccept,
  onReady,
  focusAt,
  reseat = 0,
}: {
  nativeEditor?: Editor;
  doc: BodyDoc;
  /** Без id — частный редактор предложения, со своей родной историей. */
  entityId?: string;
  readOnly?: boolean;
  onChange: (doc: BodyDoc) => void;
  /**
   * Редактор ПРИНЯЛ пришедший документ и показывает теперь его.
   *
   * Зовётся ровно там, где содержимое подменяется, и ровно тогда, когда подмена СОСТОЯЛАСЬ:
   * решение «сажать или отклонить» принимается здесь (см. эффект приезда ниже) и наружу иначе
   * не выходит — `setContent` идёт с `emitUpdate: false`, то есть `onChange` не зовётся.
   *
   * Без этого канала экран вынужден был УГАДЫВАТЬ по кэшу, показан ли приехавший документ, — а
   * редактор его отклоняет, пока человек печатает. Угадывание расходилось с экраном в обе
   * стороны: режим разметки открывался то текстом, которого на экране нет, то без последних
   * набранных слов (ре-ревью раунда 3, блокер).
   */
  onAccept?: (doc: BodyDoc) => void;
  onReady?: (editor: Editor) => void;
  /**
   * Точка в координатах ОКНА, куда положить каретку при монтировании; `null`/`undefined` —
   * фокус не забирать вовсе. Читается ОДИН раз, при первом рендере (см. `focusAtRef`).
   */
  focusAt?: { left: number; top: number } | null;
  /**
   * Счётчик ПРИНУДИТЕЛЬНОЙ посадки: сменился — редактор сажает `doc`, даже если это тот же объект и человек только что
   * набирал в фокусе. Его двигает «Обновить» на плашке конфликта (рулинг R-17, приёмка §13.4 п. 2 (б)): после отказа
   * `STALE_VERSION` чужой текст уже лежит в кэше тем же объектом (структурное разделение react-query), эффект приезда
   * по `doc` не прогоняется, и без явного сигнала выйти из конфликта в открытом экране было бы нечем.
   */
  reseat?: number;
}) {
  // Последнее ПРИНЯТОЕ содержимое: транзакции, не менявшие смысла (простановка id),
  // правкой не считаются — иначе каждое открытие сущности писало бы в БД (Б4).
  const lastAccepted = useRef<JSONContent>(doc.doc);

  // Получатель извещения о подмене — через реф: см. `onAccept` и эффект приезда ниже.
  const onAcceptRef = useRef(onAccept);
  useEffect(() => {
    onAcceptRef.current = onAccept;
  });

  // `/` и `@`. Расширения приходят отсюда, а не из EDITOR_EXTENSIONS: они держат колбэки
  // ЭТОГО редактора, и общая константа раздала бы пяти редакторам на экране одно состояние
  // меню на всех. Массив стабилен (useMemo без зависимостей внутри хука) — схему редактора
  // пересобирать нечему.
  const suggest = useEditorSuggest();

  // Снимок момента монтирования: EditorShell отдаёт координаты новым объектом на каждый рендер,
  // и в зависимостях эффекта они дёргали бы фокус на каждую перерисовку экрана.
  const focusAtRef = useRef(focusAt);

  /**
   * Набирал ли человек в ЭТОМ редакторе хоть раз. Ровно это и защищает страж приезда чужой
   * версии ниже; фокус сам по себе не защищает ничего.
   *
   * Различать пришлось из-за находки 2: пока клик по телу редактор не фокусировал, «в фокусе»
   * означало «человек уже что-то делает», и признаки совпадали по совпадению. Теперь клик
   * фокусирует — и один фокус значил бы «ткнул в текст», то есть чужая правка переставала бы
   * доезжать до редактора, в котором не набрали ни буквы (это ловят два теста detail).
   * Цена ошибки в разные стороны разная: подмена под набранным текстом — потеря написанного,
   * подмена под пустой кареткой — прыжок курсора в КОНЕЦ тела (замерено: `setContent` оставляет
   * выделение на последней позиции документа, а не на первой). Стережём первое.
   */
  const typed = useRef(false);

  const [cachedEditor] = useState(
    () =>
      nativeEditor ??
      (entityId === undefined
        ? createBodyEditor(undefined, doc.doc)
        : acquireEditor(entityId, () => createBodyEditor(entityId, doc.doc))),
  );
  const editor = nativeEditor ?? cachedEditor;
  const generation = stepsGeneration();
  useEffect(() => {
    if (entityId === undefined) return;
    acquireEditor(entityId, () => editor);
    return () => releaseEditor(entityId, editor);
  }, [entityId, editor]);
  useLayoutEffect(() => {
    const b = bindings.get(editor);
    if (!b || editor.isDestroyed || b.generation !== generation) return;
    const update = (e: Editor) => {
      const next = e.getJSON();
      if (sameDoc(next, lastAccepted.current)) return;
      lastAccepted.current = next;
      typed.current = true;
      b.typed = true;
      onChange({ v: DOC_SCHEMA_VERSION, doc: next });
    };
    b.update = update;
    b.suggest = suggest.handlers;
    editor.setOptions({
      editable: !readOnly,
      editorProps: {
        attributes: {
          // Та же коробка, что у первого кадра: текст не должен прыгать при подмене.
          class: `${BODY_BOX_CLASS} outline-none`,
        },
        transformPastedHTML,
        handlePaste: (view, event) => {
          // §7.4: в данных — ссылка на запись по id, не адрес; адрес вычисляется при нажатии.
          const id = pastedRecordId(
            event.clipboardData?.getData('text/plain') ?? '',
            window.location.origin,
          );
          const type = view.state.schema.nodes.entityRef;
          // В блоке кода адрес — просто текст: строчного узла там не бывает, и ProseMirror, подгоняя
          // вставку, разрезал бы блок надвое абзацем с чипом (гейт 24, M-4).
          if (id === null || type === undefined || view.state.selection.$from.parent.type.spec.code)
            return false;
          view.dispatch(
            view.state.tr
              .replaceSelectionWith(type.create({ entityId: id, label: null }), false)
              .scrollIntoView(),
          );
          return true;
        },
      },
    });
    return () => {
      if (b.update === update) {
        b.update = null;
        b.suggest = null;
      }
    };
  }, [editor, onChange, readOnly, suggest.handlers, generation]);

  /**
   * Готовность редактора и КАРЕТКА — один эффект, потому что оба про один и тот же экземпляр.
   *
   * `onCreate` относится к созданию, а cache возвращает уже живой экземпляр. Эффект
   * сообщает готовность текущего монтирования и частного native useEditor. `onReady`
   * в зависимостях нет: новая стрелка после каждой буквы не означает новый редактор.
   *
   * Каретку кладём ПО КООРДИНАТАМ клика, а не просто фокусируем: клик приходит по ПЕРВОМУ
   * КАДРУ, редактора в этот момент нет вовсе (едет ленивый чанк), поэтому браузерное «клик
   * поставил каретку» здесь не работает — а голый фокус уложил бы её в начало документа, и
   * тычок в конец длинной записи давал бы курсор на первой строке. Коробка у первого кадра и у
   * редактора общая (BODY_BOX_CLASS), поэтому точка попадает примерно туда же. Не разрешились
   * координаты (клик мимо текста, jsdom без геометрии) — берём просто фокус: экранная
   * клавиатура на планшете и набор с клавиатуры важнее точности до буквы.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: и готовность, и фокус — про ЭКЗЕМПЛЯР редактора, а не про идентичность колбэка
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    onReady?.(editor);
    const at = focusAtRef.current;
    if (!at) return;
    editor.commands.focus(editor.view.posAtCoords(at)?.pos);
  }, [editor]);

  // Приезд чужой версии документа. Подмену пропускаем ТОЛЬКО там, где есть что терять: человек
  // в этом редакторе уже набирал И держит его в фокусе — иначе чужая правка вырывала бы
  // написанное из-под рук. Нетронутый редактор чужую правку ПОДХВАТЫВАЕТ, даже стоя в фокусе
  // (см. `typed` выше). Полноценное решение — слияние (Р13 дизайна).
  // Сравнение тоже по смыслу, а не по строке: иначе приезд собственного же сохранённого
  // документа (он вернётся без блочных id) переставлял бы содержимое редактора.
  const reseatRef = useRef(reseat);
  useEffect(() => {
    // isDestroyed — не перестраховка: React 19 переигрывает пассивные эффекты при раскрытии
    // Suspense (reconnectPassiveEffects), и эффект успевает выстрелить на редакторе, у
    // которого useEditor уже снёс view. Без стража это ронял `Cannot read properties of null
    // (reading 'commands')` — НЕ падением теста, а необработанной ошибкой прогона: ассерты
    // оставались зелёными, а код возврата становился 1 (поймано тестами раунда правок 1).
    if (!editor || editor.isDestroyed) return;
    // Принудительная посадка (см. `reseat`) — явное решение человека показать серверный текст: страж набранного её
    // не держит, и набор начинается заново — следующая чужая правка до первой буквы снова доедет сама.
    const forced = reseatRef.current !== reseat;
    reseatRef.current = reseat;
    if (forced) {
      typed.current = false;
      const b = bindings.get(editor);
      if (b) b.typed = false;
    } else if (editor.isFocused && (typed.current || bindings.get(editor)?.typed)) return;
    if (!sameDoc(editor.getJSON(), doc.doc)) {
      lastAccepted.current = doc.doc;
      if (entityId !== undefined) resetSteps(entityId);
      else
        editor.view.updateState(
          EditorState.create({
            doc: editor.state.doc,
            selection: editor.state.selection,
            plugins: editor.state.plugins,
          }),
        );
      editor
        .chain()
        .setMeta('addToHistory', false)
        .setContent(doc.doc, { emitUpdate: false })
        .run();
    }
    /**
     * Извещение уходит ЗА пределами ветки подмены — то есть всякий раз, когда редактор дошёл
     * досюда, а дошёл он ровно тогда, когда показывает `doc`: либо только что его посадил, либо
     * уже показывал (сверка выше истинна). Смысл извещения именно такой: «на экране этот
     * документ», а не «я его сейчас подменил».
     *
     * Разница не косметическая, и она ЗАМЕРЕНА. Внутри ветки извещение молчало о САМОМ важном
     * случае: редактор поднимается заново после того, как посадка была ОТКЛОНЕНА (человек
     * печатал, приехало чужое, потом он ушёл в режим разметки и вернулся). Содержимое нового
     * экземпляра равно `doc` — подменять нечего, — и получатель оставался с документом,
     * которого на экране давно нет. Следующий заход в режим разметки сажал этот протухший текст
     * поверх приехавшего чужого, а следующее нажатие клавиши затирало чужое в базе
     * (ре-ревью раунда 5, Б-1). Снаружи ветки «запомненное равно экрану» становится правдой ПО
     * ПОСТРОЕНИЮ, а не по совпадению.
     *
     * Через реф, а не из зависимостей: колбэк передают стрелкой по месту, и в списке
     * зависимостей он гонял бы эффект после каждой буквы — тот же довод, что у `onReady` выше.
     *
     * Уезжает САМ `doc`, а не пересобранная пара `{ v: DOC_SCHEMA_VERSION, doc }`: получатель
     * обязан узнать документ ровно таким, каким его показывает редактор, — вместе с его
     * собственной версией. Подмена версии на текущую соврала бы о показанном (пара «новая метка
     * + старое тело»), а этот документ уходит и в редактор разметки, и обратно в тело через
     * посадку.
     */
    onAcceptRef.current?.(doc);
  }, [editor, doc, reseat, entityId]);

  // Ссылки берутся из ДОКУМЕНТА, а не из живого дерева редактора: bodyRefsFromDoc ходит и по
  // raw-блокам, а пересчёт на каждую транзакцию стоил бы обхода всего тела на нажатие клавиши.
  // Только что набранный чип доедет до резолва следующим кругом doc — вместе с автосохранением.
  const ids = useMemo(() => bodyRefsFromDoc(doc), [doc]);

  // Провайдер ОБЯЗАН стоять снаружи EditorContent: NodeView'ы живут в React-порталах, которые
  // рисует сам EditorContent, — контекст доезжает до них по дереву React, а не по DOM.
  return (
    <RefTitlesProvider ids={ids}>
      <EditorContent
        editor={editor}
        data-testid="body-editor"
        data-step-record={entityId}
        className="orbis-markdown"
      />
      {/* Меню рисуется в дереве РЕДАКТОРА, а не в отдельном React-корне через ReactRenderer:
          строки `@` приезжают из tRPC, а свой корень остался бы без провайдеров запросов. */}
      <SuggestMenu editor={editor} suggest={suggest} />
      {/* Панель выделения. В дереве React она рядом, а в DOM её элемент приставляет к себе сам
          плагин — и удаляет его, когда показывать нечего. */}
      <BubbleToolbar editor={editor} />
    </RefTitlesProvider>
  );
}
