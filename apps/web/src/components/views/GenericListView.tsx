import type { Entity } from '@orbis/shared';

interface GenericListViewProps {
  entities: Entity[];
  aspectId: string;
  columns: string[];
  onEntityClick?: (id: string) => void;
}

export function GenericListView({ entities, aspectId, columns, onEntityClick }: GenericListViewProps) {
  return (
    <div className="divide-y divide-border/40">
      {entities.map((entity) => {
        const aspects = entity.aspects as Record<string, Record<string, unknown>>;
        const data = aspects[aspectId] ?? {};

        return (
          <div
            key={entity.id}
            onClick={() => onEntityClick?.(entity.id)}
            className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover"
          >
            {entity.emoji && <span className="text-sm">{entity.emoji}</span>}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text">{entity.title}</p>
              <div className="mt-0.5 flex gap-3 text-xs text-text-secondary">
                {columns.map((col) => {
                  const val = data[col];
                  if (val == null) return null;
                  return (
                    <span key={col}>
                      <span className="text-text-muted">{col}: </span>
                      {String(val)}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
      {entities.length === 0 && (
        <p className="py-8 text-center text-sm text-text-muted">No entities found</p>
      )}
    </div>
  );
}
