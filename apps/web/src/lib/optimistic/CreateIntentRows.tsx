import { Button, buttonClassName } from '../../ui/Button';
import { RecordLink } from '../entity-ref/RecordLink';
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
  return (
    <>
      {rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-2 px-2 py-1 text-sm">
              <RecordLink id={row.id} className={buttonClassName('ghost')}>
                {row.status === 'ack' ? row.result.title : row.title}
              </RecordLink>
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
