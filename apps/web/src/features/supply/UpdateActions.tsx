import { lazy, Suspense, useState } from 'react';
import { Button } from '../../ui/Button';
import {
  ACCEPT,
  acceptNote,
  COMPARE,
  DECLINE,
  type SupplyUpdate,
  useSupplyAction,
} from './useSupply';

/** Сравнение — после жеста: его разбор тела тянет схему документа (докблок `SupplyCompare`). */
const SupplyCompare = lazy(() =>
  import('./SupplyCompare').then((m) => ({ default: m.SupplyCompare })),
);

/**
 * Три кнопки обновления записи поставки (срез 1б §9.1 п. 2) — одни и те же на плашке записи и в
 * списке «Обновления»: [Сравнить] [Принять — прежняя версия сохранится] [Оставить своё], и рядом —
 * что именно сохранится (`acceptNote`). Кнопки гаснут, пока действие в полёте: второе нажатие
 * отправило бы второе «принять» на уже принятое.
 */
export function UpdateActions({ update }: { update: SupplyUpdate }) {
  const run = useSupplyAction();
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = (kind: 'accept' | 'decline') => {
    setBusy(true);
    void run({ kind, key: update.key }).finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setComparing(true)}>
          {COMPARE}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => act('accept')}>
          {ACCEPT}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act('decline')}>
          {DECLINE}
        </Button>
      </div>
      <p className="text-xs text-text-muted">{acceptNote(update.key)}</p>
      {comparing && (
        <Suspense fallback={null}>
          <SupplyCompare update={update} onClose={() => setComparing(false)} />
        </Suspense>
      )}
    </div>
  );
}
