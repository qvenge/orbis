import { CheckSquare, Calendar, Wallet } from 'lucide-react';
import type { QueryBlockParams } from '@orbis/shared';
import { trpc } from '../../lib/trpc.ts';
import { useNavigationStore } from '../../stores/navigation.ts';

interface QueryBlockRendererProps {
  params: QueryBlockParams;
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'bg-urgent',
  high: 'bg-danger',
  medium: 'bg-warning',
  low: 'bg-success',
  none: 'bg-text-muted',
};

export function QueryBlockRenderer({ params }: QueryBlockRendererProps) {
  const { openEntity } = useNavigationStore();

  const { data, isLoading, isError, error } = trpc.entity.queryBlock.useQuery(params, {
    staleTime: 30_000,
    retry: 1,
  });

  if (isError) {
    return (
      <div className="my-2 rounded-lg border border-danger/30 bg-danger/5 p-3">
        {params.title && (
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
            {params.title}
          </p>
        )}
        <p className="text-xs text-danger">Query error: {error?.message ?? 'Unknown error'}</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="my-2 rounded-lg border border-border bg-surface-dim p-3">
        {params.title && (
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
            {params.title}
          </p>
        )}
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <div className="h-3 w-3 animate-spin rounded-full border border-border-light border-t-primary" />
          Loading...
        </div>
      </div>
    );
  }

  if (!data?.items.length) {
    return (
      <div className="my-2 rounded-lg border border-border bg-surface-dim p-3">
        {params.title && (
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
            {params.title}
          </p>
        )}
        <p className="text-xs text-text-muted">No matching entities</p>
      </div>
    );
  }

  const display = data.display ?? 'list';

  return (
    <div className="my-2 rounded-lg border border-border bg-surface-dim p-3">
      {data.title && (
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
          {data.title} <span className="text-text-muted">({data.items.length})</span>
        </p>
      )}

      {display === 'compact' ? (
        <CompactList items={data.items} onNavigate={openEntity} />
      ) : display === 'table' ? (
        <TableView items={data.items} aspect={params.aspect} onNavigate={openEntity} />
      ) : (
        <ListView items={data.items} onNavigate={openEntity} />
      )}
    </div>
  );
}

interface EntityItem {
  id: string;
  title: string;
  emoji: string | null;
  tags: string[];
  aspects?: unknown;
}

function CompactList({ items, onNavigate }: { items: EntityItem[]; onNavigate: (id: string) => void }) {
  return (
    <div className="space-y-0.5">
      {items.map((entity) => {
        const aspects = entity.aspects as Record<string, Record<string, unknown>>;
        const task = aspects?.['orbis/task'];

        return (
          <button
            key={entity.id}
            onClick={() => onNavigate(entity.id)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors duration-150 hover:bg-surface-hover"
          >
            {task?.priority != null && String(task.priority) !== 'none' && (
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${PRIORITY_COLORS[String(task.priority)] ?? ''}`} />
            )}
            <span className="flex-1 truncate text-text">{entity.title}</span>
            {task?.due_date != null && (
              <span className="shrink-0 text-[10px] text-text-muted">{String(task.due_date)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ListView({ items, onNavigate }: { items: EntityItem[]; onNavigate: (id: string) => void }) {
  return (
    <div className="space-y-1">
      {items.map((entity) => {
        const aspects = entity.aspects as Record<string, Record<string, unknown>>;
        const task = aspects?.['orbis/task'];
        const schedule = aspects?.['orbis/schedule'];
        const financial = aspects?.['orbis/financial'];
        const isDone = task?.status === 'done';

        return (
          <button
            key={entity.id}
            onClick={() => onNavigate(entity.id)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-hover"
          >
            {/* Aspect icon */}
            {task != null ? (
              <CheckSquare className={`h-3.5 w-3.5 shrink-0 ${isDone ? 'text-success' : 'text-text-muted'}`} />
            ) : schedule != null ? (
              <Calendar className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            ) : financial != null ? (
              <Wallet className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            ) : null}

            {/* Title */}
            <span className={`flex-1 truncate text-sm ${isDone ? 'text-text-muted line-through' : 'text-text'}`}>
              {entity.title}
            </span>

            {/* Task meta */}
            {task != null && (
              <div className="flex shrink-0 items-center gap-1.5">
                {task.priority != null && String(task.priority) !== 'none' && (
                  <span className={`inline-block h-2 w-2 rounded-full ${PRIORITY_COLORS[String(task.priority)] ?? ''}`} />
                )}
                <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-[10px] text-text-secondary">
                  {String(task.status)}
                </span>
                {task.due_date != null && (
                  <span className="text-[10px] text-text-muted">{String(task.due_date)}</span>
                )}
              </div>
            )}

            {/* Financial meta */}
            {financial != null && (
              <span className="shrink-0 text-xs text-text-secondary">
                {financial.direction === 'income' ? '+' : '-'}{String(financial.amount)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function TableView({
  items,
  aspect,
  onNavigate,
}: {
  items: EntityItem[];
  aspect?: string;
  onNavigate: (id: string) => void;
}) {
  // Collect all aspect fields from items
  const fields = new Set<string>();
  for (const item of items) {
    const aspects = item.aspects as Record<string, Record<string, unknown>>;
    const data = aspect ? aspects[aspect] : null;
    if (data) {
      for (const key of Object.keys(data)) {
        fields.add(key);
      }
    }
  }

  const fieldList = Array.from(fields).slice(0, 5);

  return (
    <table className="w-full text-xs">
      <thead>
        <tr>
          <th className="px-2 py-1 text-left font-medium text-text-muted">Title</th>
          {fieldList.map((f) => (
            <th key={f} className="px-2 py-1 text-left font-medium text-text-muted">{f}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((entity) => {
          const aspects = entity.aspects as Record<string, Record<string, unknown>>;
          const data = aspect ? aspects[aspect] : null;
          return (
            <tr
              key={entity.id}
              onClick={() => onNavigate(entity.id)}
              className="cursor-pointer transition-colors duration-150 hover:bg-surface-hover"
            >
              <td className="px-2 py-1 text-text">{entity.title}</td>
              {fieldList.map((f) => (
                <td key={f} className="px-2 py-1 text-text-secondary">
                  {data ? String(data[f] ?? '') : ''}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
