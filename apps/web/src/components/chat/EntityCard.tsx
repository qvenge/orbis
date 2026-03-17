import { CheckSquare, Calendar, Wallet, Dumbbell, UtensilsCrossed, RotateCw, FileText, Target } from 'lucide-react';
import type { Entity } from '@orbis/shared';

interface EntityCardProps {
  entity: Entity;
  onClick?: () => void;
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'bg-urgent',
  high: 'bg-danger',
  medium: 'bg-warning',
  low: 'bg-success',
  none: 'bg-text-muted',
};

const ASPECT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'orbis/task': CheckSquare,
  'orbis/schedule': Calendar,
  'orbis/financial': Wallet,
  'orbis/fitness': Dumbbell,
  'orbis/nutrition': UtensilsCrossed,
  'orbis/habit': RotateCw,
  'orbis/note': FileText,
  'orbis/goal': Target,
};

export function EntityCard({ entity, onClick }: EntityCardProps) {
  const aspects = entity.aspects as Record<string, Record<string, unknown>>;
  const task = aspects?.['orbis/task'];
  const financial = aspects?.['orbis/financial'];

  const aspectKeys = Object.keys(aspects ?? {});

  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-lg border border-border bg-surface-raised p-3 transition-colors duration-150 hover:border-border-light hover:bg-surface-hover"
    >
      <div className="flex items-start gap-2.5">
        {/* Aspect icon */}
        {aspectKeys.length > 0 && (() => {
          const Icon = ASPECT_ICONS[aspectKeys[0]];
          return Icon ? <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" /> : null;
        })()}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text">{entity.title}</p>

          {/* Task info */}
          {task != null && (
            <div className="mt-1 flex items-center gap-2">
              <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-xs text-text-secondary">
                {String(task.status)}
              </span>
              {task.priority != null && task.priority !== 'none' ? (
                <span
                  className={`inline-block h-2 w-2 rounded-full ${PRIORITY_COLORS[String(task.priority)] ?? ''}`}
                />
              ) : null}
              {task.due_date != null ? (
                <span className="text-xs text-text-muted">{String(task.due_date)}</span>
              ) : null}
            </div>
          )}

          {/* Financial info */}
          {financial != null && (
            <div className="mt-1 text-xs text-text-secondary">
              {financial.direction === 'income' ? '+' : '-'}
              {String(financial.amount)} {String(financial.currency ?? '')}
              {financial.category != null ? (
                <span className="ml-1 text-text-muted">({String(financial.category)})</span>
              ) : null}
            </div>
          )}

          {/* Tags */}
          {entity.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-2">
              {entity.tags.slice(0, 3).map((tag) => (
                <span key={tag} className="text-xs text-text-muted">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
