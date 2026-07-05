import { useState } from 'react';
import { trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { smoothAuditText } from '../format-audit';
import type { ConfirmationData } from './types';

const EXPIRY_MS = 24 * 60 * 60 * 1000; // D-a: 24ч visual-expiry

export function ConfirmationCard({
  card,
  createdAt,
}: {
  card: ConfirmationData;
  createdAt: string;
}) {
  const [resolved, setResolved] = useState<null | 'approved' | 'rejected'>(null);
  const [postError, setPostError] = useState<string | null>(null);
  // Клиентский expiry — только UI; approve всё равно ревалидирует на сервере (D-a).
  const expired = Date.now() - new Date(createdAt).getTime() > EXPIRY_MS;

  const approve = trpc.ai.approve.useMutation({
    onSuccess: () => setResolved('approved'),
    onError: (e) => setPostError(e.message), // approve может вернуть структурную ошибку постфактум
  });
  const reject = trpc.ai.reject.useMutation({ onSuccess: () => setResolved('rejected') });

  const pendingId = card.pendingId;
  const explicit = card.mode === 'explicit' && pendingId && !resolved;
  const disabled = expired || approve.isPending || reject.isPending;

  return (
    <Card data-testid="confirmation-card" className="flex flex-col gap-2">
      <p className="font-medium">{smoothAuditText(card.summary)}</p>
      {card.diff && Object.keys(card.diff).length > 0 && (
        <dl className="flex flex-col gap-1 text-xs">
          {Object.entries(card.diff).map(([field, { before, after }]) => (
            <div key={field} className="flex gap-2">
              <dt>{field}:</dt>
              <dd className="text-danger line-through">{String(before)}</dd>
              <dd className="text-accent">{String(after)}</dd>
            </div>
          ))}
        </dl>
      )}
      {postError && (
        <p role="alert" className="text-xs text-danger">
          {postError}
        </p>
      )}
      {explicit && pendingId && (
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={disabled}
            onClick={() => approve.mutate({ pendingId })}
          >
            Подтвердить
          </Button>
          <Button variant="ghost" disabled={disabled} onClick={() => reject.mutate({ pendingId })}>
            Отменить
          </Button>
        </div>
      )}
      {expired && !resolved && (
        <p className="text-xs text-text-muted">Устарело — переспросите AI</p>
      )}
      {resolved === 'approved' && <p className="text-xs text-accent">Подтверждено</p>}
      {resolved === 'rejected' && <p className="text-xs text-text-muted">Отменено</p>}
    </Card>
  );
}
