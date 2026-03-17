import { CalendarDays, CheckSquare, Clock } from 'lucide-react';

interface DaySummaryCardProps {
  date: string;
  tasks: number;
  completed: number;
  events: number;
}

export function DaySummaryCard({ date, tasks, completed, events }: DaySummaryCardProps) {
  const d = new Date(date + 'T00:00:00');
  const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <div className="mb-2 flex items-center gap-2">
        <CalendarDays className="h-4 w-4 text-primary" />
        <span className="text-xs font-medium text-text">{label}</span>
      </div>
      <div className="flex gap-4 text-xs">
        <div className="flex items-center gap-1.5 text-text-secondary">
          <CheckSquare className="h-3.5 w-3.5" />
          <span>
            <span className="font-medium text-text">{completed}</span>/{tasks} tasks
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-text-secondary">
          <Clock className="h-3.5 w-3.5" />
          <span>
            <span className="font-medium text-text">{events}</span> events
          </span>
        </div>
      </div>
      {tasks > 0 && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-hover">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.round((completed / tasks) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
