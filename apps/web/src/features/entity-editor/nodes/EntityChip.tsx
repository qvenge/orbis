import { buildAppPath } from '@orbis/shared';
import { EntityRef } from '@orbis/shared/doc';
import type { NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { openEntity } from '../../../state/navigation';
import { useRefTitle } from './RefTitlesContext';

/** Закрытые статусы задачи — те же два, что у секции «Блокировки» (Blocks.tsx:15). */
const CLOSED = new Set(['done', 'cancelled']);

function Chip({ node }: NodeViewProps) {
  // Атрибуты ноды типизированы как Record<string, any> — сужаем на входе, а не по месту.
  // id уже в нижнем регистре: его приводит сама нода при разборе markdown (Задача 2),
  // и второе приведение тут только разошлось бы с ключами карты заголовков.
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
        className={`rounded px-1 ${tone}`}
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
 * Нода из общей схемы + ВНЕШНИЙ ВИД. Расширяется именно `EntityRef`, а не создаётся вторая
 * нода: имя и схема обязаны остаться теми же, иначе схема редактора разойдётся со схемой
 * документа, которую серверный путь записи спрашивает напрямую, — и нерабочим станет КАЖДОЕ
 * сохранение. Меняется только рисование, сериализация остаётся общей с сервером.
 */
export const EntityRefWithView = EntityRef.extend({
  addNodeView: () => ReactNodeViewRenderer(Chip),
});
