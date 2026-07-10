import { useState } from 'react';
import { fieldLabel } from '../../../lib/field-labels';
import { useNav } from '../../../state/navigation';
import { trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import type { EntityCardData } from './types';

// inline-правка полей аспекта — на detail-экране (Task 14); в чат-карточке read-only + Undo + тап в detail (MVP §2.3)
export function EntityCard({ card }: { card: EntityCardData }) {
  const [undone, setUndone] = useState(false);
  const push = useNav((s) => s.push);
  const activeTab = useNav((s) => s.activeTab);
  const utils = trpc.useUtils();
  const undo = trpc.ai.undo.useMutation({
    onSuccess: () => {
      setUndone(true);
      void utils.entity.get.invalidate({ id: card.entityId });
    },
  });

  const undoActionId = card.undoActionId;

  return (
    <Card
      data-testid="entity-card"
      data-undone={String(undone)}
      className={`flex flex-col gap-2 ${undone ? 'opacity-50' : ''}`}
    >
      <button
        type="button"
        className="cursor-pointer text-left text-sm font-medium transition hover:text-accent disabled:cursor-default disabled:hover:text-text"
        disabled={undone}
        onClick={() => push(activeTab, { kind: 'entity', id: card.entityId })}
      >
        {card.title}
      </button>
      {/* Свойства — тихая сетка «подпись: значение», числа таблично. */}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        {Object.entries(card.keyFields).map(([k, v]) => (
          <div key={k} className="col-span-2 grid grid-cols-subgrid">
            <dt className="text-text-muted">{fieldLabel(k)}</dt>
            <dd className="text-text tabular-nums">{String(v)}</dd>
          </div>
        ))}
      </dl>
      {undoActionId && !undone && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => undo.mutate({ actionId: undoActionId })}
        >
          Отменить
        </Button>
      )}
      {undone && <p className="text-xs text-text-muted">Отменено</p>}
    </Card>
  );
}
