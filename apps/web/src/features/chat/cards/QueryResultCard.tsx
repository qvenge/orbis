import { useState } from 'react';
import { EntityRef } from '../../../lib/entity-ref/EntityRef';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import type { QueryResultData } from './types';

// D-d: без aggregate — native-список из entityIds; с aggregate — число + разворачиваемый список.
// Строки — EntityRef (title вместо сырого UUID, этап 4).
export function QueryResultCard({ card }: { card: QueryResultData }) {
  const [open, setOpen] = useState(false);
  return (
    <Card data-testid="query-result-card" className="flex flex-col gap-2">
      {card.title && <p className="font-medium">{card.title}</p>}
      {card.aggregate ? (
        <div className="flex items-center gap-3">
          <span data-testid="qr-aggregate" className="text-2xl font-semibold">
            {card.aggregate.value}
          </span>
          <span className="text-xs text-text-secondary">{card.aggregate.op}</span>
          <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
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
