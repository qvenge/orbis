import { buildAppPath } from '@orbis/shared';
import { EntityRef } from '@orbis/shared/doc';
import type { Attributes, NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { openEntity } from '../../../state/navigation';
import { useRefTitle } from './RefTitlesContext';

/** Закрытые статусы задачи — те же два, что у секции «Блокировки» (Blocks.tsx:15). */
const CLOSED = new Set(['done', 'cancelled']);

function Chip({ node }: NodeViewProps) {
  // Атрибуты ноды типизированы как Record<string, any> — сужаем на входе, а не по месту.
  // id зовётся КАК ЕСТЬ: приведение к нижнему регистру уже сделала сама нода при разборе
  // markdown (Задача 2), а ключи карты заголовков lowercase по построению (id уезжает в
  // запрос через bodyRefsFromDoc, который их приводит, — convert.ts). Второй `toLowerCase()`
  // тут ничему не помешал бы, но и не спас бы ничего, кроме ноды, собранной в обход разбора.
  const entityId = typeof node.attrs.entityId === 'string' ? node.attrs.entityId : '';
  const label = typeof node.attrs.label === 'string' ? node.attrs.label : null;
  const found = useRefTitle(entityId);

  // Пока резолв едет — показываем ВМОРОЖЕННУЮ подпись из текста: пустое место мигало бы при
  // каждом открытии записи. Подписи нет — обрубок id, потому что невидимый чип неотличим от
  // пропавшей ссылки.
  const text = found?.title ?? label ?? `${entityId.slice(0, 8)}…`;
  const closed = CLOSED.has(String(found?.status ?? ''));
  // Три состояния одной строкой: закрытая — серая и зачёркнутая, разрешённая — акцент,
  // неразрешённая (не доехала или не найдена) — серая.
  const tone = closed ? 'text-text-muted line-through' : found ? 'text-accent' : 'text-text-muted';

  return (
    <NodeViewWrapper as="span">
      <a
        data-testid="entity-chip"
        // Не украшение и не дубль testid: по этому признаку `.orbis-markdown a` в globals.css
        // уступает чипу цвет. Без него общее правило разметки (селектор специфичнее одиночного
        // класса Tailwind) красило бы акцентом и серый, и зачёркнутый чип.
        data-entity-chip=""
        href={buildAppPath({ kind: 'entity', id: entityId })}
        // Внутренность чипа — не текст документа: без этого каретка заходила бы внутрь
        // подписи, которой в документе нет (в документе только id и label атрибутами).
        contentEditable={false}
        // Свой ховер — заливкой, как у всякой «пилюли» в интерфейсе (ui/Chip.tsx, Sheet.tsx):
        // общее подчёркивание ссылок разметки чипу чужое, и вдобавок `text-decoration` —
        // ШОРТКАТ, то есть у закрытой задачи оно не добавлялось бы к зачёркиванию, а СНИМАЛО
        // бы его ровно под курсором (найдено ревью). Само правило разметки от чипа отвязано
        // в globals.css.
        className={`rounded px-1 transition hover:bg-surface-2 ${tone}`}
        onClick={(e) => {
          // Штатные жесты браузера не перехватываем — то же правило, что в Markdown.tsx:62:
          // Ctrl/Cmd (новая вкладка), Shift (новое окно), Alt (скачать) и не-основная кнопка
          // обязаны работать. Ссылка, которая ведёт себя не как ссылка, хуже её отсутствия.
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          openEntity(entityId);
        }}
      >
        {found?.emoji ? `${found.emoji} ` : ''}
        {text}
      </a>
    </NodeViewWrapper>
  );
}

/**
 * Нода из общей схемы + ВНЕШНИЙ ВИД и ЧТЕНИЕ СВОЕЙ РАЗМЕТКИ. Расширяется именно `EntityRef`, а
 * не создаётся вторая нода: имя и схема обязаны остаться теми же, иначе схема редактора
 * разойдётся со схемой документа, которую серверный путь записи спрашивает напрямую, — и
 * нерабочим станет КАЖДОЕ сохранение. Обе добавки безопасны: рисование схемы не касается
 * вовсе, а разбор HTML — АТРИБУТНЫЙ (`addAttributes`), то есть ни ноды, ни марки не заводит.
 *
 * Почему разбор атрибутов живёт здесь, а не в общей схеме. HTML читает ровно один путь во всём
 * проекте — БУФЕР ОБМЕНА редактора: сервер и модель говорят markdown'ом, и `parseHTML` там не
 * зовёт никто. Общая нода печатает `data-entity-id`/`data-label`, а вот прочитать их обратно
 * не умела: умолчание Tiptap ищет атрибут ПО ИМЕНИ ПОЛЯ (`entityId`, `label`), поэтому
 * скопированный чип возвращался нодой с пустыми атрибутами — на экране пустой обрубок, в
 * `body_refs` пусто, ссылка потеряна так же начисто, как если бы чип сняли совсем (замерено;
 * итоговое ревью, находка 1). Ключи разбора — те же строки, что печатает `renderHTML` общей
 * ноды; разъедься они, круг копирования снова стал бы молча терять ссылку — стережёт тест.
 */
export const EntityRefWithView = EntityRef.extend({
  addAttributes(): Attributes {
    // Тип нужен явно: `this.parent?.()` в сочетании с `??` TS сводит к `{}`, и обращение к
    // полям родителя перестаёт проходить проверку.
    const parent: Attributes = this.parent?.() ?? {};
    return {
      ...parent,
      entityId: {
        ...parent.entityId,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-entity-id'),
      },
      label: {
        ...parent.label,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-label'),
      },
    };
  },
  addNodeView: () => ReactNodeViewRenderer(Chip),
});
