import { Inbox } from 'lucide-react';
import { useNav } from '../../state/navigation';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { EntityRow } from './EntityRow';
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
      {/* Без разделительных линий (Notion): строка — скруглённый hover-ряд. */}
      <ul className="flex flex-col gap-px px-1">
        {entities.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              data-testid="entity-row"
              onClick={() => push('browser', { kind: 'entity', id: e.id })}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <EntityRow entity={e} />
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
