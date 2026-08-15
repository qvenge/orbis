import { type BodyDoc, bodyRefsFromDoc, DOC_SCHEMA_VERSION } from '@orbis/shared/doc';
import type { JSONContent } from '@tiptap/core';
import { type Editor, EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useMemo, useRef } from 'react';
import { BubbleToolbar } from './BubbleToolbar';
import { BODY_BOX_CLASS } from './body-box';
import { EDITOR_EXTENSIONS } from './extensions';
import { RefTitlesProvider } from './nodes/RefTitlesContext';
import { SuggestMenu, useEditorSuggest } from './slash/EditorSuggest';
import { sameDoc } from './strip-ids';

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

export function BodyEditor({
  doc,
  onChange,
  onReady,
}: {
  doc: BodyDoc;
  onChange: (doc: BodyDoc) => void;
  onReady?: (editor: Editor) => void;
}) {
  // Последнее ПРИНЯТОЕ содержимое: транзакции, не менявшие смысла (простановка id),
  // правкой не считаются — иначе каждое открытие сущности писало бы в БД (Б4).
  const lastAccepted = useRef<JSONContent>(doc.doc);

  // `/` и `@`. Расширения приходят отсюда, а не из EDITOR_EXTENSIONS: они держат колбэки
  // ЭТОГО редактора, и общая константа раздала бы пяти редакторам на экране одно состояние
  // меню на всех. Массив стабилен (useMemo без зависимостей внутри хука) — схему редактора
  // пересобирать нечему.
  const suggest = useEditorSuggest();
  const extensions = useMemo(
    () => [...EDITOR_EXTENSIONS, ...suggest.extensions],
    [suggest.extensions],
  );

  const editor = useEditor({
    extensions,
    content: doc.doc,
    onCreate: ({ editor: e }) => onReady?.(e),
    onUpdate: ({ editor: e }) => {
      const next = e.getJSON();
      if (sameDoc(next, lastAccepted.current)) return;
      lastAccepted.current = next;
      onChange({ v: DOC_SCHEMA_VERSION, doc: next });
    },
    editorProps: {
      attributes: {
        // Та же коробка, что у первого кадра: текст не должен прыгать при подмене.
        class: `${BODY_BOX_CLASS} outline-none`,
      },
      transformPastedHTML: htmlToPlainParagraphs,
    },
  });

  // Приезд чужой версии документа. Подменяем ТОЛЬКО когда редактор не в фокусе: иначе чужая
  // правка вырывала бы каретку из-под рук. Полноценное решение — слияние (Р13 дизайна).
  // Сравнение тоже по смыслу, а не по строке: иначе приезд собственного же сохранённого
  // документа (он вернётся без блочных id) переставлял бы содержимое редактора.
  useEffect(() => {
    // isDestroyed — не перестраховка: React 19 переигрывает пассивные эффекты при раскрытии
    // Suspense (reconnectPassiveEffects), и эффект успевает выстрелить на редакторе, у
    // которого useEditor уже снёс view. Без стража это ронял `Cannot read properties of null
    // (reading 'commands')` — НЕ падением теста, а необработанной ошибкой прогона: ассерты
    // оставались зелёными, а код возврата становился 1 (поймано тестами раунда правок 1).
    if (!editor || editor.isDestroyed || editor.isFocused) return;
    if (!sameDoc(editor.getJSON(), doc.doc)) {
      lastAccepted.current = doc.doc;
      editor.commands.setContent(doc.doc, { emitUpdate: false });
    }
  }, [editor, doc]);

  // Ссылки берутся из ДОКУМЕНТА, а не из живого дерева редактора: bodyRefsFromDoc ходит и по
  // raw-блокам, а пересчёт на каждую транзакцию стоил бы обхода всего тела на нажатие клавиши.
  // Только что набранный чип доедет до резолва следующим кругом doc — вместе с автосохранением.
  const ids = useMemo(() => bodyRefsFromDoc(doc), [doc]);

  // Провайдер ОБЯЗАН стоять снаружи EditorContent: NodeView'ы живут в React-порталах, которые
  // рисует сам EditorContent, — контекст доезжает до них по дереву React, а не по DOM.
  return (
    <RefTitlesProvider ids={ids}>
      <EditorContent editor={editor} data-testid="body-editor" className="orbis-markdown" />
      {/* Меню рисуется в дереве РЕДАКТОРА, а не в отдельном React-корне через ReactRenderer:
          строки `@` приезжают из tRPC, а свой корень остался бы без провайдеров запросов. */}
      <SuggestMenu editor={editor} suggest={suggest} />
      {/* Панель выделения. В дереве React она рядом, а в DOM её элемент приставляет к себе сам
          плагин — и удаляет его, когда показывать нечего. */}
      <BubbleToolbar editor={editor} />
    </RefTitlesProvider>
  );
}
