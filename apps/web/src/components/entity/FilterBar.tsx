import { Search, ChevronDown } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';

export function FilterBar() {
  const { filters, setFilters } = useNavigationStore();

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface-dim px-3">
      {/* Search */}
      <div className="relative flex-1">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
        <input
          type="text"
          placeholder="Search..."
          value={filters.search ?? ''}
          onChange={(e) => setFilters({ search: e.target.value || undefined })}
          className="h-7 w-full rounded-md bg-transparent pl-8 pr-3 text-sm text-text placeholder:text-text-muted focus:bg-surface-hover focus:outline-none"
        />
      </div>

      {/* Sort */}
      <div className="relative">
        <select
          value={`${filters.sortBy}:${filters.sortOrder}`}
          onChange={(e) => {
            const [sortBy, sortOrder] = e.target.value.split(':') as [typeof filters.sortBy, typeof filters.sortOrder];
            setFilters({ sortBy, sortOrder });
          }}
          className="h-7 appearance-none rounded-md bg-transparent pr-6 pl-2 text-xs text-text-secondary transition-colors duration-150 hover:text-text focus:outline-none"
        >
          <option value="updated_at:desc">Recent</option>
          <option value="created_at:desc">Newest</option>
          <option value="created_at:asc">Oldest</option>
          <option value="title:asc">A-Z</option>
        </select>
        <ChevronDown className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" />
      </div>
    </div>
  );
}
