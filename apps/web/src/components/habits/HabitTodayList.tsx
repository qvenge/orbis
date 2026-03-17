import { RotateCw } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import { HabitRow } from './HabitRow.tsx';

export function HabitTodayList() {
  const { data, isLoading } = trpc.entity.habitsToday.useQuery();

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-light border-t-primary" />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
        <RotateCw className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-muted">No habits yet</p>
        <p className="text-xs text-text-muted">Create one below to start tracking</p>
      </div>
    );
  }

  const completed = data.filter((h) => h.checkedIn).length;

  return (
    <div>
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <p className="text-[10px] font-medium uppercase tracking-wider text-text-muted">Today</p>
        <span className="text-[10px] text-text-muted">
          {completed}/{data.length} done
        </span>
      </div>
      <div className="divide-y divide-border/40">
        {data.map(({ entity, checkedIn, currentStreak }) => (
          <HabitRow
            key={entity.id}
            entity={entity}
            checkedIn={checkedIn}
            currentStreak={currentStreak}
          />
        ))}
      </div>
    </div>
  );
}
