import { RotateCw, Flame, Check } from 'lucide-react';

interface HabitStreaksCardProps {
  habits: Array<{ name: string; emoji: string | null; streak: number; checkedInToday: boolean }>;
}

export function HabitStreaksCard({ habits }: HabitStreaksCardProps) {
  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <div className="mb-2 flex items-center gap-2">
        <RotateCw className="h-4 w-4 text-primary" />
        <span className="text-xs font-medium text-text">Habit Streaks</span>
      </div>
      <div className="space-y-1.5">
        {habits.map((h) => (
          <div key={h.name} className="flex items-center gap-2 text-xs">
            <span className="w-4 text-center">{h.emoji ?? '·'}</span>
            <span className="min-w-0 flex-1 truncate text-text-secondary">{h.name}</span>
            {h.streak > 0 && (
              <span className="flex items-center gap-0.5 text-warning">
                <Flame className="h-3 w-3" />
                {h.streak}
              </span>
            )}
            {h.checkedInToday ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <span className="h-3.5 w-3.5 rounded-full border border-border-light" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
