import { QUERY_BLOCK_CLOSE, QueryBlock } from '@orbis/shared/doc';
import { printQueryAst, type QueryAst, queryAstSchema } from '@orbis/shared/query';
import type { Attributes, NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useState } from 'react';
import { parseBlock } from '../../../lib/query-blocks/parse';
import { QueryBlock as QueryBlockWidget } from '../../../lib/query-blocks/QueryBlock';
import { useFieldCatalog } from '../../../lib/query-blocks/useFieldCatalog';
import { useToast } from '../../../ui/toast-store';
import { QueryBlockEditor } from '../../query-builder/QueryBlockEditor';

/** Дерево из атрибута ноды — или null, если его там нет или оно битое (attrs — сырой JSON). */
function astOf(raw: unknown): QueryAst | null {
  if (raw === null || raw === undefined) return null;
  const parsed = queryAstSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function Widget({ node, updateAttributes }: NodeViewProps) {
  // Атрибуты ноды типизированы как Record<string, any> — сужаем на входе, а не по месту.
  // `ast` — правда о запросе, `text` — его печатная key-форма (либо исходная строка, если
  // блок не разобран). Текст берётся ДОСЛОВНО, без trim: у неразобранного блока это
  // единственное, что от запроса осталось.
  const ast = astOf(node.attrs.ast);
  const text = typeof node.attrs.text === 'string' ? node.attrs.text : '';
  const [editing, setEditing] = useState(false);
  const { show } = useToast();
  // Реестр нужен ровно ЗДЕСЬ и ровно на сохранение: форма отдаёт ТЕКСТ (её перевод на дерево —
  // отдельное решение, Р-21-6), а в ноде обязано лежать дерево. Реестра может не быть (он едет
  // tRPC) — тогда блок сохраняется неразобранным, и его разберёт сервер при записи.
  const { registry } = useFieldCatalog();

  function save(next: string) {
    // Последний рубеж разметки тела — унаследован вместе с причиной от снятой замены блока
    // по номеру в тексте (Задача 16, `browser/query.ts`).
    // `}}` не ошибка грамматики (парсер `tags=a}}b` принимает молча), а конец ОБЁРТКИ:
    // сериализация закрыла бы блок на первом вхождении, хвост запроса уехал бы текстом
    // заметки, а `{{query:` в этом хвосте завёл бы ЛИШНИЙ блок — и сдвинул бы нумерацию, на
    // первом блоке стоит бейдж pinned-сущности (§3.2).
    //
    // Барьер стоит на ВВОДЕ, а печать закрывает свою половину сама (`quoteQueryValue`
    // экранирует `}` — см. `query/print.ts`): здесь отвергается текст, который до дерева ещё
    // не доехал и потому защищён только этой проверкой.
    if (next.includes(QUERY_BLOCK_CLOSE)) {
      show(`В запросе нельзя использовать «${QUERY_BLOCK_CLOSE}»`, 'danger');
      return;
    }
    // Правило Р3 «без изменений — байт-в-байт» на уровне НОДЫ. Форма отдаёт исходную строку
    // дословно, когда владелец ничего не менял (`QueryBuilderForm`), — и превратить это в
    // запись значило бы пометить документ изменённым и поднять автосохранение от одного лишь
    // открытия и закрытия окна.
    //
    // Заводилось правило ради сидированных блоков (они были многострочны и написаны старой
    // грамматикой). Задача 21b перевела их в ту же key-форму, которую печатает форма, и на
    // сиде правило стало тождеством; живым оно осталось для текста, НАПИСАННОГО ЧЕЛОВЕКОМ:
    // пробелы и кавычки печать нормализует. Сторож — `query-form.test.tsx`, «рукописный
    // блок, отличный от печати оформлением, переживает форму байт-в-байт».
    if (next === text) {
      setEditing(false);
      return;
    }
    // Правка блока — правка АТРИБУТОВ ноды. Вместе с адресацией по порядковому номеру блока в
    // тексте (снята Задачей 16) ушла и её оптимистичная блокировка «Блок изменился в другом
    // месте»: адрес правки — сама нода, и промахнуться мимо неё нечем.
    //
    // Пишутся ОБА атрибута и всегда согласованно: `ast` — разбор набранного текста, `text` —
    // его key-печать. Разобрать не удалось (или реестр ещё не приехал) — `ast: null` и текст
    // как набран: сервер разберёт его при записи (`bindQueryBlocks`), а виджет до тех пор
    // честно покажет отказ вместо чужого списка.
    const reg = registry?.parse;
    const parsed = reg === undefined ? null : parseBlock(next, reg);
    updateAttributes(
      parsed?.ok === true && reg !== undefined
        ? { ast: parsed.ast, text: printQueryAst(parsed.ast, reg, 'key') }
        : { ast: null, text: next },
    );
    setEditing(false);
  }

  return (
    // data-query-widget — не украшение: по этому признаку страж EditorShell отличает клик по
    // живому виджету от клика по телу (тот же признак, что у первого кадра и у DetailScreen).
    // contentEditable={false} — чтобы каретка не заходила внутрь виджета: в документе от него
    // только атрибуты запроса, набирать внутри нечего.
    <NodeViewWrapper data-query-widget="" contentEditable={false}>
      <QueryBlockWidget query={{ ast, text }} onConfigure={() => setEditing(true)} />
      {editing && (
        // initial — текущий ТЕКСТ ноды (key-печать дерева либо неразобранная строка), а не
        // снимок при открытии. У detail снимок был нужен потому, что body под модалкой мог
        // смениться рефетчем и номер блока указал бы на ЧУЖОЙ запрос; здесь адрес — сама нода,
        // и промахнуться мимо неё нечем.
        //
        // Что при этом происходит на самом деле — замерено пробой, а не выведено: приезд
        // чужой версии документа ProseMirror применяет ОБНОВЛЕНИЕМ этого же NodeView (тип
        // ноды тот же), React-экземпляр переживает подмену вместе с состоянием, и модалка
        // остаётся открытой с уже набранным текстом. Набранное не теряется; сохранение —
        // последняя запись в тот же блок, ровно как у остального текста тела.
        <QueryBlockEditor initial={text} onSave={save} onCancel={() => setEditing(false)} />
      )}
    </NodeViewWrapper>
  );
}

/**
 * Нода из общей схемы + ВНЕШНИЙ ВИД и ЧТЕНИЕ СВОЕЙ РАЗМЕТКИ. Расширяется именно `QueryBlock`, а
 * не создаётся вторая нода: имя и схема обязаны остаться теми же, иначе схема редактора
 * разойдётся со схемой документа, которую серверный путь записи спрашивает напрямую, — и
 * нерабочим станет КАЖДОЕ сохранение. Обе добавки безопасны: рисование схемы не касается, а
 * разбор HTML — АТРИБУТНЫЙ, то есть ни ноды, ни марки не заводит.
 *
 * Довод тот же, что у чипа (nodes/EntityChip.tsx): HTML читает единственный путь — буфер
 * обмена редактора. Общая нода печатает `data-query`/`data-ast`, а умолчание Tiptap ищет
 * обратно атрибуты `text`/`ast`, поэтому скопированный смарт-лист возвращался блоком с ПУСТЫМ
 * запросом — виджет с тем же видом, но показывающий не то (замерено; итоговое ревью,
 * находка 1). Дерево едет JSON'ом и читается обратно JSON'ом: печать объекта в атрибут дала бы
 * `[object Object]`, и уже чинённый дефект вернулся бы молча — теперь под тестом.
 */
export const QueryBlockWithView = QueryBlock.extend({
  addAttributes(): Attributes {
    // Тип нужен явно — см. тот же довод в nodes/EntityChip.tsx.
    const parent: Attributes = this.parent?.() ?? {};
    return {
      ...parent,
      text: {
        ...parent.text,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-query'),
      },
      ast: {
        ...parent.ast,
        // Битый JSON в буфере — не повод ронять вставку: блок приедет неразобранным, текст
        // при нём, и сервер разберёт его при первой же записи.
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute('data-ast');
          if (raw === null) return null;
          try {
            return astOf(JSON.parse(raw));
          } catch {
            return null;
          }
        },
      },
    };
  },
  addNodeView: () => ReactNodeViewRenderer(Widget),
});
