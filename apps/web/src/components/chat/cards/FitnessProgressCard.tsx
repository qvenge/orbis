import { Dumbbell } from 'lucide-react';

interface FitnessProgressCardProps {
  period: string;
  workouts: number;
  totalVolume: number;
  totalDuration: number;
  avgEffort: number;
}

export function FitnessProgressCard({ period, workouts, totalVolume, totalDuration, avgEffort }: FitnessProgressCardProps) {
  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <div className="mb-2 flex items-center gap-2">
        <Dumbbell className="h-4 w-4 text-primary" />
        <span className="text-xs font-medium text-text">Fitness — {period}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-text-muted">Workouts</span>
          <p className="font-medium text-text">{workouts}</p>
        </div>
        <div>
          <span className="text-text-muted">Volume</span>
          <p className="font-medium text-text">{totalVolume.toLocaleString()} kg</p>
        </div>
        <div>
          <span className="text-text-muted">Duration</span>
          <p className="font-medium text-text">{totalDuration} min</p>
        </div>
        <div>
          <span className="text-text-muted">Avg Effort</span>
          <p className={`font-medium ${avgEffort >= 8 ? 'text-danger' : avgEffort >= 5 ? 'text-warning' : 'text-success'}`}>
            {avgEffort.toFixed(1)}/10
          </p>
        </div>
      </div>
    </div>
  );
}
