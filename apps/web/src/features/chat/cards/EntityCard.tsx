import { useState } from 'react';
import { useNav } from '../../../state/navigation';
import { trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import type { EntityCardData } from './types';

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
        className="text-left font-medium"
        disabled={undone}
        onClick={() => push(activeTab, { kind: 'entity', id: card.entityId })}
      >
        {card.title}
      </button>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
        {Object.entries(card.keyFields).map(([k, v]) => (
          <div key={k} className="flex gap-1">
            <dt>{k}:</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
      </dl>
      {undoActionId && !undone && (
        <Button variant="ghost" onClick={() => undo.mutate({ actionId: undoActionId })}>
          Отменить
        </Button>
      )}
      {undone && <p className="text-xs text-text-muted">Отменено</p>}
    </Card>
  );
}
