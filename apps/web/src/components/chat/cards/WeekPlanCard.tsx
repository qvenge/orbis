import { Calendar } from 'lucide-react';

interface WeekPlanCardProps {
  days: Array<{ date: string; weekday: string; tasks: number; events: number }>;
}

export function WeekPlanCard({ days }: WeekPlanCardProps) {
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <div className="mb-2 flex items-center gap-2">
        <Calendar className="h-4 w-4 text-primary" />
        <span className="text-xs font-medium text-text">Week Plan</span>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px]">
        {days.map((d) => {
          const isToday = d.date === today;
          return (
            <div
              key={d.date}
              className={`rounded-md px-1 py-1.5 ${isToday ? 'bg-primary/15 text-primary' : 'text-text-secondary'}`}
            >
              <div className="font-medium">{d.weekday}</div>
              <div className="mt-0.5 text-[9px]">
                {d.tasks > 0 && <span>{d.tasks}t</span>}
                {d.tasks > 0 && d.events > 0 && <span> </span>}
                {d.events > 0 && <span>{d.events}e</span>}
                {d.tasks === 0 && d.events === 0 && <span className="text-text-muted">—</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
