import { Column, Columns, Tab, Tabs } from '@orbis/shared/doc';
import type { PageNode } from '@orbis/shared/doc/page-grammar';
import type { NodeViewProps } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useState } from 'react';
import { useBodyKind } from '../../../lib/query-blocks/body-kind';
import { BlockPlaque } from '../../page/blocks/BlockPlaque';
import { placementIssue } from '../EditorShell';
import { columnFrameLabel, LayoutFrameBox, LayoutStack, tabShowLabel } from '../layout-parts';

/**
 * Контейнеры тела в редакторе (спека страниц 1а §9.1): части — подписанными рамками одна под
 * другой, «Колонка 1», «Вкладка: Тред». Раскладкой их рисует только показ; настоящие колонки
 * внутри редактора — позже (§15), и потому редактор честно показывает структуру, а не делает вид.
 *
 * Первые в коде NodeView с содержимым (`NodeViewContent`): текст и блоки внутри части правятся
 * как обычное тело.
 *
 * В заметке контейнер не работает (§5.5): на его месте плашка, а содержимое остаётся в документе
 * спрятанным — узел не рисуется, но и не теряется, и после сохранения текст его цел.
 */

function ContainerView({ node, selected }: NodeViewProps) {
  const kind = useBodyKind();
  // Узел препрохода той же формы: матрица мест (§5.5) спрашивается ОДНОЙ функцией с первым кадром
  // и рендерером, и плашка в редакторе дословно та же, что до его подъёма. Части не нужны —
  // спрашивается место самого контейнера.
  const shape: PageNode =
    node.type.name === 'tabs'
      ? { kind: 'tabs', parts: [], raw: '' }
      : { kind: 'columns', parts: [], raw: '' };
  const issue = placementIssue(shape, kind);
  if (issue !== undefined) {
    return (
      <NodeViewWrapper data-layout={node.type.name}>
        <div contentEditable={false}>
          <BlockPlaque
            tone="misplaced"
            message={issue.message}
            {...(issue.hint !== undefined && { hint: issue.hint })}
          />
        </div>
        <NodeViewContent className="hidden" />
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper data-layout={node.type.name}>
      <LayoutStack selected={selected}>
        <NodeViewContent className="flex flex-col gap-2" />
      </LayoutStack>
    </NodeViewWrapper>
  );
}

/**
 * Номер части в её контейнере — по позиции узла в документе. Число частей редактор не меняет
 * (схема держит пределы в каждой транзакции), а подписи, съехавшие на правке соседа, поправит
 * ближайшая перерисовка части.
 */
function partIndex({ editor, getPos }: NodeViewProps): number {
  const pos = getPos();
  return typeof pos === 'number' ? editor.state.doc.resolve(pos).index() : 0;
}

const labelOf = (attrs: Record<string, unknown> | undefined): string =>
  typeof attrs?.label === 'string' ? attrs.label : '';

/**
 * Подпись вкладки — полем правки в рамке (1а новое-4): до этого подпись в настройке была текстом,
 * и поменять её можно было только правкой markdown, которой у страниц нет.
 *
 * Черновик — локальным состоянием, в документ он уходит ОДНОЙ правкой на фиксацию (уход фокуса или
 * Enter), а не транзакцией на каждую букву: иначе каждая буква была бы шагом отмены и поводом для
 * автосохранения. Escape возвращает прежнюю подпись. События поля ProseMirror не получает сам
 * (`stopEvent` NodeView tiptap пропускает мимо поля ввода), и Enter не рождает абзаца в теле.
 */
function TabLabelField(props: NodeViewProps) {
  const saved = labelOf(props.node.attrs);
  const [draft, setDraft] = useState(saved);
  const [base, setBase] = useState(saved);
  // Подпись сменилась снаружи (отмена, чужая правка) — поле показывает её, а не старый черновик.
  if (saved !== base) {
    setBase(saved);
    setDraft(saved);
  }
  const commit = () => {
    const next = draft.trim();
    // Подпись — с узла ДОКУМЕНТА, не из замыкания: Enter фиксирует и уводит фокус, и уход фокуса
    // со старым `saved` в замыкании записал бы ту же подпись второй правкой.
    const pos = props.getPos();
    const live =
      typeof pos === 'number' ? labelOf(props.editor.state.doc.nodeAt(pos)?.attrs) : saved;
    if (next !== live) props.updateAttributes({ label: next });
    setDraft(next);
  };
  return (
    <input
      aria-label="Подпись вкладки"
      contentEditable={false}
      value={draft}
      placeholder={tabShowLabel('', partIndex(props))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          commit();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(saved);
        }
      }}
      className="min-w-0 flex-1 rounded-md bg-transparent px-1 text-text text-xs outline-none placeholder:text-text-muted focus-visible:bg-surface-2/70"
    />
  );
}

function PartView(props: NodeViewProps) {
  const { node } = props;
  const label =
    node.type.name === 'tab' ? (
      <span className="flex items-center gap-1">
        Вкладка: <TabLabelField {...props} />
      </span>
    ) : (
      columnFrameLabel(partIndex(props))
    );
  return (
    <NodeViewWrapper data-layout-part={node.type.name}>
      <LayoutFrameBox label={label} selected={props.selected}>
        <NodeViewContent className="flex flex-col gap-2" />
      </LayoutFrameBox>
    </NodeViewWrapper>
  );
}

/**
 * Узлы схемы + ВНЕШНИЙ ВИД. Расширяются сами узлы, а не заводятся вторые рядом: имя и схема
 * обязаны остаться теми же, иначе схема редактора разойдётся со схемой документа, которую
 * серверный путь записи спрашивает напрямую (довод `QueryWidget.tsx`).
 */
export const ColumnsWithView = Columns.extend({
  addNodeView: () => ReactNodeViewRenderer(ContainerView),
});
export const ColumnWithView = Column.extend({
  addNodeView: () => ReactNodeViewRenderer(PartView),
});
export const TabsWithView = Tabs.extend({
  addNodeView: () => ReactNodeViewRenderer(ContainerView),
});
export const TabWithView = Tab.extend({
  addNodeView: () => ReactNodeViewRenderer(PartView),
});
