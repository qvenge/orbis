import { trpc } from '../../lib/trpc.ts';
import { MiniLineChart } from '../common/MiniLineChart.tsx';

export function HabitHistory() {
  const { data, isLoading } = trpc.entity.habitsHistory.useQuery({ days: 30 });

  if (isLoading || !data || data.habits.length === 0) return null;

  // Compute overall completion rate
  let totalCells = 0;
  let completedCells = 0;
  for (const habit of data.habits) {
    for (const ci of habit.checkIns) {
      totalCells++;
      if (ci.completed) completedCells++;
    }
  }
  const completionRate = totalCells > 0 ? Math.round((completedCells / totalCells) * 100) : 0;

  // Compute daily completion rate for trend line
  const dailyRates: Array<{ label: string; value: number }> = [];
  if (data.dates.length > 0 && data.habits.length > 0) {
    for (let i = 0; i < data.dates.length; i++) {
      let done = 0;
      let total = 0;
      for (const habit of data.habits) {
        if (habit.checkIns[i]) {
          total++;
          if (habit.checkIns[i].completed) done++;
        }
      }
      // Show every 5th label to avoid crowding
      const day = new Date(data.dates[i] + 'T00:00:00').getDate();
      dailyRates.push({
        label: i % 5 === 0 || i === data.dates.length - 1 ? String(day) : '',
        value: total > 0 ? Math.round((done / total) * 100) : 0,
      });
    }
  }

  // Heatmap color intensity based on per-habit completion
  function cellColor(completed: boolean, _date: string): string {
    return completed
      ? 'bg-success/80 hover:bg-success'
      : 'bg-surface-hover hover:bg-surface-hover/80';
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between pb-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
          Last 30 Days
        </p>
        <span className="text-[10px] text-text-muted">{completionRate}% completion</span>
      </div>

      {/* Heatmap grid */}
      <div className="overflow-x-auto rounded-lg border border-border bg-surface-dim p-2">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="w-20" />
              {data.dates.map((date, i) => {
                const day = new Date(date + 'T00:00:00').getDate();
                const show = i === 0 || i === data.dates.length - 1 || i % 5 === 0;
                return (
                  <th key={date} className="px-0 py-0.5 text-center">
                    <span className="text-[7px] text-text-muted">
                      {show ? day : ''}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data.habits.map((habit) => (
              <tr key={habit.entity.id}>
                <td className="max-w-[80px] truncate pr-2 py-0.5 text-[10px] text-text-secondary">
                  {habit.entity.emoji ? `${habit.entity.emoji} ` : ''}{habit.entity.title}
                </td>
                {habit.checkIns.map((ci) => (
                  <td key={ci.date} className="px-0 py-0.5 text-center">
                    <div
                      className={`mx-auto h-2.5 w-2.5 rounded-sm transition-colors duration-150 ${cellColor(ci.completed, ci.date)}`}
                      title={`${ci.date}: ${ci.completed ? 'Done' : 'Missed'}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Completion rate trend */}
      {dailyRates.length >= 2 && (
        <div className="mt-4 rounded-lg border border-border bg-surface-dim p-3">
          <p className="mb-3 text-[10px] font-medium uppercase tracking-wider text-text-muted">
            Completion Trend
          </p>
          <MiniLineChart
            data={dailyRates}
            color="var(--color-success)"
            height={80}
            formatValue={(v) => `${v}%`}
          />
        </div>
      )}
    </div>
  );
}
