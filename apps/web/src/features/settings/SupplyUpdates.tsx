import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Skeleton';
import { UpdateActions } from '../supply/UpdateActions';
import {
  ACCEPT_ALL,
  ADD,
  acceptAllScope,
  STATUS_EDITED,
  type SupplyUpdate,
  supplyTitleOf,
  useSupplyAction,
  useSupplyUpdates,
} from '../supply/useSupply';

/**
 * «Обновления» (срез 1б §9.1 п. 2–3): всё, что предлагает поставка, — ПРЕДЛОЖЕНИЯМИ. У обновления
 * записи — [Сравнить] [Принять — прежняя версия сохранится] [Оставить своё]; «Принять все» — только
 * для записей, которые владелец не правил (и они названы до нажатия); новая запись поставки —
 * «В поставке появилось: … — [Добавить]». Отказ помнится до следующего эталона (сервер), отменённое
 * «Добавить» снова предлагает ключ (R-18).
 */
export function SupplyUpdates() {
  const { updates, status } = useSupplyUpdates();
  const run = useSupplyAction();
  const [busy, setBusy] = useState(false);

  if (status === 'loading') return <Skeleton className="h-12" />;
  if (status === 'error') {
    return <p className="text-sm text-text-muted">Не удалось загрузить обновления поставки.</p>;
  }
  if (updates.length === 0) {
    return <p className="text-sm text-text-muted">Всё как в поставке — обновлений нет.</p>;
  }
  const scope = acceptAllScope(updates);
  const act = (p: Promise<boolean>) => {
    setBusy(true);
    void p.finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div>
          <Button
            size="sm"
            disabled={scope.length === 0 || busy}
            onClick={() => act(run({ kind: 'accept-all' }))}
          >
            {ACCEPT_ALL}
          </Button>
        </div>
        <p data-testid="accept-all-scope" className="text-xs text-text-muted">
          {scope.length === 0
            ? 'Записей без ваших правок с обновлением нет — каждую правленую решите отдельно.'
            : `Примет записи, которые вы не правили: ${scope.map((u) => supplyTitleOf(u.key)).join(', ')}.`}
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {updates.map((u) => (
          <li
            key={u.key}
            data-testid={`supply-update-${u.key}`}
            className="flex flex-col gap-2 py-2"
          >
            {u.kind === 'new' ? (
              <NewRecord
                update={u}
                busy={busy}
                onAdd={() => act(run({ kind: 'add', key: u.key }))}
              />
            ) : (
              <>
                <p className="text-sm">
                  {supplyTitleOf(u.key)}
                  {u.edited && (
                    <span className="text-xs text-text-secondary"> · {STATUS_EDITED}</span>
                  )}
                </p>
                {u.declined && (
                  <p className="text-xs text-text-secondary">
                    Прежнюю версию поставки вы уже оставляли без изменений — эта новее.
                  </p>
                )}
                <UpdateActions update={u} />
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewRecord({
  update,
  busy,
  onAdd,
}: {
  update: SupplyUpdate;
  busy: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm">В поставке появилось: {supplyTitleOf(update.key)}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={onAdd}>
        {ADD}
      </Button>
    </div>
  );
}
