import type { Entity } from '@orbis/shared';
import { MiniBarChart } from '../common/MiniBarChart.tsx';
import { MiniLineChart } from '../common/MiniLineChart.tsx';

interface GenericChartViewProps {
  entities: Entity[];
  aspectId: string;
  chartConfig: {
    xField: string;
    yField: string;
    type: 'bar' | 'line';
  };
}

export function GenericChartView({ entities, aspectId, chartConfig }: GenericChartViewProps) {
  const chartData = entities
    .map((e) => {
      const aspects = e.aspects as Record<string, Record<string, unknown>>;
      const data = aspects[aspectId];
      if (!data) return null;
      return {
        label: String(data[chartConfig.xField] ?? e.title),
        value: Number(data[chartConfig.yField]) || 0,
      };
    })
    .filter(Boolean) as Array<{ label: string; value: number }>;

  if (chartData.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center">
        <p className="text-sm text-text-muted">No data to chart</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="rounded-lg border border-border bg-surface-dim p-4">
        {chartConfig.type === 'line' ? (
          <MiniLineChart data={chartData} height={200} />
        ) : (
          <MiniBarChart data={chartData} height={200} />
        )}
      </div>
    </div>
  );
}
