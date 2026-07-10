import { useState } from 'react';
import { EntityRef } from '../../../lib/entity-ref/EntityRef';
import { aggregateLabel } from '../../../lib/field-labels';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import type { QueryResultData } from './types';

// D-d: без aggregate — native-список из entityIds; с aggregate — число + разворачиваемый список.
// Строки — EntityRef (title вместо сырого UUID, этап 4).
export function QueryResultCard({ card }: { card: QueryResultData }) {
  const [open, setOpen] = useState(false);
  return (
    <Card data-testid="query-result-card" className="flex flex-col gap-2">
      {card.title && <p className="text-sm font-medium">{card.title}</p>}
      {card.aggregate ? (
        <div className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-text-muted">
            {aggregateLabel(card.aggregate.op)}
          </span>
          <span
            data-testid="qr-aggregate"
            className="text-2xl font-semibold tabular-nums tracking-tight"
          >
            {card.aggregate.value}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setOpen((v) => !v)}
          >
            Показать список
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="qr-list">
          {card.entityIds.map((id) => (
            <li key={id} data-testid="qr-item" className="text-sm text-text-secondary">
              <EntityRef id={id} />
            </li>
          ))}
        </ul>
      )}
      {card.aggregate && open && (
        <ul className="flex flex-col gap-1">
          {card.entityIds.map((id) => (
            <li key={id} data-testid="qr-item" className="text-sm text-text-secondary">
              <EntityRef id={id} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
