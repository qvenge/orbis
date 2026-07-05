import { useNav } from '../../state/navigation';
import { Button } from '../../ui/Button';
import { useEntities } from './useEntities';

export function EntityList({ filters = '' }: { filters?: string }) {
  const { entities, hasMore, loadMore, isLoading } = useEntities(filters);
  const push = useNav((s) => s.push);
  if (isLoading)
    return (
      <div role="status" className="p-4 text-sm text-text-muted">
        Загрузка…
      </div>
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
