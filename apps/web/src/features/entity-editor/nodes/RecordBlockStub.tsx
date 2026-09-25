import { AspectCard, RecordBlock } from '@orbis/shared/doc';
import { RECORD_BLOCK_NAMES, type RecordBlockName } from '@orbis/shared/doc/page-grammar';
import type { NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useState } from 'react';
import { useBodyKind } from '../../../lib/query-blocks/body-kind';
import { useFieldCatalog } from '../../../lib/query-blocks/useFieldCatalog';
import { Button } from '../../../ui/Button';
import { BlockPlaque } from '../../page/blocks/BlockPlaque';
import { placementIssue } from '../EditorShell';
import { cardAspectTitle, cardStubLabel, recordStubLabel, StubBox } from '../layout-parts';
import { AspectChooser } from './AspectChooser';

/**
 * Блоки обвязки записи в редакторе (спека страниц 1а §9.1): подписанные заглушки без живых
 * данных — «[Заголовок записи]», «[Карточки аспектов]», «[Карточка: Цель]». Запись `this` у
 * шаблона при настройке не та, которой он будет показан, а у страницы блоки обвязки видны на
 * показе; живые данные в редакторе обещали бы вид, которого на показе не будет.
 *
 * Заглушка `{{cards}}` — подпись, а не `RECORD_BLOCK_COMPONENTS.cards` (рулинг координатора,
 * перенос ревью задачи 13): тот примитив рисует карточки без множества размещённых и был бы
 * второй дорогой к `{{cards}}`, мимо размещённых `{{card: X}}` и РП-25.
 *
 * `data-query-widget` — не украшение: по нему страж EditorShell (`isBodyGesture`) отличает клик
 * по блоку от клика по телу — тот же признак, что у виджета блока данных. `contentEditable={false}`
 * — у атома нет своего текста, каретке внутри делать нечего.
 *
 * В заметке блок не работает (§5.5): на его месте плашка, текст узла остаётся в документе.
 */

/** Имя узла — из атрибута документа; незнакомое бывает только в документе клиента. */
const KNOWN: ReadonlySet<string> = new Set(RECORD_BLOCK_NAMES);

function Plaque({ message, hint }: { message: string; hint: string | undefined }) {
  return <BlockPlaque tone="misplaced" message={message} {...(hint !== undefined && { hint })} />;
}

function RecordStub({ node }: NodeViewProps) {
  const kind = useBodyKind();
  const raw = typeof node.attrs.name === 'string' ? node.attrs.name : '';
  const name = KNOWN.has(raw) ? (raw as RecordBlockName) : null;
  const issue =
    name === null ? undefined : placementIssue({ kind: 'record', name, raw: `{{${name}}}` }, kind);
  return (
    <NodeViewWrapper data-query-widget="" contentEditable={false}>
      {issue !== undefined ? (
        <Plaque message={issue.message} hint={issue.hint} />
      ) : (
        <StubBox label={name === null ? `{{${raw}}}` : recordStubLabel(name)} />
      )}
    </NodeViewWrapper>
  );
}

/**
 * Карточка аспекта: подпись аспекта по реестру и «Сменить» — тот же выбор, что у пункта меню «/».
 *
 * Смена пишет `{aspect: null, text: <ключ>}` — аспект ОБНУЛЯЕТСЯ (рулинг координатора, перенос
 * ревью задачи 8). Привязка (`bindCardAttrs`) отдаёт приоритет атрибуту: оставь здесь прежний id,
 * сервер вернул бы карточке прежний ключ, и смена молча не состоялась бы. По новому тексту id
 * проставит та же привязка при записи.
 */
function CardStub({ node, updateAttributes }: NodeViewProps) {
  const kind = useBodyKind();
  const { registry } = useFieldCatalog();
  const [choosing, setChoosing] = useState(false);
  const text = typeof node.attrs.text === 'string' ? node.attrs.text : '';
  const aspectId = typeof node.attrs.aspect === 'string' ? node.attrs.aspect : null;
  const issue = placementIssue({ kind: 'card', aspect: text, raw: `{{card: ${text}}}` }, kind);
  if (issue !== undefined) {
    return (
      <NodeViewWrapper data-query-widget="" contentEditable={false}>
        <Plaque message={issue.message} hint={issue.hint} />
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper data-query-widget="" contentEditable={false}>
      <StubBox label={cardStubLabel(cardAspectTitle(text, aspectId, registry?.parse ?? null))}>
        <Button variant="ghost" size="sm" onClick={() => setChoosing(true)}>
          Сменить
        </Button>
      </StubBox>
      {choosing && (
        <AspectChooser
          onPick={(key) => {
            setChoosing(false);
            updateAttributes({ aspect: null, text: key });
          }}
          onCancel={() => setChoosing(false)}
        />
      )}
    </NodeViewWrapper>
  );
}

/** Узлы схемы + внешний вид (довод — `LayoutFrame.tsx`: схема редактора равна схеме документа). */
export const RecordBlockWithView = RecordBlock.extend({
  addNodeView: () => ReactNodeViewRenderer(RecordStub),
});
export const AspectCardWithView = AspectCard.extend({
  addNodeView: () => ReactNodeViewRenderer(CardStub),
});
