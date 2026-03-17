import { Dumbbell, Clock, Flame, TrendingUp } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import { MiniBarChart } from '../common/MiniBarChart.tsx';
import { MiniLineChart } from '../common/MiniLineChart.tsx';

interface FitnessOverviewProps {
  year: number;
  month: number;
}

export function FitnessOverview({ year, month }: FitnessOverviewProps) {
  const { data, isLoading } = trpc.entity.fitnessSummary.useQuery({ year, month });

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-light border-t-primary" />
      </div>
    );
  }

  if (!data || data.totalWorkouts === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
        <Dumbbell className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-muted">No workouts this month</p>
        <p className="text-xs text-text-muted">Use the quick log below to add one</p>
      </div>
    );
  }

  const volumeBars = data.weeklyVolume.map((vol, i) => ({
    label: `W${i + 1}`,
    value: vol,
  }));

  const effortPoints = (data.effortTrend ?? []).map((e) => ({
    label: String(new Date(e.date).getDate()),
    value: e.effort,
  }));

  return (
    <div className="space-y-4 p-4">
      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border bg-surface-dim p-3">
          <div className="flex items-center gap-2 text-text-muted">
            <Dumbbell className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wider">Workouts</span>
          </div>
          <p className="mt-1 text-xl font-bold text-text">{data.totalWorkouts}</p>
        </div>

        <div className="rounded-lg border border-border bg-surface-dim p-3">
          <div className="flex items-center gap-2 text-text-muted">
            <TrendingUp className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wider">Volume</span>
          </div>
          <p className="mt-1 text-xl font-bold text-text">
            {data.totalVolume.toLocaleString()} <span className="text-xs font-normal text-text-muted">kg</span>
          </p>
        </div>

        <div className="rounded-lg border border-border bg-surface-dim p-3">
          <div className="flex items-center gap-2 text-text-muted">
            <Clock className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wider">Duration</span>
          </div>
          <p className="mt-1 text-xl font-bold text-text">
            {data.totalDuration} <span className="text-xs font-normal text-text-muted">min</span>
          </p>
        </div>

        <div className="rounded-lg border border-border bg-surface-dim p-3">
          <div className="flex items-center gap-2 text-text-muted">
            <Flame className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wider">Avg Effort</span>
          </div>
          <p className="mt-1 text-xl font-bold text-text">
            {data.avgEffort} <span className="text-xs font-normal text-text-muted">/10</span>
          </p>
        </div>
      </div>

      {/* Workout Type Breakdown */}
      {data.workoutTypeBreakdown.length > 0 && (
        <div className="rounded-lg border border-border bg-surface-dim p-3">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">
            By Type
          </p>
          <div className="flex flex-wrap gap-2">
            {data.workoutTypeBreakdown.map(({ type, count }) => (
              <span
                key={type}
                className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs capitalize text-primary"
              >
                {type} &middot; {count}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Charts row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Weekly Volume */}
        <div className="rounded-lg border border-border bg-surface-dim p-3">
          <p className="mb-3 text-[10px] font-medium uppercase tracking-wider text-text-muted">
            Weekly Volume (kg)
          </p>
          <MiniBarChart
            data={volumeBars}
            color="var(--color-primary)"
            height={100}
            formatValue={(v) => `${v.toLocaleString()} kg`}
          />
        </div>

        {/* Effort Trend */}
        {effortPoints.length >= 2 && (
          <div className="rounded-lg border border-border bg-surface-dim p-3">
            <p className="mb-3 text-[10px] font-medium uppercase tracking-wider text-text-muted">
              Effort Trend
            </p>
            <MiniLineChart
              data={effortPoints}
              color="var(--color-warning)"
              height={100}
              formatValue={(v) => `${v}/10`}
            />
          </div>
        )}
      </div>
    </div>
  );
}
