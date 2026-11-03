import { useOpenRecord } from '../../app/useOpenRecord';
import { useNav } from '../../state/navigation';
import { Button } from '../../ui/Button';
import type { CreateIntent } from './create-intents';

export function CreateIntentRows({
  rows,
  unresolved,
  rejected,
  retry,
}: {
  rows: readonly CreateIntent[];
  unresolved?: CreateIntent;
  rejected?: CreateIntent;
  retry: (id: string) => void;
}) {
  const openRecord = useOpenRecord();
  return (
    <>
      {rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-2 px-2 py-1 text-sm">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  if (row.status === 'ack') openRecord(row.id);
                  else useNav.getState().openPendingCreate(row.id);
                }}
              >
                {row.status === 'ack' ? row.result.title : row.title}
              </Button>
              {row.status === 'pending' && <span role="status">Создаётся…</span>}
              {row.status === 'unknown' && <span>Сохранение не подтверждено</span>}
            </li>
          ))}
        </ul>
      )}
      {rejected?.status === 'rejected' && (
        <p role="alert" className="text-sm text-danger">
          {rejected.message}
        </p>
      )}
      {unresolved?.status === 'unknown' && (
        <div role="alert" className="space-y-2 text-sm text-danger">
          <p>
            {unresolved.message} «{unresolved.title}»
          </p>
          <Button type="button" variant="outline" onClick={() => retry(unresolved.id)}>
            Повторить сохранение
          </Button>
        </div>
      )}
    </>
  );
}
