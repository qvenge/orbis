import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import type { StatusStripMetric } from '@orbis/shared';

export function StatusStrip() {
  const { settings } = useSettingsStore();
  const metrics = (settings?.statusStripMetrics ?? []) as StatusStripMetric[];

  const { data } = trpc.metrics.getMetrics.useQuery(
    { metrics },
    { enabled: metrics.length > 0, staleTime: 60_000 },
  );

  if (metrics.length === 0 || !data) return null;

  const currency = (settings?.defaultCurrency as string) ?? 'RUB';

  function formatValue(value: number, format?: string): string {
    if (format === 'currency') {
      return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
    }
    if (format === 'percent') return `${Math.round(value)}%`;
    return value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  }

  return (
    <div className="flex items-center gap-4 overflow-x-auto border-b border-border px-4 py-1.5 scrollbar-none">
      {metrics.map((metric) => {
        const result = data.find((r) => r.id === metric.id);
        if (!result) return null;

        const trend = result.previousValue !== undefined
          ? result.value > result.previousValue ? 'up'
            : result.value < result.previousValue ? 'down'
              : 'flat'
          : null;

        return (
          <div key={metric.id} className="flex shrink-0 items-center gap-1.5">
            <span className="text-[10px] text-text-muted">{metric.label}</span>
            <span className="text-xs font-semibold text-text">
              {formatValue(result.value, metric.format)}
            </span>
            {trend === 'up' && <TrendingUp className="h-3 w-3 text-success" />}
            {trend === 'down' && <TrendingDown className="h-3 w-3 text-danger" />}
            {trend === 'flat' && <Minus className="h-3 w-3 text-text-muted" />}
          </div>
        );
      })}
    </div>
  );
}
