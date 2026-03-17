import { useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { Entity } from '@orbis/shared';

interface GenericTableViewProps {
  entities: Entity[];
  aspectId: string;
  columns: string[];
  onEntityClick?: (id: string) => void;
}

export function GenericTableView({ entities, aspectId, columns, onEntityClick }: GenericTableViewProps) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  const sorted = [...entities].sort((a, b) => {
    if (!sortCol) return 0;
    const aAspects = a.aspects as Record<string, Record<string, unknown>>;
    const bAspects = b.aspects as Record<string, Record<string, unknown>>;
    const aVal = aAspects[aspectId]?.[sortCol];
    const bVal = bAspects[aspectId]?.[sortCol];
    const aStr = String(aVal ?? '');
    const bStr = String(bVal ?? '');
    const cmp = aStr.localeCompare(bStr, undefined, { numeric: true });
    return sortDir === 'asc' ? cmp : -cmp;
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left font-medium text-text-muted">Title</th>
            {columns.map((col) => (
              <th
                key={col}
                onClick={() => handleSort(col)}
                className="cursor-pointer px-3 py-2 text-left font-medium text-text-muted hover:text-text"
              >
                <span className="flex items-center gap-1">
                  {col}
                  {sortCol === col && (
                    sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((entity) => {
            const aspects = entity.aspects as Record<string, Record<string, unknown>>;
            const data = aspects[aspectId] ?? {};
            return (
              <tr
                key={entity.id}
                onClick={() => onEntityClick?.(entity.id)}
                className="cursor-pointer border-b border-border/40 transition-colors hover:bg-surface-hover"
              >
                <td className="px-3 py-2 text-text">
                  {entity.emoji && <span className="mr-1.5">{entity.emoji}</span>}
                  {entity.title}
                </td>
                {columns.map((col) => (
                  <td key={col} className="px-3 py-2 text-text-secondary">
                    {data[col] != null ? String(data[col]) : '—'}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {entities.length === 0 && (
        <p className="py-8 text-center text-sm text-text-muted">No entities found</p>
      )}
    </div>
  );
}
