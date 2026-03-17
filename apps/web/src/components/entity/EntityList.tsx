import { Inbox } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import { useNavigationStore } from '../../stores/navigation.ts';
import { EntityRow } from './EntityRow.tsx';
import { FilterBar } from './FilterBar.tsx';
import { QuickCapture } from './QuickCapture.tsx';

export function EntityList() {
  const { filters, openEntity } = useNavigationStore();

  const { data, isLoading } = trpc.entity.list.useQuery({
    tags: filters.tags,
    aspects: filters.aspects,
    search: filters.search,
    archived: filters.archived,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
  });

  return (
    <div className="flex h-full flex-col">
      <FilterBar />

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-light border-t-primary" />
          </div>
        ) : !data?.items.length ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <Inbox className="mx-auto h-10 w-10 text-text-muted" strokeWidth={1.5} />
              <p className="mt-3 text-sm text-text-secondary">No entities yet</p>
              <p className="mt-1 text-xs text-text-muted">
                Ask Orbis to create something
              </p>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {data.items.map((entity) => (
              <EntityRow
                key={entity.id}
                entity={entity as any}
                onClick={() => openEntity(entity.id)}
              />
            ))}
          </div>
        )}
      </div>

      <QuickCapture />
    </div>
  );
}
