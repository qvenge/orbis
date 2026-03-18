import { memo } from 'react';
import { Check, CheckSquare, Calendar, Wallet, Dumbbell, UtensilsCrossed, RotateCw, FileText, Target, Cog } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import type { Entity } from '@orbis/shared';

interface EntityRowProps {
  entity: Entity;
  onClick: () => void;
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'border-urgent',
  high: 'border-danger',
  medium: 'border-warning',
  low: 'border-success',
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

export const EntityRow = memo(function EntityRow({ entity, onClick }: EntityRowProps) {
  const utils = trpc.useUtils();
  const updateEntity = trpc.entity.update.useMutation({
    onSuccess: () => utils.entity.list.invalidate(),
  });

  const aspects = entity.aspects as Record<string, Record<string, unknown>>;
  const task = aspects?.['orbis/task'];
  const isDone = task?.status === 'done';
  const priority = (task?.priority as string) ?? 'none';

  const toggleDone = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!task) return;

    const newStatus = isDone ? 'inbox' : 'done';
    const newAspects = {
      ...aspects,
      'orbis/task': {
        ...task,
        status: newStatus,
        ...(newStatus === 'done' ? { completed_at: new Date().toISOString() } : { completed_at: undefined }),
      },
    };

    updateEntity.mutate({
      id: entity.id,
      aspects: newAspects,
    });
  };

  const aspectKeys = Object.keys(aspects ?? {}).filter((k) => k !== 'orbis/task');

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-surface-hover ${isDone ? 'opacity-60' : ''}`}
    >
      {/* Task checkbox - circular */}
      {task != null ? (
        <button
          onClick={toggleDone}
          className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors duration-150 ${
            isDone
              ? 'border-success bg-success text-white'
              : PRIORITY_COLORS[priority] ?? 'border-border-light'
          }`}
        >
          {isDone && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
        </button>
      ) : (
        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
          <span className="h-1.5 w-1.5 rounded-full bg-text-muted" />
        </span>
      )}

      {/* Content */}
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm ${isDone ? 'text-text-muted line-through' : 'text-text'}`}>
          {entity.title}
        </p>
        <div className="mt-0.5 flex items-center gap-2">
          {/* Tags */}
          {entity.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="text-xs text-text-muted">#{tag}</span>
          ))}
          {/* Aspect icons */}
          {aspectKeys.slice(0, 3).map((key) => {
            const Icon = ASPECT_ICONS[key] ?? Cog;
            return <Icon key={key} className="h-3 w-3 text-text-muted" />;
          })}
        </div>
      </div>

      {/* Due date */}
      {task?.due_date != null ? (
        <span className={`shrink-0 text-xs ${isOverdue(String(task.due_date)) && !isDone ? 'font-medium text-danger' : 'text-text-muted'}`}>
          {formatDate(String(task.due_date))}
        </span>
      ) : null}
    </button>
  );
});

function isOverdue(dateStr: string): boolean {
  return new Date(dateStr) < new Date(new Date().toDateString());
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
