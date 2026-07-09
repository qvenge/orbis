import { Inbox } from 'lucide-react';
import { useNav } from '../../state/navigation';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { useEntities } from './useEntities';

export function EntityList({ filters = '' }: { filters?: string }) {
  const { entities, hasMore, loadMore, isLoading } = useEntities(filters);
  const push = useNav((s) => s.push);
  if (isLoading)
    return (
      <div className="flex flex-col gap-2 p-3">
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: статичные placeholder-ряды
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  if (entities.length === 0)
    return (
      <EmptyState
        icon={<Inbox size={32} aria-hidden />}
        title="Здесь появятся ваши записи"
        hint="Добавьте первую через быструю запись ниже"
      />
    );
  return (
    <div className="flex flex-col">
      <ul className="flex flex-col divide-y divide-line">
        {entities.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              data-testid="entity-row"
              onClick={() => push('browser', { kind: 'entity', id: e.id })}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2"
            >
              {e.emoji && <span aria-hidden>{e.emoji}</span>}
              <span className="flex-1 truncate">{e.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {hasMore && (
        <Button variant="ghost" onClick={loadMore} className="m-2 self-center">
          Показать ещё
        </Button>
      )}
    </div>
  );
}
