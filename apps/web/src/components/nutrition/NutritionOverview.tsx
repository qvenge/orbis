import { UtensilsCrossed } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import { MiniBarChart } from '../common/MiniBarChart.tsx';
import { DonutChart } from '../common/DonutChart.tsx';

interface NutritionOverviewProps {
  year: number;
  month: number;
}

export function NutritionOverview({ year, month }: NutritionOverviewProps) {
  const { data, isLoading } = trpc.entity.nutritionSummary.useQuery({ year, month });

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-light border-t-primary" />
      </div>
    );
  }

  if (!data || data.totalMeals === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
        <UtensilsCrossed className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-muted">No meals logged this month</p>
        <p className="text-xs text-text-muted">Use the quick log below to add one</p>
      </div>
    );
  }

  const calorieBars = data.dailyTotals.map((day) => ({
    label: String(new Date(day.date).getDate()),
    value: day.calories,
  }));

  const macroSegments = [
    { label: 'Protein', value: data.dailyAvgProtein, color: 'var(--color-success)' },
    { label: 'Carbs', value: data.dailyAvgCarbs, color: 'var(--color-warning)' },
    { label: 'Fat', value: data.dailyAvgFat, color: 'var(--color-danger)' },
  ];

  return (
    <div className="space-y-4 p-4">
      {/* Macro Averages */}
      <div className="rounded-lg border border-border bg-surface-dim p-3">
        <p className="mb-3 text-[10px] font-medium uppercase tracking-wider text-text-muted">
          Daily Averages
        </p>
        <div className="grid grid-cols-4 gap-3 text-center">
          <div>
            <p className="text-lg font-bold text-text">{data.dailyAvgCalories}</p>
            <p className="text-[10px] text-text-muted">kcal</p>
          </div>
          <div>
            <p className="text-lg font-bold text-success">{data.dailyAvgProtein}g</p>
            <p className="text-[10px] text-text-muted">Protein</p>
          </div>
          <div>
            <p className="text-lg font-bold text-warning">{data.dailyAvgCarbs}g</p>
            <p className="text-[10px] text-text-muted">Carbs</p>
          </div>
          <div>
            <p className="text-lg font-bold text-danger">{data.dailyAvgFat}g</p>
            <p className="text-[10px] text-text-muted">Fat</p>
          </div>
        </div>
      </div>

      {/* Charts row — macro donut + daily calories */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Macro split donut */}
        <div className="rounded-lg border border-border bg-surface-dim p-3">
          <p className="mb-3 text-[10px] font-medium uppercase tracking-wider text-text-muted">
            Macro Split (avg/day)
          </p>
          <div className="flex justify-center">
            <DonutChart
              segments={macroSegments}
              size={110}
              strokeWidth={12}
              formatTotal={(v) => `${v}g`}
            />
          </div>
        </div>

        {/* Daily Calorie Bar Chart */}
        {calorieBars.length > 0 && (
          <div className="rounded-lg border border-border bg-surface-dim p-3">
            <p className="mb-3 text-[10px] font-medium uppercase tracking-wider text-text-muted">
              Daily Calories
            </p>
            <MiniBarChart
              data={calorieBars}
              color="var(--color-primary)"
              height={130}
              formatValue={(v) => `${v} kcal`}
            />
          </div>
        )}
      </div>

      {/* Meal Stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border bg-surface-dim p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-text-muted">Total Meals</p>
          <p className="mt-1 text-xl font-bold text-text">{data.totalMeals}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface-dim p-3">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">By Type</p>
          <div className="flex flex-wrap gap-1">
            {data.mealTypeBreakdown.map(({ type, count }) => (
              <span
                key={type}
                className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] capitalize text-primary"
              >
                {type} {count}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
