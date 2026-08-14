import { QUERY_BLOCK_CLOSE, QueryBlock } from '@orbis/shared/doc';
import type { NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useState } from 'react';
import { QueryBlock as QueryBlockWidget } from '../../../lib/query-blocks/QueryBlock';
import { useToast } from '../../../ui/toast-store';
import { QueryBlockEditor } from '../../query-builder/QueryBlockEditor';

function Widget({ node, updateAttributes }: NodeViewProps) {
  // Атрибуты ноды типизированы как Record<string, any> — сужаем на входе, а не по месту.
  // Текст берётся ДОСЛОВНО, без trim: атрибут хранит внутренность обёртки как есть (переносы
  // и девятипробельные отступы сидов), и тримленный текст в редакторе схлопнул бы блок при
  // первом же сохранении — сиды сверяются с §3.3 PRD байт-в-байт.
  const query = typeof node.attrs.query === 'string' ? node.attrs.query : '';
  const [editing, setEditing] = useState(false);
  const { show } = useToast();

  function save(next: string) {
    // Последний рубеж разметки тела — перенесён из replaceQueryBlock вместе с его причиной.
    // `}}` не ошибка грамматики (парсер `tags=a}}b` принимает молча), а конец ОБЁРТКИ:
    // сериализация закрыла бы блок на первом вхождении, хвост запроса уехал бы текстом
    // заметки, а `{{query:` в этом хвосте завёл бы ЛИШНИЙ блок — и сдвинул бы нумерацию, на
    // первом блоке стоит бейдж pinned-сущности (§3.2).
    //
    // Барьер здесь ВТОРОЙ и сегодня недостижим: строковый редактор гасит «Сохранить» на
    // `}}`, а форма такого AST не печатает вовсе (serializeQuery бросает). Он и стоит ровно
    // на случай третьего редактора: тихая запись испорченного блока хуже отказа.
    if (next.includes(QUERY_BLOCK_CLOSE)) {
      show(`В запросе нельзя использовать «${QUERY_BLOCK_CLOSE}»`, 'danger');
      return;
    }
    // Правка блока — правка АТРИБУТА ноды. Вместе с адресацией по порядковому номеру в
    // тексте (replaceQueryBlock) ушла и её оптимистичная блокировка «Блок изменился в другом
    // месте»: адрес правки — сама нода, и промахнуться мимо неё нечем.
    updateAttributes({ query: next });
    setEditing(false);
  }

  return (
    // data-query-widget — не украшение: по этому признаку страж EditorShell отличает клик по
    // живому виджету от клика по телу (тот же признак, что у первого кадра и у DetailScreen).
    // contentEditable={false} — чтобы каретка не заходила внутрь виджета: в документе от него
    // только атрибут `query`, набирать внутри нечего.
    <NodeViewWrapper data-query-widget="" contentEditable={false}>
      <QueryBlockWidget query={query} onConfigure={() => setEditing(true)} />
      {editing && (
        // initial — текущий атрибут ноды, а не снимок при открытии. У detail снимок был нужен
        // потому, что body под модалкой мог смениться рефетчем и номер блока указал бы на
        // ЧУЖОЙ запрос; здесь адрес — сама нода, и промахнуться мимо неё нечем.
        //
        // Что при этом происходит на самом деле — замерено пробой, а не выведено: приезд
        // чужой версии документа ProseMirror применяет ОБНОВЛЕНИЕМ этого же NodeView (тип
        // ноды тот же), React-экземпляр переживает подмену вместе с состоянием, и модалка
        // остаётся открытой с уже набранным текстом. Набранное не теряется; сохранение —
        // последняя запись в тот же блок, ровно как у остального текста тела.
        <QueryBlockEditor initial={query} onSave={save} onCancel={() => setEditing(false)} />
      )}
    </NodeViewWrapper>
  );
}

/**
 * Нода из общей схемы + ВНЕШНИЙ ВИД. Расширяется именно `QueryBlock`, а не создаётся вторая
 * нода: имя и схема обязаны остаться теми же, иначе схема редактора разойдётся со схемой
 * документа, которую серверный путь записи спрашивает напрямую, — и нерабочим станет КАЖДОЕ
 * сохранение. Меняется только рисование, сериализация остаётся общей с сервером.
 */
export const QueryBlockWithView = QueryBlock.extend({
  addNodeView: () => ReactNodeViewRenderer(Widget),
});
