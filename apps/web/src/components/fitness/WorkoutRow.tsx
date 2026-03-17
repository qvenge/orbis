import { useNavigationStore } from '../../stores/navigation.ts';

interface WorkoutRowProps {
  entity: {
    id: string;
    title: string;
    createdAt: Date | string;
    aspects?: unknown;
  };
}

function formatDate(date: Date | string): string {
  const d = new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

export function WorkoutRow({ entity }: WorkoutRowProps) {
  const { openEntity } = useNavigationStore();
  const aspects = entity.aspects as Record<string, Record<string, unknown>> | undefined;
  const fit = aspects?.['orbis/fitness'];

  if (!fit) return null;

  const workoutType = String(fit.workout_type ?? 'workout');
  const duration = typeof fit.duration_min === 'number' ? fit.duration_min : null;
  const effort = typeof fit.perceived_effort === 'number' ? fit.perceived_effort : null;
  const volume = typeof fit.total_volume_kg === 'number' ? fit.total_volume_kg : null;

  return (
    <button
      onClick={() => openEntity(entity.id)}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-surface-hover"
    >
      {/* Date */}
      <span className="w-16 shrink-0 text-xs text-text-muted">
        {formatDate(entity.createdAt)}
      </span>

      {/* Title + Type */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-text">{entity.title}</span>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] capitalize text-primary w-fit">
          {workoutType}
        </span>
      </div>

      {/* Stats */}
      <div className="flex shrink-0 items-center gap-3 text-xs text-text-secondary">
        {duration && <span>{duration}m</span>}
        {volume != null && volume > 0 && <span>{volume.toLocaleString()}kg</span>}
        {effort && (
          <span className={effort >= 8 ? 'text-danger' : effort >= 5 ? 'text-warning' : 'text-success'}>
            RPE {effort}
          </span>
        )}
      </div>
    </button>
  );
}
